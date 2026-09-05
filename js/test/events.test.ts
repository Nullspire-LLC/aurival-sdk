import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, Event } from '../src/events.js';
import { HttpClient } from '../src/http.js';
import type { Auth } from '../src/auth.js';

class FakeAuth implements Pick<Auth, 'bot' | 'token' | 'refresh' | 'buildAssertion'> {
  readonly bot = 'bot_1';
  async token(): Promise<string> {
    return 'tok-1';
  }
  async refresh(): Promise<string> {
    return 'tok-1';
  }
  buildAssertion(): string {
    return 'assertion';
  }
}

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
  handler: (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void,
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
      handler(req, res, captured);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  return { url: `http://127.0.0.1:${address.port}`, server, requests };
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

describe('Event.fromFrame', () => {
  it('reads a full, well-formed frame', () => {
    const event = Event.fromFrame({
      object: 'event',
      id: 'evt_1',
      type: 'command.invoked',
      created_at: '2026-09-05T00:00:00Z',
      sequence: 42,
      data: { command: 'ping' },
    });
    expect(event.id).toBe('evt_1');
    expect(event.type).toBe('command.invoked');
    expect(event.created_at).toBe('2026-09-05T00:00:00Z');
    expect(event.sequence).toBe(42);
    expect(event.data).toEqual({ command: 'ping' });
  });

  it('defaults an absent id to an empty string', () => {
    const event = Event.fromFrame({ type: 'command.invoked', sequence: 1, data: {} });
    expect(event.id).toBe('');
  });

  it('defaults absent data to an empty object', () => {
    const event = Event.fromFrame({ id: 'evt_1', type: 'command.invoked', sequence: 1 });
    expect(event.data).toEqual({});
  });

  it('defaults a non-numeric sequence to 0', () => {
    const event = Event.fromFrame({
      id: 'evt_1',
      type: 'command.invoked',
      sequence: 'not-a-number',
      data: {},
    });
    expect(event.sequence).toBe(0);
  });

  it('coerces a non-object data field to an empty object', () => {
    const event = Event.fromFrame({
      id: 'evt_1',
      type: 'command.invoked',
      sequence: 1,
      data: 'garbage',
    });
    expect(event.data).toEqual({});
  });

  it('coerces an array data field to an empty object', () => {
    const event = Event.fromFrame({
      id: 'evt_1',
      type: 'command.invoked',
      sequence: 1,
      data: [1, 2, 3],
    });
    expect(event.data).toEqual({});
  });
});

function makeInvokedEvent(data: Record<string, unknown>): Event {
  return Event.fromFrame({
    id: 'evt_1',
    type: 'command.invoked',
    created_at: '2026-09-05T00:00:00Z',
    sequence: 1,
    data,
  });
}

describe('Context.fromEvent', () => {
  it('maps command, arguments, chat and sender', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: 'pong please',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.command).toBe('ping');
    expect(ctx.arguments).toBe('pong please');
    expect(ctx.chat).toEqual({ id: 'chat_1', type: 'dm', name: null });
    expect(ctx.sender).toEqual({ id: 'user_1', handle: 'gustav', name: 'Gustav' });
    expect(ctx.event).toBe(event);
  });

  it('carries message, the `msg_` id of the invocation (BA-R27 depends on it)', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message).toBe('msg_the_invocation');
  });

  it('message is null when absent', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message).toBeNull();
  });

  it('message is null when not a string', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 12345,
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message).toBeNull();
  });
});

describe('Context.reply', () => {
  it('quotes the invoking message: {chat, text, reply_to} plus an Idempotency-Key (BA-R27)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(server);

    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
    });
    const ctx = Context.fromEvent(event, http);

    const result = await ctx.reply('hello there');
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (req === undefined) throw new Error('expected one captured request');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/messages');
    expect(req.body).toEqual({
      chat: 'chat_1',
      text: 'hello there',
      reply_to: 'msg_the_invocation',
    });
    const key = req.headers['idempotency-key'];
    expect(typeof key).toBe('string');
  });

  it('OMITS reply_to when the event carried no message id, never sends null', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(server);

    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, http);

    await ctx.reply('hello there');
    const req = requests[0];
    if (req === undefined) throw new Error('expected one captured request');
    // `reply_to` is optional and is a `msg_` string (CONTRACT-V1 §5.0). A null
    // would be a parameter_invalid we never need to risk.
    expect(req.body).toEqual({ chat: 'chat_1', text: 'hello there' });
    expect(Object.keys(req.body as object)).not.toContain('reply_to');
  });

  it('uses a different Idempotency-Key on two separate reply() calls', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(server);

    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, http);

    await ctx.reply('first');
    await ctx.reply('second');
    expect(requests).toHaveLength(2);
    const first = requests[0];
    const second = requests[1];
    if (first === undefined || second === undefined) throw new Error('expected two requests');
    const firstKey = first.headers['idempotency-key'];
    const secondKey = second.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(firstKey).not.toBe(secondKey);
  });
});

describe('Context does not expose its HttpClient', () => {
  function buildCtx(): Context {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const http = new HttpClient('http://example.invalid', new FakeAuth() as unknown as Auth);
    return Context.fromEvent(event, http);
  }

  it('Object.keys carries no #http or HttpClient-shaped value', () => {
    const ctx = buildCtx();
    const keys = Object.keys(ctx);
    expect(keys).not.toContain('http');
    expect(keys.some((k) => k.includes('http'))).toBe(false);
    for (const key of keys) {
      const value = (ctx as unknown as Record<string, unknown>)[key];
      expect(value).not.toBeInstanceOf(HttpClient);
    }
  });

  it('JSON.stringify carries no HttpClient-shaped value', () => {
    const ctx = buildCtx();
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/http/i);
  });

  it('util.inspect with depth and showHidden carries no HttpClient-shaped value or token', () => {
    const ctx = buildCtx();
    const dump = inspect(ctx, { depth: 10, showHidden: true });
    expect(dump).not.toMatch(/tok-1/);
    expect(dump).not.toContain('HttpClient');
  });
});
