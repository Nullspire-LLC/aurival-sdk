/**
 * The key file, first-run pairing, assertion signing, access-token exchange.
 *
 * SDK-33: the seed lives in exactly one object (`MachineKey`) and never leaves
 * it — not a property anywhere else, not a local in dispatch, not in a log line
 * or thrown message. Node's `KeyObject` keeps the bytes out of reach; the only
 * path the b64 seed travels is `KeyFile.load` -> `MachineKey.fromSeedB64`
 * (decoded immediately) and `MachineKey.seedB64ForSave` -> `KeyFile.save`
 * (encoded only at the moment of writing).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { inspect } from 'node:util';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as errors from './errors.js';
import type { HttpClient, Logger } from './http.js';

// Re-exported, not redefined: bot.ts compares the resolved host against http's
// copy, and two spellings of one default drift silently.
export { DEFAULT_HOST } from './http.js';
import { DEFAULT_HOST, defaultLogger } from './http.js';

// token.go: AssertionMaxAge. auth owns 60s of refresh headroom ahead of a
// 15-minute access-token TTL (SDK-37).
const ASSERTION_MAX_AGE_S = 120;
// Exported so socket.ts's proactive rotation timer (SDK bot-api-curation) can
// reuse the exact same headroom rather than drifting its own copy.
export const TOKEN_REFRESH_HEADROOM_MS = 60_000;
const DEFAULT_PAIR_RETRY_AFTER_MS = 60_000;

// botapi.go:158 — a custom base32 alphabet, no padding. Not RFC 4648.
const B32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function b32encodeNopad(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      const index = (value >>> (bits - 5)) & 0x1f;
      out += B32_ALPHABET.charAt(index);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET.charAt((value << (5 - bits)) & 0x1f);
  }
  return out;
}

function fingerprintOf(canonicalB64: string): string {
  // botapi.go:206 — hashes the canonical base64 STRING, not the raw bytes.
  const digest = createHash('sha256').update(Buffer.from(canonicalB64, 'ascii')).digest();
  const s = b32encodeNopad(digest).slice(0, 8);
  return (s.slice(0, 4) + '-' + s.slice(4)).toUpperCase();
}

function b64urlNopad(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

function parseRfc3339(s: string): number {
  // time.RFC3339 in Go always has a "Z" or numeric offset; `Date.parse`
  // handles both natively, unlike Python's fromisoformat quirk with "Z".
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new errors.ProtocolError(`expires_at was not a valid RFC3339 timestamp: ${s}`);
  }
  return ms;
}

// RFC 8410 PKCS8 wrapper for a raw 32-byte Ed25519 private key (the seed).
// Node has no "import raw Ed25519 private bytes" API; this DER prefix plus
// the seed is the whole PKCS8 document, and Node/OpenSSL derives the public
// key from it lazily — no `x` (public) component needs to be supplied.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

const SEED_LENGTH = 32;

/** The ONLY object that holds the seed (SDK-33). */
export class MachineKey {
  readonly #privateKey: KeyObject;

  private constructor(privateKey: KeyObject) {
    this.#privateKey = privateKey;
  }

  static generate(): MachineKey {
    const { privateKey } = generateKeyPairSync('ed25519');
    return new MachineKey(privateKey);
  }

  static fromSeedB64(seedB64: string): MachineKey {
    const seed = Buffer.from(seedB64, 'base64');
    if (seed.length !== SEED_LENGTH) {
      throw new errors.ProtocolError(
        `ed25519 seed must be ${SEED_LENGTH} bytes, got ${seed.length}`,
      );
    }
    return new MachineKey(privateKeyFromSeed(seed));
  }

  sign(payload: Uint8Array): Uint8Array {
    return cryptoSign(null, Buffer.from(payload), this.#privateKey);
  }

  get publicKeyB64(): string {
    const jwk = createPublicKey(this.#privateKey).export({ format: 'jwk' });
    return Buffer.from(jwk.x as string, 'base64url').toString('base64');
  }

  get fingerprint(): string {
    return fingerprintOf(this.publicKeyB64);
  }

  /** The seed's one legitimate exit. Called ONLY by `KeyFile.save`. */
  seedB64ForSave(): string {
    const jwk = this.#privateKey.export({ format: 'jwk' });
    return Buffer.from(jwk.d as string, 'base64url').toString('base64');
  }

  toString(): string {
    return `<MachineKey fingerprint=${this.fingerprint}>`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** machine.json minus the seed. Safe to log. */
export interface Machine {
  bot: string;
  machine: string;
  host: string;
  created: string;
}

interface KeyFileDoc {
  seed: string;
  bot: string;
  machine: string;
  host: string;
  created: string;
}

export class KeyFile {
  readonly path: string;
  readonly isDefault: boolean;

  constructor(filePath?: string | null) {
    if (filePath != null) {
      this.path = filePath;
      this.isDefault = false;
    } else {
      const override = process.env['AURIVAL_KEY_PATH'];
      if (override) {
        this.path = override;
        this.isDefault = false;
      } else {
        this.path = KeyFile.defaultPath();
        this.isDefault = true;
      }
    }
  }

  static defaultPath(): string {
    return path.join('.aurival', 'machine.json');
  }

  async load(): Promise<{ key: MachineKey; machine: Machine } | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (exc) {
      if (isNoEnt(exc)) return null;
      throw exc;
    }
    const doc = JSON.parse(raw) as KeyFileDoc;
    const key = MachineKey.fromSeedB64(doc.seed);
    const machine: Machine = {
      bot: doc.bot,
      machine: doc.machine,
      host: doc.host,
      created: doc.created,
    };
    return { key, machine };
  }

  async save(key: MachineKey, machine: Machine): Promise<void> {
    const directory = path.dirname(this.path);
    await fs.mkdir(directory, { recursive: true });
    await fs.chmod(directory, 0o700);

    const doc: KeyFileDoc = {
      seed: key.seedB64ForSave(),
      bot: machine.bot,
      machine: machine.machine,
      host: machine.host,
      created: machine.created,
    };

    const tmpName = path.join(directory, `.machine-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmpName, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(tmpName, 0o600);
      await fs.rename(tmpName, this.path);
    } catch (exc) {
      await fs.unlink(tmpName).catch(() => undefined);
      throw exc;
    }

    if (this.isDefault) {
      await fs.writeFile(path.join(directory, '.gitignore'), '*\n', 'utf8');
    }
  }
}

function isNoEnt(exc: unknown): boolean {
  return typeof exc === 'object' && exc !== null && (exc as { code?: unknown }).code === 'ENOENT';
}

export class Auth {
  readonly bot: string;
  readonly #http: HttpClient;
  readonly #key: MachineKey;
  readonly #machineId: string;
  readonly #logger: Logger;
  /** Only ever read to name the file in a `key_revoked` message (S7). */
  readonly #keyPath: string | null;
  #token: string | null = null;
  #expiresAtMs: number | null = null;
  /** Serializes concurrent callers against `#token`/`#expiresAtMs` mutation;
   * unlike a cached in-flight promise, each queued caller still performs its
   * own exchange when it is `refresh()` doing the calling (SDK-37). */
  #chain: Promise<void> = Promise.resolve();

  constructor(
    http: HttpClient,
    key: MachineKey,
    machine: Machine,
    logger?: Logger,
    keyPath?: string | null,
  ) {
    this.#http = http;
    this.#key = key;
    this.#machineId = machine.machine;
    this.bot = machine.bot;
    this.#logger = logger ?? defaultLogger();
    this.#keyPath = keyPath ?? null;
  }

  /** The current token's absolute expiry, or `null` before the first exchange.
   * Read-only mirror of the private field — socket.ts's rotation timer needs
   * it to compute a deadline, never to mutate it (SDK bot-api-curation). */
  get expiresAtMs(): number | null {
    return this.#expiresAtMs;
  }

  #fresh(): boolean {
    return (
      this.#token !== null &&
      this.#expiresAtMs !== null &&
      Date.now() < this.#expiresAtMs - TOKEN_REFRESH_HEADROOM_MS
    );
  }

  async token(): Promise<string> {
    if (this.#fresh()) {
      return this.#token as string;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    // Unconditional: `token()` checks freshness before calling this,
    // `refresh()` itself always performs a new exchange. Chaining onto
    // `#chain` only serializes attempts against the shared fields below.
    const run = this.#chain.then(() => this.#exchange());
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #exchange(): Promise<string> {
    const assertion = this.buildAssertion();
    let resp: Record<string, unknown>;
    try {
      resp = await this.#http.request('POST', '/v1/token', {
        body: { assertion },
        authenticated: false,
      });
    } catch (exc) {
      throw this.#nameTheKeyFile(exc);
    }
    const token = resp['access_token'];
    if (typeof token !== 'string') {
      throw new errors.ProtocolError('token response missing access_token');
    }
    const expiresAt = resp['expires_at'];
    this.#expiresAtMs = parseRfc3339(String(expiresAt));
    this.#token = token;
    this.#logger.debug('access token refreshed');
    return token;
  }

  /**
   * A revoked key cannot be retried out of, and the fix is deleting a file the
   * developer has probably never opened. The SAME error object comes back with
   * its message extended — the README documents catching `KeyRevoked`, so
   * wrapping it in something new would break the contract it is here to serve.
   */
  #nameTheKeyFile(exc: unknown): unknown {
    if (!(exc instanceof errors.KeyRevoked)) return exc;
    const keyPath = this.#keyPath ?? KeyFile.defaultPath();
    if (!existsSync(keyPath)) return exc;
    // The server already says "generate a new keypair and pair again"; the one
    // thing it cannot know is where this machine keeps its key.
    exc.message = `${exc.message} Remove ${keyPath} and run the bot again to pair a new key.`;
    return exc;
  }

  buildAssertion(now?: number): string {
    const iat = Math.floor(now ?? Date.now() / 1000);
    const exp = iat + ASSERTION_MAX_AGE_S;
    const nonce = b64urlNopad(randomBytes(16));
    const payload = {
      key_id: this.#machineId,
      bot_id: this.bot,
      iat,
      exp,
      nonce,
    };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = this.#key.sign(raw);
    return `${b64urlNopad(raw)}.${b64urlNopad(sig)}`;
  }
}

// pairing.go:64 falls back on the server side past 64 chars anyway; we
// truncate up front so the sent label and the signed label always match.
export function machineLabel(): string {
  return os.hostname().slice(0, 64);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return parts[0] === '127';
  }
  return false;
}

export function resolveHost(): string {
  const host = process.env['AURIVAL_API'];
  if (!host) return DEFAULT_HOST;
  const fail = (): never => {
    throw new Error(
      `AURIVAL_API must be https:// unless the host is loopback, got ${JSON.stringify(host)}`,
    );
  };
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    return fail();
  }
  // `new URL().hostname` brackets a literal IPv6 host, e.g. "[::1]".
  let hostname = parsed.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHostname(hostname)) {
    return fail();
  }
  return host;
}

export interface PairOptions {
  machineLabel?: string | undefined;
  host: string;
  out?: ((line: string) => void) | undefined;
  logger?: Logger | undefined;
  signal?: AbortSignal | undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface PollSettled {
  machine: Machine | null;
  expired: boolean;
}

async function pollUntilSettled(
  http: HttpClient,
  pollToken: string,
  intervalMs: number,
  host: string,
  signal: AbortSignal | undefined,
): Promise<PollSettled> {
  const headers = { Authorization: `Bearer ${pollToken}` };
  for (;;) {
    await sleep(intervalMs, signal);
    let resp: Record<string, unknown>;
    try {
      resp = await http.request('POST', '/v1/pair/poll', { authenticated: false, headers });
    } catch (exc) {
      if (exc instanceof errors.PairRateLimited) {
        const wait =
          exc.retry_after !== null ? exc.retry_after * 1000 : DEFAULT_PAIR_RETRY_AFTER_MS;
        await sleep(wait, signal);
        continue;
      }
      throw exc;
    }

    const state = resp['state'];
    if (state === 'pending') continue;
    if (state === 'expired') return { machine: null, expired: true };
    if (state === 'approved') {
      const machine: Machine = {
        bot: String(resp['bot']),
        machine: String(resp['machine']),
        host,
        created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      return { machine, expired: false };
    }
    throw new errors.ProtocolError(`unknown pairing state: ${JSON.stringify(state)}`);
  }
}

export async function pair(
  http: HttpClient,
  options: PairOptions,
): Promise<{ key: MachineKey; machine: Machine }> {
  const log = options.logger ?? defaultLogger();
  const label = options.machineLabel ?? machineLabel();
  const out = options.out ?? ((line: string) => console.log(line));
  const signal = options.signal;
  const key = MachineKey.generate();

  for (;;) {
    const iat = Math.floor(Date.now() / 1000);
    const proof = key.sign(Buffer.from(`pair-start:${label}:${iat}`, 'utf8'));

    let start: Record<string, unknown>;
    try {
      start = await http.request('POST', '/v1/pair/start', {
        authenticated: false,
        body: {
          machine_label: label,
          public_key: key.publicKeyB64,
          proof: Buffer.from(proof).toString('base64'),
          iat,
        },
      });
    } catch (exc) {
      if (exc instanceof errors.PairRateLimited) {
        const wait =
          exc.retry_after !== null ? exc.retry_after * 1000 : DEFAULT_PAIR_RETRY_AFTER_MS;
        log.info(`pairing rate limited, waiting ${(wait / 1000).toFixed(0)}s`);
        await sleep(wait, signal);
        continue;
      }
      throw exc;
    }

    const userCode = String(start['user_code']);
    const fingerprint = String(start['fingerprint']);
    const pollToken = String(start['poll_token']);
    const intervalMs = Number(start['interval_ms']);

    // Directly to stdout, never the logger (SDK-31) — a dev with the
    // logger at WARNING must still see this. The lead's e2e matches these
    // two lines verbatim: /pairing code\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.
    out(`aurival: pairing code    ${userCode}`);
    out(`aurival: fingerprint     ${fingerprint}`);
    out('Compare the fingerprint in the app, then approve. Waiting...');

    const settled = await pollUntilSettled(http, pollToken, intervalMs, options.host, signal);
    if (settled.machine !== null) {
      return { key, machine: settled.machine };
    }
    log.info('pairing code expired, starting a new one');
    out('That code expired. Here is a new one:');
    // SDK-36: unbounded restart, one new code per restart. Loop again.
  }
}
