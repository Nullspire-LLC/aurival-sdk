import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import * as errors from '../src/errors.js';
import { HttpClient, type Logger } from '../src/http.js';
import type { Auth } from '../src/auth.js';

// --- test scaffolding: a REAL node:http server per test, never a fetch mock -

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

async function startServer(
  handler: (req: CapturedRequest, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: Server; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      requests.push(captured);
      await handler(captured, res);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  const port = (address as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, requests };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const openServers: Server[] = [];
afterEach(async () => {
  while (openServers.length > 0) {
    const s = openServers.pop();
    if (s !== undefined) await closeServer(s);
  }
});

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
  res.end(JSON.stringify(body));
}

function envelope(
  type: string,
  code: string,
  message: string,
  requestId = 'req_1',
): Record<string, unknown> {
  return {
    error: {
      type,
      code,
      message,
      doc_url: `https://bots.aurival.com/docs/errors#${code}`,
      request_id: requestId,
    },
  };
}

class FakeAuth implements Pick<Auth, 'bot' | 'token' | 'refresh' | 'buildAssertion'> {
  readonly bot = 'bot_1';
  current: string;
  readonly refreshedToken: string;
  refreshCalls = 0;

  constructor(token = 'tok-1', refreshedToken = 'tok-2') {
    this.current = token;
    this.refreshedToken = refreshedToken;
  }

  async token(): Promise<string> {
    return this.current;
  }

  async refresh(): Promise<string> {
    this.refreshCalls += 1;
    this.current = this.refreshedToken;
    return this.current;
  }

  buildAssertion(): string {
    return 'assertion';
  }
}

function asAuth(a: FakeAuth): Auth {
  return a as unknown as Auth;
}

class SleepSpy {
  calls: number[] = [];
  fn = async (ms: number): Promise<void> => {
    this.calls.push(ms);
  };
}

class CapturingLogger implements Logger {
  lines: string[] = [];
  private record(level: string, message: string, args: unknown[]): void {
    this.lines.push(`${level}: ${message} ${args.map((a) => String(a)).join(' ')}`);
  }
  debug(message: string, ...args: unknown[]): void {
    this.record('debug', message, args);
  }
  info(message: string, ...args: unknown[]): void {
    this.record('info', message, args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.record('warn', message, args);
  }
  error(message: string, ...args: unknown[]): void {
    this.record('error', message, args);
  }
}

async function withServer(
  handler: (req: CapturedRequest, res: ServerResponse) => void | Promise<void>,
  run: (ctx: { url: string; requests: CapturedRequest[] }) => Promise<void>,
): Promise<void> {
  const { url, server, requests } = await startServer(handler);
  try {
    await run({ url, requests });
  } finally {
    await closeServer(server);
  }
}

// --- success / decoding ------------------------------------------------------

describe('decoding a successful response', () => {
  it('returns the decoded object on 2xx', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { hello: 'world' }),
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const result = await client.request('GET', '/v1/x');
        expect(result).toEqual({ hello: 'world' });
      },
    );
  });

  it('a non-JSON body becomes a ProtocolError', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not json at all');
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await expect(client.request('GET', '/v1/x')).rejects.toBeInstanceOf(errors.ProtocolError);
      },
    );
  });

  it('a JSON array body becomes a ProtocolError', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, [1, 2, 3]),
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await expect(client.request('GET', '/v1/x')).rejects.toBeInstanceOf(errors.ProtocolError);
      },
    );
  });

  it('a JSON null body becomes a ProtocolError', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, null),
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await expect(client.request('GET', '/v1/x')).rejects.toBeInstanceOf(errors.ProtocolError);
      },
    );
  });

  it('an empty 200 body becomes a ProtocolError', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end();
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await expect(client.request('GET', '/v1/x')).rejects.toBeInstanceOf(errors.ProtocolError);
      },
    );
  });
});

// --- authenticated / Authorization header ------------------------------------

describe('Authorization header', () => {
  it('is sent as Bearer <token> when authenticated (default)', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { ok: true }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth('tok-abc')));
        await client.request('GET', '/v1/x');
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.headers['authorization']).toBe('Bearer tok-abc');
      },
    );
  });

  it('is not sent when authenticated:false', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { ok: true }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth('tok-abc')));
        await client.request('GET', '/v1/x', { authenticated: false });
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.headers['authorization']).toBeUndefined();
      },
    );
  });

  it('authenticated:true with no Auth throws AurivalError', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { ok: true }),
      async ({ url }) => {
        const client = new HttpClient(url, null);
        await expect(client.request('GET', '/v1/x')).rejects.toBeInstanceOf(errors.AurivalError);
      },
    );
  });
});

// --- access_token_expired / access_token_invalid: retry-once (SDK-37) -------

describe('token refresh retry (SDK-37)', () => {
  it('access_token_expired retries once with the refreshed token then succeeds', async () => {
    const seenAuthHeaders: Array<string | string[] | undefined> = [];
    await withServer(
      (req, res) => {
        seenAuthHeaders.push(req.headers['authorization']);
        if (req.headers['authorization'] === 'Bearer tok-2') {
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 401, envelope('authentication_error', 'access_token_expired', 'expired'));
        }
      },
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        const result = await client.request('POST', '/v1/token', { body: { assertion: 'x' } });
        expect(result).toEqual({ ok: true });
        expect(auth.refreshCalls).toBe(1);
        expect(seenAuthHeaders).toEqual(['Bearer tok-1', 'Bearer tok-2']);
      },
    );
  });

  it('access_token_expired twice throws, with exactly one refresh', async () => {
    await withServer(
      (_req, res) =>
        sendJson(
          res,
          401,
          envelope('authentication_error', 'access_token_expired', 'still expired'),
        ),
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        await expect(
          client.request('POST', '/v1/token', { body: { assertion: 'x' } }),
        ).rejects.toBeInstanceOf(errors.AccessTokenExpired);
        expect(auth.refreshCalls).toBe(1);
      },
    );
  });

  it('access_token_invalid retries once then succeeds, same as expired', async () => {
    await withServer(
      (req, res) => {
        if (req.headers['authorization'] === 'Bearer tok-2') {
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 401, envelope('authentication_error', 'access_token_invalid', 'invalid'));
        }
      },
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        const result = await client.request('POST', '/v1/token', { body: { assertion: 'x' } });
        expect(result).toEqual({ ok: true });
        expect(auth.refreshCalls).toBe(1);
      },
    );
  });

  it('access_token_invalid twice throws AccessTokenInvalid', async () => {
    await withServer(
      (_req, res) =>
        sendJson(
          res,
          401,
          envelope('authentication_error', 'access_token_invalid', 'still invalid'),
        ),
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        await expect(
          client.request('POST', '/v1/token', { body: { assertion: 'x' } }),
        ).rejects.toBeInstanceOf(errors.AccessTokenInvalid);
        expect(auth.refreshCalls).toBe(1);
      },
    );
  });

  it('any other authentication_error (key_revoked) throws immediately with no refresh', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 401, envelope('authentication_error', 'key_revoked', 'revoked'));
      },
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        await expect(
          client.request('POST', '/v1/token', { body: { assertion: 'x' } }),
        ).rejects.toBeInstanceOf(errors.KeyRevoked);
        expect(calls).toBe(1);
        expect(auth.refreshCalls).toBe(0);
      },
    );
  });

  it('retryAuth:false disables the auto-refresh retry', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 401, envelope('authentication_error', 'access_token_expired', 'expired'));
      },
      async ({ url }) => {
        const auth = new FakeAuth();
        const client = new HttpClient(url, asAuth(auth));
        await expect(
          client.request('POST', '/v1/token', { body: { assertion: 'x' }, retryAuth: false }),
        ).rejects.toBeInstanceOf(errors.AccessTokenExpired);
        expect(calls).toBe(1);
        expect(auth.refreshCalls).toBe(0);
      },
    );
  });
});

// --- Idempotency-Key (SDK-30) ------------------------------------------------

describe('Idempotency-Key (SDK-30)', () => {
  it('is generated once by the caller and identical across every retry', async () => {
    let calls = 0;
    const seenKeys: Array<string | string[] | undefined> = [];
    await withServer(
      (req, res) => {
        calls += 1;
        seenKeys.push(req.headers['idempotency-key']);
        if (calls < 3) {
          sendJson(res, 500, envelope('api_error', 'internal_error', 'our fault'));
        } else {
          sendJson(res, 201, { chat: 'chat_1', text: 'hi' });
        }
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await client.sendMessage('chat_1', 'hi', 'idem-fixed');
        expect(seenKeys).toEqual(['idem-fixed', 'idem-fixed', 'idem-fixed']);
      },
    );
  });
});

// --- rate_limit_error ---------------------------------------------------------

describe('rate_limit_error', () => {
  it('honours Retry-After header and retries', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        if (calls < 3) {
          sendJson(res, 429, envelope('rate_limit_error', 'rate_limited', 'slow down'), {
            'Retry-After': '2',
          });
        } else {
          sendJson(res, 201, { chat: 'chat_1', text: 'hi' });
        }
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        const result = await client.sendMessage('chat_1', 'hi', 'idem-1');
        expect(result).toEqual({ chat: 'chat_1', text: 'hi' });
        expect(calls).toBe(3);
        expect(spy.calls).toEqual([2000, 2000]);
      },
    );
  });

  it('falls back to the envelope retry_after when no header is present', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        if (calls < 2) {
          sendJson(res, 429, {
            error: {
              type: 'rate_limit_error',
              code: 'rate_limited',
              message: 'slow down',
              doc_url: 'https://bots.aurival.com/docs/errors#rate_limited',
              request_id: 'req_1',
              retry_after: 3,
            },
          });
        } else {
          sendJson(res, 201, { chat: 'chat_1', text: 'hi' });
        }
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await client.sendMessage('chat_1', 'hi', 'idem-2');
        expect(spy.calls).toEqual([3000]);
      },
    );
  });

  it('falls back to 1s when neither header nor envelope retry_after is present', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        if (calls < 2) {
          sendJson(res, 429, envelope('rate_limit_error', 'rate_limited', 'slow down'));
        } else {
          sendJson(res, 201, { chat: 'chat_1', text: 'hi' });
        }
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await client.sendMessage('chat_1', 'hi', 'idem-3');
        expect(spy.calls).toEqual([1000]);
      },
    );
  });

  it('is bounded at 5 attempts, then throws RateLimited', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 429, envelope('rate_limit_error', 'rate_limited', 'slow down'), {
          'Retry-After': '0',
        });
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        client.sleep = new SleepSpy().fn;
        await expect(client.sendMessage('chat_1', 'hi', 'idem-4')).rejects.toBeInstanceOf(
          errors.RateLimited,
        );
        expect(calls).toBe(5);
      },
    );
  });

  it('sync_rate_limited is NOT retried here: one request, immediate throw', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 429, envelope('rate_limit_error', 'sync_rate_limited', 'sync limit hit'), {
          'Retry-After': '60',
        });
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await expect(
          client.syncCommands('bot_1', [{ name: 'ping', description: 'd' }]),
        ).rejects.toBeInstanceOf(errors.SyncRateLimited);
        expect(calls).toBe(1);
        expect(spy.calls).toEqual([]);
      },
    );
  });

  it('pair_rate_limited is NOT retried here: one request, immediate throw', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 429, envelope('rate_limit_error', 'pair_rate_limited', 'pair limit hit'), {
          'Retry-After': '60',
        });
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await expect(client.request('POST', '/v1/pair/exchange')).rejects.toBeInstanceOf(
          errors.PairRateLimited,
        );
        expect(calls).toBe(1);
        expect(spy.calls).toEqual([]);
      },
    );
  });
});

// --- api_error / 5xx -----------------------------------------------------------

describe('api_error / 5xx', () => {
  it('retries 5 times total then throws, with bounded non-decreasing delays', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 500, envelope('api_error', 'internal_error', 'our fault'));
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const spy = new SleepSpy();
        client.sleep = spy.fn;
        await expect(client.sendMessage('chat_1', 'hi', 'idem-5')).rejects.toBeInstanceOf(
          errors.InternalError,
        );
        expect(calls).toBe(5);
        expect(spy.calls).toHaveLength(4);
        for (const delay of spy.calls) {
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeLessThanOrEqual(8000);
        }
        for (let i = 1; i < spy.calls.length; i++) {
          const prev = spy.calls[i - 1];
          const cur = spy.calls[i];
          if (prev === undefined || cur === undefined) throw new Error('unexpected hole');
          expect(cur).toBeGreaterThanOrEqual(prev);
        }
      },
    );
  });

  it('retries then succeeds', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        if (calls < 3) {
          sendJson(res, 500, envelope('api_error', 'internal_error', 'our fault'));
        } else {
          sendJson(res, 201, { chat: 'chat_1', text: 'hi' });
        }
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        client.sleep = new SleepSpy().fn;
        const result = await client.sendMessage('chat_1', 'hi', 'idem-6');
        expect(result).toEqual({ chat: 'chat_1', text: 'hi' });
        expect(calls).toBe(3);
      },
    );
  });
});

// --- invalid_request_error / permission_error: immediate, no retry ----------

describe('invalid_request_error / permission_error', () => {
  it('invalid_request_error throws immediately with the message intact', async () => {
    let calls = 0;
    const theMessage = 'A message needs text. If you meant to send nothing, do not send.';
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 400, envelope('invalid_request_error', 'empty_text', theMessage));
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        try {
          await client.sendMessage('chat_1', '', 'idem-7');
          throw new Error('expected a throw');
        } catch (exc) {
          expect(exc).toBeInstanceOf(errors.EmptyText);
          expect((exc as errors.EmptyText).message).toBe(theMessage);
        }
        expect(calls).toBe(1);
      },
    );
  });

  it('permission_error throws immediately', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        sendJson(res, 403, envelope('permission_error', 'bot_suspended', 'This bot is suspended.'));
      },
      async ({ url }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await expect(client.sendMessage('chat_1', 'hi', 'idem-8')).rejects.toBeInstanceOf(
          errors.BotSuspended,
        );
        expect(calls).toBe(1);
      },
    );
  });
});

// --- transport fault + redaction (SDK-33) -------------------------------------

describe('transport fault', () => {
  const TOKEN = 'attok_never_log_this_value_12345';

  async function findClosedPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
    const port = (address as AddressInfo).port;
    await closeServer(probe);
    return port;
  }

  it('a dial failure retries 5 times then throws TransportError', async () => {
    const port = await findClosedPort();
    const client = new HttpClient(`http://127.0.0.1:${port}`, asAuth(new FakeAuth(TOKEN)));
    const spy = new SleepSpy();
    client.sleep = spy.fn;
    await expect(client.sendMessage('chat_1', 'hi', 'idem-9')).rejects.toBeInstanceOf(
      errors.TransportError,
    );
    expect(spy.calls).toHaveLength(4);
  });

  it('never logs, attaches, or stringifies the bearer token on a transport fault', async () => {
    const port = await findClosedPort();
    const logger = new CapturingLogger();
    const client = new HttpClient(`http://127.0.0.1:${port}`, asAuth(new FakeAuth(TOKEN)), logger);
    client.sleep = new SleepSpy().fn;

    let caught: unknown;
    try {
      await client.sendMessage('chat_1', 'hi', 'idem-10');
    } catch (exc) {
      caught = exc;
    }

    expect(caught).toBeInstanceOf(errors.TransportError);
    const err = caught as errors.TransportError;
    expect(err.message).not.toContain(TOKEN);
    expect(err.stack ?? '').not.toContain(TOKEN);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(String(err)).not.toContain(TOKEN);
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();

    for (const line of logger.lines) {
      expect(line).not.toContain(TOKEN);
    }
  });
});

// --- gatewayUrl ---------------------------------------------------------------

describe('gatewayUrl', () => {
  it('maps https:// to wss://', () => {
    const client = new HttpClient('https://bots.aurival.com', null);
    expect(client.gatewayUrl()).toBe('wss://bots.aurival.com/v1/gateway');
  });

  it('maps http:// to ws://', () => {
    const client = new HttpClient('http://localhost:8080', null);
    expect(client.gatewayUrl()).toBe('ws://localhost:8080/v1/gateway');
  });

  it('strips trailing slashes on the host', () => {
    const client = new HttpClient('https://bots.aurival.com///', null);
    expect(client.gatewayUrl()).toBe('wss://bots.aurival.com/v1/gateway');
  });
});

// --- sendMessage / syncCommands / listCommands wiring -------------------------

describe('convenience method wiring', () => {
  it('sendMessage POSTs /v1/messages with {chat, text}', async () => {
    await withServer(
      (_req, res) => sendJson(res, 201, { ok: true }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await client.sendMessage('chat_1', 'hi', 'idem-11');
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/v1/messages');
        expect(req.body).toEqual({ chat: 'chat_1', text: 'hi' });
      },
    );
  });

  it('syncCommands PUTs /v1/bots/:bot/commands with {commands}', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { object: 'list', data: [] }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const commands = [{ name: 'ping', description: 'd' }];
        const result = await client.syncCommands('bot_1', commands);
        expect(result).toEqual({ object: 'list', data: [] });
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.method).toBe('PUT');
        expect(req.url).toBe('/v1/bots/bot_1/commands');
        expect(req.body).toEqual({ commands });
      },
    );
  });

  it('listCommands GETs /v1/bots/:bot/commands', async () => {
    await withServer(
      (_req, res) => sendJson(res, 200, { object: 'list', data: [] }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        const result = await client.listCommands('bot_1');
        expect(result).toEqual({ object: 'list', data: [] });
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.method).toBe('GET');
        expect(req.url).toBe('/v1/bots/bot_1/commands');
      },
    );
  });

  it('sendMessage carries reply_to when it is given one', async () => {
    await withServer(
      (_req, res) => sendJson(res, 201, { ok: true }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await client.sendMessage('chat_1', 'hi', 'idem-reply-1', 'msg_9');
        const req = requests[0];
        if (req === undefined) throw new Error('expected a request');
        expect(req.body).toEqual({ chat: 'chat_1', text: 'hi', reply_to: 'msg_9' });
      },
    );
  });

  it('sendMessage omits reply_to for null and for undefined', async () => {
    await withServer(
      (_req, res) => sendJson(res, 201, { ok: true }),
      async ({ url, requests }) => {
        const client = new HttpClient(url, asAuth(new FakeAuth()));
        await client.sendMessage('chat_1', 'hi', 'idem-reply-2', null);
        await client.sendMessage('chat_1', 'hi', 'idem-reply-3');
        expect(requests).toHaveLength(2);
        for (const req of requests) {
          expect(req.body).toEqual({ chat: 'chat_1', text: 'hi' });
        }
      },
    );
  });
});
