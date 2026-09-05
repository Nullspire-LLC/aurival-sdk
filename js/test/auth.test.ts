/**
 * Tests for `../src/auth.ts`.
 *
 * Two fixed vectors are pinned against the landed Python SDK (never against
 * this module's own math): a public key + fingerprint, and a signed
 * assertion. The pairing and token flows run against a REAL `node:http`
 * server (`FakeBotAPI` below), shaped from `pairing.go` / `server.go` /
 * `token.go`, not a mock — and never a mocked `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// `node:os` exports are a frozen ESM namespace — `vi.spyOn` cannot redefine
// `hostname` on it directly, so the module itself is mocked (hoisted above
// these imports by vitest) with a spy wrapping the real implementation.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});

import { HttpClient } from '../src/http.js';
import * as errors from '../src/errors.js';
import {
  Auth,
  DEFAULT_HOST,
  MachineKey,
  machineLabel,
  pair,
  resolveHost,
  type Machine,
} from '../src/auth.js';

// --- fixed vectors, produced by running the landed Python SDK --------------
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const SEED_B64 = SEED.toString('base64');
const PUBKEY_B64 = 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=';
const FINGERPRINT = 'ZXST-0S3V';
const REPR = '<MachineKey fingerprint=ZXST-0S3V>';
const SIGN_HELLO_B64 =
  '4af8qUqDUSeIW5ni66cz1u5b9dxGPtg4Xrbx3KoRF8DxUXUKEPRvWzeWqRIDV49wLIXGfDNLVomlFihNSZ9xDw==';
const SIGN_PAIRSTART_B64 =
  '8VBVu5xJJ2gMjy53QuxuDVYu+t4zKR+uiUp9NBXu6+HeZR2idk5am5VUm8W06AESLKXphqgKavAUqRNE98fsBw==';

describe('fixed vectors', () => {
  it('matches the public key and fingerprint', () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    expect(key.publicKeyB64).toBe(PUBKEY_B64);
    expect(key.fingerprint).toBe(FINGERPRINT);
  });

  it('matches toString()', () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    expect(key.toString()).toBe(REPR);
    expect(String(key)).toBe(REPR);
  });

  it('matches sign("hello")', () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    const sig = key.sign(Buffer.from('hello'));
    expect(Buffer.from(sig).toString('base64')).toBe(SIGN_HELLO_B64);
  });

  it('matches sign("pair-start:testmachine:1700000000")', () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    const sig = key.sign(Buffer.from('pair-start:testmachine:1700000000'));
    expect(Buffer.from(sig).toString('base64')).toBe(SIGN_PAIRSTART_B64);
  });

  it('seedB64ForSave round-trips through fromSeedB64 to the same key', () => {
    const generated = MachineKey.generate();
    const seed = generated.seedB64ForSave();
    const restored = MachineKey.fromSeedB64(seed);
    expect(restored.publicKeyB64).toBe(generated.publicKeyB64);
    expect(restored.fingerprint).toBe(generated.fingerprint);
  });
});

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function fixtureMachine(): Machine {
  return { bot: 'bot_a', machine: 'machine_b', host: 'https://x', created: '2026-01-01T00:00:00Z' };
}

describe('buildAssertion', () => {
  it('has the exact key order, ages, nonce length, and a verifying signature', () => {
    const key = MachineKey.generate();
    const machine: Machine = {
      bot: 'bot_abc',
      machine: 'machine_xyz',
      host: 'https://x',
      created: '2026-01-01T00:00:00Z',
    };
    const a = new Auth(new HttpClient('http://127.0.0.1:1'), key, machine);
    const wire = a.buildAssertion(1_700_000_000);
    const parts = wire.split('.');
    expect(parts).toHaveLength(2);
    const [rawB64, sigB64] = parts as [string, string];
    const raw = b64urlDecode(rawB64);
    const sig = b64urlDecode(sigB64);

    // exact key order, compact separators
    expect(raw.toString('utf8')).toBe(
      '{"key_id":"machine_xyz","bot_id":"bot_abc","iat":1700000000,"exp":1700000120,"nonce":"' +
        JSON.parse(raw.toString('utf8')).nonce +
        '"}',
    );
    const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    expect(payload['key_id']).toBe('machine_xyz');
    expect(payload['bot_id']).toBe('bot_abc');
    expect(payload['iat']).toBe(1_700_000_000);
    expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(120);
    const nonceBytes = b64urlDecode(payload['nonce'] as string);
    expect(nonceBytes.length).toBe(16);

    const pub = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(key.publicKeyB64, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
    expect(verify(null, raw, pub, sig)).toBe(true);
  });

  it('uses a fresh random nonce each call', () => {
    const key = MachineKey.generate();
    const a = new Auth(new HttpClient('http://127.0.0.1:1'), key, fixtureMachine());
    const w1 = a.buildAssertion(1);
    const w2 = a.buildAssertion(1);
    expect(w1).not.toBe(w2);
  });
});

// ---------------------------------------------------------------------------
// a real in-process http server, shaped from pairing.go / server.go / token.go
// ---------------------------------------------------------------------------

interface ScriptResult {
  status: number;
  payload: unknown;
  headers?: Record<string, string> | undefined;
}

export type PairStartFn = (body: Record<string, unknown>) => ScriptResult;
export type PairPollFn = (token: string) => ScriptResult;
export type TokenFn = (body: Record<string, unknown>) => ScriptResult;

export function errorEnvelope(errorType: string, code: string, message = 'test error') {
  return {
    error: {
      type: errorType,
      code,
      message,
      doc_url: `https://bots.aurival.com/docs/errors#${code}`,
      request_id: 'req_test',
    },
  };
}

export function ok(payload: unknown, status = 200, headers?: Record<string, string>): ScriptResult {
  return { status, payload, headers };
}

export function err(
  errorType: string,
  code: string,
  status: number,
  headers?: Record<string, string>,
): ScriptResult {
  return { status, payload: errorEnvelope(errorType, code), headers };
}

/**
 * A tiny stand-in for bot-api's pairing/token endpoints. Verifies the
 * pairing proof exactly like `pairing.go` does, so a client that signs the
 * wrong bytes fails here exactly as it would against the real service.
 */
export class FakeBotAPI {
  pairStartScript: PairStartFn[] = [];
  pairPollScript: PairPollFn[] = [];
  tokenScript: TokenFn[] = [];
  pairStartCalls: Record<string, unknown>[] = [];
  pairPollCalls: string[] = [];
  tokenCalls: Record<string, unknown>[] = [];
  readonly server = http.createServer((req, res) => {
    void this.#handle(req, res);
  });

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    let result: ScriptResult;
    if (req.url === '/v1/pair/start' && req.method === 'POST') {
      this.pairStartCalls.push(body);
      const next = this.pairStartScript.shift();
      result = next ? next(body) : this.#defaultPairStart(body);
    } else if (req.url === '/v1/pair/poll' && req.method === 'POST') {
      const auth = req.headers['authorization'] ?? '';
      const token = Array.isArray(auth) ? (auth[0] ?? '') : auth.replace(/^Bearer /, '');
      this.pairPollCalls.push(token);
      const next = this.pairPollScript.shift();
      result = next
        ? next(token)
        : ok({
            object: 'pairing',
            state: 'pending',
            expires_at: '2026-01-01T00:00:00Z',
            access_token: null,
            bot: null,
            machine: null,
          });
    } else if (req.url === '/v1/token' && req.method === 'POST') {
      this.tokenCalls.push(body);
      const next = this.tokenScript.shift();
      result = next ? next(body) : err('api_error', 'internal_error', 500);
    } else {
      result = { status: 404, payload: errorEnvelope('invalid_request_error', 'not_found') };
    }

    res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
    res.end(JSON.stringify(result.payload));
  }

  #defaultPairStart(body: Record<string, unknown>): ScriptResult {
    const pub = Buffer.from(String(body['public_key']), 'base64');
    // pairing.go:41-63 — verify against the label AS SENT, no fallback.
    const msg = Buffer.from(
      `pair-start:${String(body['machine_label'] ?? '')}:${String(body['iat'])}`,
      'utf8',
    );
    const sig = Buffer.from(String(body['proof']), 'base64');
    const pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') },
      format: 'jwk',
    });
    let valid: boolean;
    try {
      valid = verify(null, msg, pubKey, sig);
    } catch {
      valid = false;
    }
    if (!valid) return err('authentication_error', 'bad_proof', 401);
    return ok(
      {
        user_code: 'TEST-0001',
        fingerprint: 'TEST-FING',
        poll_token: 'polltok_default',
        expires_at: '2026-01-01T00:00:00Z',
        interval_ms: 5,
      },
      201,
    );
  }
}

export async function withRunningHttp<T>(
  fake: FakeBotAPI,
  fn: (http: HttpClient) => Promise<T>,
): Promise<T> {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address() as AddressInfo;
  const client = new HttpClient(`http://127.0.0.1:${address.port}`);
  try {
    return await fn(client);
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
}

function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

describe('pairing', () => {
  it('happy path returns key and machine', async () => {
    const fake = new FakeBotAPI();
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'pending',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: null,
          bot: null,
          machine: null,
        }),
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'attok_from_pairing',
          bot: 'bot_won123',
          machine: 'machine_won456',
        }),
    ];
    const lines: string[] = [];
    const { key, machine } = await withRunningHttp(fake, (client) =>
      pair(client, { machineLabel: 'test-machine', host: 'https://x', out: (l) => lines.push(l) }),
    );
    expect(machine.bot).toBe('bot_won123');
    expect(machine.machine).toBe('machine_won456');
    expect(lines.some((l) => l.includes('TEST-0001'))).toBe(true);
    expect(lines.some((l) => l.includes('TEST-FING'))).toBe(true);
    expect(key).toBeInstanceOf(MachineKey);
  });

  it('signs the label actually sent, including empty string', async () => {
    const fake = new FakeBotAPI();
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'tok',
          bot: 'bot_a',
          machine: 'machine_b',
        }),
    ];
    const { machine } = await withRunningHttp(fake, (client) =>
      pair(client, { machineLabel: '', host: 'https://x', out: () => {} }),
    );
    expect(fake.pairStartCalls[0]?.['machine_label']).toBe('');
    expect(machine.bot).toBe('bot_a');
  });

  it('prints to stdout via out(), never the logger', async () => {
    const fake = new FakeBotAPI();
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'tok',
          bot: 'bot_a',
          machine: 'machine_b',
        }),
    ];
    const lines: string[] = [];
    const logLines: string[] = [];
    const logger = {
      debug: (m: string) => logLines.push(m),
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      error: (m: string) => logLines.push(m),
    };
    await withRunningHttp(fake, (client) =>
      pair(client, { machineLabel: 'm', host: 'https://x', out: (l) => lines.push(l), logger }),
    );
    const joinedOut = lines.join('\n');
    expect(joinedOut).toContain('TEST-0001');
    expect(joinedOut).toContain('TEST-FING');
    const joinedLogs = logLines.join('\n');
    expect(joinedLogs).not.toContain('TEST-0001');
    expect(joinedLogs).not.toContain('TEST-FING');
  });

  it('rate limited on pair/start sleeps Retry-After seconds (converted to ms)', async () => {
    const fake = new FakeBotAPI();
    fake.pairStartScript = [
      () => err('rate_limit_error', 'pair_rate_limited', 429, { 'Retry-After': '1' }),
    ];
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'tok',
          bot: 'bot_a',
          machine: 'machine_b',
        }),
    ];
    const start = Date.now();
    await withRunningHttp(fake, (client) =>
      pair(client, { machineLabel: 'm', host: 'https://x', out: () => {} }),
    );
    const elapsed = Date.now() - start;
    // A 1s -> 1000ms conversion bug (off by 1000x either way) fails these
    // bounds; a correct wait lands comfortably inside them.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    expect(fake.pairStartCalls.length).toBe(2);
  });

  it('expired pairing restarts unbounded with a new code', async () => {
    const fake = new FakeBotAPI();
    let starts = 0;
    const startResponder: PairStartFn = () => {
      starts += 1;
      return ok(
        {
          user_code: 'TEST-000' + String(starts),
          fingerprint: 'TEST-FING',
          poll_token: `polltok-${starts}`,
          expires_at: '2026-01-01T00:00:00Z',
          interval_ms: 5,
        },
        201,
      );
    };
    fake.pairStartScript = [startResponder, startResponder];
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'expired',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: null,
          bot: null,
          machine: null,
        }),
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'tok',
          bot: 'bot_a',
          machine: 'machine_b',
        }),
    ];
    const lines: string[] = [];
    const { machine } = await withRunningHttp(fake, (client) =>
      pair(client, { machineLabel: 'm', host: 'https://x', out: (l) => lines.push(l) }),
    );
    expect(machine.bot).toBe('bot_a');
    const joined = lines.join('\n');
    expect(joined).toContain('TEST-0001');
    expect(joined).toContain('TEST-0002');
    expect(starts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// token exchange / caching
// ---------------------------------------------------------------------------

describe('token exchange and caching', () => {
  let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  it('caches and refreshes ahead of expiry', async () => {
    let now = 1_800_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const fake = new FakeBotAPI();
    let calls = 0;
    const responder: TokenFn = () => {
      calls += 1;
      return ok({ access_token: `attok_${calls}`, expires_at: rfc3339(now + 900_000) });
    };
    fake.tokenScript = [responder, responder];

    const key = MachineKey.generate();
    const machine = fixtureMachine();

    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine);
      const t1 = await a.token();
      const t2 = await a.token(); // still fresh: no second call
      expect(t1).toBe('attok_1');
      expect(t2).toBe('attok_1');
      expect(calls).toBe(1);

      // jump past expires_at - headroom (900s - 60s = 840s from now)
      now += 850_000;
      const t3 = await a.token();
      expect(t3).toBe('attok_2');
      expect(calls).toBe(2);
    });
  });

  it('refresh() always forces a new exchange', async () => {
    const fake = new FakeBotAPI();
    let calls = 0;
    const responder: TokenFn = () => {
      calls += 1;
      return ok({ access_token: `attok_${calls}`, expires_at: rfc3339(Date.now() + 900_000) });
    };
    fake.tokenScript = [responder, responder];
    const key = MachineKey.generate();
    const machine = fixtureMachine();

    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine);
      const first = await a.refresh();
      const second = await a.refresh(); // forced, even though `first` is still fresh
      expect(first).toBe('attok_1');
      expect(second).toBe('attok_2');
      expect(calls).toBe(2);
    });
  });

  it('key_revoked raises and does not swallow', async () => {
    const fake = new FakeBotAPI();
    fake.tokenScript = [() => err('authentication_error', 'key_revoked', 401)];
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine);
      await expect(a.refresh()).rejects.toBeInstanceOf(errors.KeyRevoked);
    });
  });

  // S7: a revoked key is not fixable by retrying, and the one action that fixes
  // it is deleting a file the developer has probably never looked at. Name it.
  it('key_revoked names the key file to remove when one exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-revoked-'));
    const keyPath = path.join(dir, 'machine.json');
    fs.writeFileSync(keyPath, '{}');

    const fake = new FakeBotAPI();
    fake.tokenScript = [() => err('authentication_error', 'key_revoked', 401)];
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine, undefined, keyPath);
      const raised = await a.refresh().then(
        () => null,
        (exc: unknown) => exc,
      );
      // Still the documented class — the README tells people to catch it.
      expect(raised).toBeInstanceOf(errors.KeyRevoked);
      expect((raised as Error).message).toContain(keyPath);
      expect((raised as errors.KeyRevoked).code).toBe('key_revoked');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('key_revoked names no path when the key file is already gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-revoked-'));
    const keyPath = path.join(dir, 'machine.json'); // never written

    const fake = new FakeBotAPI();
    fake.tokenScript = [() => err('authentication_error', 'key_revoked', 401)];
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine, undefined, keyPath);
      const raised = await a.refresh().then(
        () => null,
        (exc: unknown) => exc,
      );
      expect(raised).toBeInstanceOf(errors.KeyRevoked);
      expect((raised as Error).message).not.toContain(keyPath);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a non-revocation authentication error is left exactly as it arrived', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-revoked-'));
    const keyPath = path.join(dir, 'machine.json');
    fs.writeFileSync(keyPath, '{}');

    const fake = new FakeBotAPI();
    fake.tokenScript = [() => err('authentication_error', 'bad_assertion', 401)];
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine, undefined, keyPath);
      const raised = await a.refresh().then(
        () => null,
        (exc: unknown) => exc,
      );
      expect(raised).toBeInstanceOf(errors.BadAssertion);
      expect((raised as Error).message).not.toContain(keyPath);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// resolveHost / machineLabel
// ---------------------------------------------------------------------------

describe('resolveHost', () => {
  const ORIGINAL = process.env['AURIVAL_API'];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['AURIVAL_API'];
    else process.env['AURIVAL_API'] = ORIGINAL;
  });

  it('defaults when unset', () => {
    delete process.env['AURIVAL_API'];
    expect(resolveHost()).toBe(DEFAULT_HOST);
  });

  it('rejects non-https non-loopback', () => {
    process.env['AURIVAL_API'] = 'http://example.com:80';
    expect(() => resolveHost()).toThrow();
  });

  it('accepts loopback http with port', () => {
    process.env['AURIVAL_API'] = 'http://127.0.0.1:54321';
    expect(resolveHost()).toBe('http://127.0.0.1:54321');
  });

  it('accepts localhost http with port', () => {
    process.env['AURIVAL_API'] = 'http://localhost:9000';
    expect(resolveHost()).toBe('http://localhost:9000');
  });

  it('accepts https non-loopback', () => {
    process.env['AURIVAL_API'] = 'https://staging.bots.aurival.com';
    expect(resolveHost()).toBe('https://staging.bots.aurival.com');
  });
});

describe('machineLabel', () => {
  it('truncates to 64 characters', () => {
    vi.mocked(os.hostname).mockReturnValue('x'.repeat(100));
    try {
      expect(machineLabel().length).toBe(64);
    } finally {
      vi.mocked(os.hostname).mockRestore();
    }
  });
});
