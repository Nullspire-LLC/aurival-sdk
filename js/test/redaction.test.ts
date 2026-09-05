/**
 * SDK-33 is architecture, not a feature: this test is the enforcement.
 *
 * Nothing containing the seed b64, the raw seed bytes, an access token, or a
 * poll token may reach `String`/`toString`/`util.inspect`/`JSON.stringify` of
 * `MachineKey` or `Auth`; a logged line; the pairing stdout printout; or the
 * `.stack`/`util.inspect` of a failed exchange's thrown error.
 */

import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Auth, MachineKey, pair } from '../src/auth.js';
import { HttpClient } from '../src/http.js';
import * as errors from '../src/errors.js';

// A minimal stand-in for bot-api's pairing/token endpoints, duplicated from
// auth.test.ts rather than imported from it: importing a `*.test.ts` module
// for its helpers would also re-run every `describe()` at its top level and
// double-collect that whole suite here (mirrors why the Python original
// imports only its non-`test_`-prefixed helpers from `test_auth`, never the
// module itself for side effects).

interface ScriptResult {
  status: number;
  payload: unknown;
  headers?: Record<string, string> | undefined;
}

type PairStartFn = (body: Record<string, unknown>) => ScriptResult;
type PairPollFn = (token: string) => ScriptResult;
type TokenFn = (body: Record<string, unknown>) => ScriptResult;

function errorEnvelope(errorType: string, code: string, message = 'test error') {
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

function ok(payload: unknown, status = 200, headers?: Record<string, string>): ScriptResult {
  return { status, payload, headers };
}

function err(
  errorType: string,
  code: string,
  status: number,
  headers?: Record<string, string>,
): ScriptResult {
  return { status, payload: errorEnvelope(errorType, code), headers };
}

class FakeBotAPI {
  pairStartScript: PairStartFn[] = [];
  pairPollScript: PairPollFn[] = [];
  tokenScript: TokenFn[] = [];
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
      const next = this.pairStartScript.shift();
      result = next ? next(body) : err('api_error', 'internal_error', 500);
    } else if (req.url === '/v1/pair/poll' && req.method === 'POST') {
      const auth = req.headers['authorization'] ?? '';
      const token = Array.isArray(auth) ? (auth[0] ?? '') : auth.replace(/^Bearer /, '');
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
      const next = this.tokenScript.shift();
      result = next ? next(body) : err('api_error', 'internal_error', 500);
    } else {
      result = { status: 404, payload: errorEnvelope('invalid_request_error', 'not_found') };
    }

    res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
    res.end(JSON.stringify(result.payload));
  }
}

async function withRunningHttp<T>(
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

const SEED_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

function secretsFrom(seedB64: string): string[] {
  const seedBytes = Buffer.from(seedB64, 'base64');
  return [seedB64, seedBytes.toString('hex'), String(seedBytes), inspect(seedBytes)];
}

function assertNonePresent(haystacks: string[], secrets: string[], where: string): void {
  const joined = haystacks.join('\n');
  for (const secret of secrets) {
    expect(joined, `leaked ${JSON.stringify(secret)} in ${where}`).not.toContain(secret);
  }
}

function fixtureMachine() {
  return { bot: 'bot_a', machine: 'machine_b', host: 'https://x', created: '2026-01-01T00:00:00Z' };
}

describe('MachineKey never leaks the seed', () => {
  it('via String, toString, util.inspect, and JSON.stringify', () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    const secrets = secretsFrom(SEED_B64);
    assertNonePresent(
      [
        String(key),
        key.toString(),
        inspect(key),
        inspect(key, { depth: 10, showHidden: true }),
        JSON.stringify(key),
        `${key}`,
      ],
      secrets,
      'MachineKey str/repr/format',
    );
    // Positive control: the fingerprint IS meant to be shown, so this test
    // cannot pass by having emptied the repr entirely.
    expect(inspect(key)).toContain(key.fingerprint);
  });
});

describe('Auth never leaks the seed or the access token', () => {
  it('via str/repr and a full deep inspect', async () => {
    const key = MachineKey.fromSeedB64(SEED_B64);
    const machine = fixtureMachine();
    const fake = new FakeBotAPI();
    fake.tokenScript = [
      () => ok({ access_token: 'attok_super_secret_123', expires_at: '2099-01-01T00:00:00Z' }),
    ];
    await withRunningHttp(fake, async (client) => {
      const a = new Auth(client, key, machine);
      await a.token();
      const secrets = [...secretsFrom(SEED_B64), 'attok_super_secret_123'];
      assertNonePresent(
        [String(a), inspect(a), inspect(a, { depth: 10, showHidden: true }), JSON.stringify(a)],
        secrets,
        'Auth str/repr/inspect',
      );
    });
  });
});

describe('a full pairing + token exchange + a deliberate failure', () => {
  it('never logs, prints, or throws the seed, the access token, or the poll token', async () => {
    const fake = new FakeBotAPI();
    fake.pairStartScript = [
      () => err('rate_limit_error', 'pair_rate_limited', 429, { 'Retry-After': '0' }),
      () =>
        ok(
          {
            user_code: 'TEST-0001',
            fingerprint: 'TEST-FING',
            poll_token: 'polltok_default',
            expires_at: '2026-01-01T00:00:00Z',
            interval_ms: 5,
          },
          201,
        ),
    ];
    fake.pairPollScript = [
      () =>
        ok({
          object: 'pairing',
          state: 'approved',
          expires_at: '2026-01-01T00:00:00Z',
          access_token: 'tok_ignored',
          bot: 'bot_secretflow',
          machine: 'machine_secretflow',
        }),
    ];
    const outLines: string[] = [];
    const logLines: string[] = [];
    const logger = {
      debug: (m: string) => logLines.push(m),
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      error: (m: string) => logLines.push(m),
    };

    let thrown: unknown = null;
    await withRunningHttp(fake, async (client) => {
      const { key, machine } = await pair(client, {
        machineLabel: 'm',
        host: 'https://x',
        out: (l) => outLines.push(l),
        logger,
      });

      fake.tokenScript = [
        () => ok({ access_token: 'attok_from_first_exchange', expires_at: '2099-01-01T00:00:00Z' }),
      ];
      const a = new Auth(client, key, machine, logger);
      await a.token();

      fake.tokenScript = [() => err('authentication_error', 'key_revoked', 401)];
      try {
        await a.refresh();
      } catch (exc) {
        thrown = exc;
      }
    });

    const seedBytes = Buffer.from(SEED_B64, 'base64');
    const secrets = [
      SEED_B64,
      seedBytes.toString('hex'),
      'attok_from_first_exchange',
      'polltok_default',
      'tok_ignored',
    ];

    expect(thrown, 'the deliberate key_revoked failure must actually have thrown').not.toBeNull();
    expect(thrown).toBeInstanceOf(errors.KeyRevoked);
    const stack = thrown instanceof Error ? (thrown.stack ?? '') : '';
    const deepInspect = inspect(thrown, { depth: 10 });

    assertNonePresent(logLines, secrets, 'logger across pairing + token exchange + failure');
    assertNonePresent(outLines, secrets, 'pairing stdout printout');
    assertNonePresent([stack], secrets, 'thrown error .stack');
    assertNonePresent([deepInspect], secrets, 'util.inspect(err, {depth:10})');
  });
});
