/**
 * AMENDMENT-09 §4/§6.1, L3's `forUser.test.ts`: caller-locked buttons on the
 * wire — `for_user` reaching `send`/`reply`/`edit`/`ack`, a `User` and a
 * bare id serialising to the same string (D21), the tri-state on edit/ack
 * (omit = inherit, `null` = clear, an id = move — §4.3), the plain-optional
 * shape on send/reply (both `undefined` and `null` omit the key — §4.1/§4.3
 * "create has nothing to inherit or clear"), `Message.forUser` decoding,
 * `ButtonContext`'s pinned absence of any `forUser` (§6.1/D20), and the two
 * new error classes.
 *
 * Uses the same hand-rolled local HTTP server `events.test.ts` uses for
 * `Context.reply`/`send`/`edit` — a real request/response round trip, not a
 * mocked `HttpClient`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ButtonContext, Context, Event } from '../src/events.js';
import type { User } from '../src/events.js';
import { NOTHING_TO_EDIT } from '../src/caps.js';
import { ForUserNotMember, TooManyAliases, fromEnvelope } from '../src/errors.js';
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

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  body: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
      const captured: CapturedRequest = { method: req.method, url: req.url, body };
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

function makeInvokedEvent(): Event {
  return Event.fromFrame({
    id: 'evt_1',
    type: 'command.invoked',
    created_at: '2026-01-01T00:00:00Z',
    sequence: 1,
    data: {
      command: 'quiz',
      arguments: '',
      message: 'msg_the_invocation',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    },
  });
}

function makeButtonPressedEvent(): Event {
  return Event.fromFrame({
    id: 'evt_press',
    type: 'button.pressed',
    created_at: '2026-01-01T00:00:00Z',
    sequence: 1,
    data: {
      chat: { id: 'chat_1', type: 'dm', name: null },
      user: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_card',
      button: 'answer_a',
      interaction: 'evt_press',
    },
  });
}

const ALICE: User = { id: 'usr_alice', handle: 'alice', name: 'Alice' };

// --------------------------------------------------------------------------
// send / reply: plain-optional, undefined AND null both omit the key
// --------------------------------------------------------------------------

describe('forUser on send()/reply(): reaches the wire as for_user, the id string', () => {
  it('reply({ forUser: User }) puts for_user on the wire as the id', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_sent', chat: 'chat_1', text: 'q1' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.reply('q1', { forUser: ALICE });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('reply({ forUser: "usr_..." }) — a bare id string — serialises to the SAME id as the User object', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_sent', chat: 'chat_1', text: 'q1' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.reply('q1', { forUser: 'usr_alice' });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('send(chat, text, { forUser }) reaches the wire the same way as reply()', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_sent', chat: 'chat_2', text: 'q1' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.send('chat_2', 'q1', { forUser: ALICE });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('reply() with forUser OMITTED sends no for_user key at all', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_sent', chat: 'chat_1', text: 'q1' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.reply('q1');
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(false);
  });

  it('reply({ forUser: null }) ALSO sends no for_user key — a create has nothing to clear', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_sent', chat: 'chat_1', text: 'q1' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.reply('q1', { forUser: null });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(false);
  });
});

// --------------------------------------------------------------------------
// edit()/ack(): tri-state — omit inherits, null clears, an id moves it
// --------------------------------------------------------------------------

describe('forUser on edit(): tri-state (§4.3)', () => {
  it('edit(msg, { forUser: User }) puts for_user on the wire as the id (moves the lock)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'edited' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', { text: 'edited', forUser: ALICE });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('edit(msg, { forUser: "usr_..." }) — a bare id — serialises to the same id as a User', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'edited' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', { text: 'edited', forUser: 'usr_alice' });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('edit(msg, { forUser: null }) sends explicit JSON null — CLEARS the lock', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'edited' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', { text: 'edited', forUser: null });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(true);
    expect(body['for_user']).toBeNull();
  });

  it('edit(msg, { forUser: null }) ALONE is a real edit and reaches the wire', async () => {
    // Seat ruling on AMENDMENT-09's open question: naming only the lock IS
    // an edit, and L1 widens `patch.Empty()` to count `for_user`. So the
    // local precondition counts four parts and this body goes out as exactly
    // `{ for_user: null }` — §12 step 16 written the way a bot author would
    // reach for it. Identical to `sdk/python/aurival`'s (SDK-7).
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'kept' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await expect(ctx.edit('msg_1', { forUser: null })).resolves.toBeDefined();
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toEqual({ for_user: null });
  });

  it('edit(msg, { forUser: "usr_2" }) ALONE reaches the wire as a lock move', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'kept' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', { forUser: 'usr_2' });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toEqual({ for_user: 'usr_2' });
  });

  it('edit(msg, {}) naming none of the four parts still trips NOTHING_TO_EDIT', async () => {
    const http = new HttpClient('http://127.0.0.1:1', new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await expect(ctx.edit('msg_1', {})).rejects.toThrow(NOTHING_TO_EDIT);
  });

  it('edit(msg, "words") — the string overload — OMITS for_user entirely (INHERIT)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: 'words' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', 'words');
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(false);
  });

  it('edit(msg, { embeds: null }) with forUser omitted sends no for_user key — INHERIT', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', chat: 'chat_1', text: '' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    await ctx.edit('msg_1', { embeds: null });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(false);
  });
});

describe('forUser on ButtonContext.ack(): tri-state, same as edit()', () => {
  it('ack({ forUser: User }) puts for_user on the wire as the id', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    await ctx.ack({ text: 'ok', forUser: ALICE });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });

  it('ack({ forUser: null }) sends explicit JSON null', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    await ctx.ack({ text: 'ok', forUser: null });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    const body = req.body as Record<string, unknown>;
    expect('for_user' in body).toBe(true);
    expect(body['for_user']).toBeNull();
  });

  it('ack() with no argument sends NO BODY AT ALL — byte-identical to 0.5.0, for_user included', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    await ctx.ack();
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toBeNull();
  });

  it('ack({ forUser: "usr_..." }) — bare id — reaches the wire the same as ack({ forUser: User })', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    await ctx.ack({ text: 'ok', forUser: 'usr_alice' });
    const req = requests[0];
    if (req === undefined) throw new Error('expected one request');
    expect(req.body).toMatchObject({ for_user: 'usr_alice' });
  });
});

// --------------------------------------------------------------------------
// Message.forUser decoding
// --------------------------------------------------------------------------

describe('Message.forUser is decoded from the wire', () => {
  it('a stored message carrying for_user decodes it onto Message.forUser', async () => {
    const { url, server } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'message',
          id: 'msg_1',
          chat: 'chat_1',
          sender: 'usr_bot',
          text: 'q1',
          created_at: '2026-09-18T00:00:00Z',
          for_user: 'usr_alice',
        }),
      );
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    const sent = await ctx.reply('q1', { forUser: ALICE });
    expect(sent.forUser).toBe('usr_alice');
  });

  it('Message.forUser is null when the wire omits for_user', async () => {
    const { url, server } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'message',
          id: 'msg_1',
          chat: 'chat_1',
          sender: 'usr_bot',
          text: 'q1',
          created_at: '2026-09-18T00:00:00Z',
        }),
      );
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    const sent = await ctx.reply('q1');
    expect(sent.forUser).toBeNull();
  });

  it('Message.forUser is null when the wire sends for_user: null', async () => {
    const { url, server } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'message',
          id: 'msg_1',
          chat: 'chat_1',
          sender: 'usr_bot',
          text: 'q1',
          created_at: '2026-09-18T00:00:00Z',
          for_user: null,
        }),
      );
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = Context.fromEvent(makeInvokedEvent(), http);
    const sent = await ctx.reply('q1');
    expect(sent.forUser).toBeNull();
  });
});

// --------------------------------------------------------------------------
// ButtonContext exposes NO forUser (§6.1, D20) — runtime AND type pins
// --------------------------------------------------------------------------

describe('ButtonContext exposes NO forUser (§6.1/D20 — a pinned absence)', () => {
  it('runtime: "forUser" in ctx is false', () => {
    const http = new HttpClient('http://example.invalid');
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    expect('forUser' in ctx).toBe(false);
  });

  it('type pin: reading ctx.forUser is a compile error', () => {
    const http = new HttpClient('http://example.invalid');
    const ctx = ButtonContext.fromEvent(makeButtonPressedEvent(), http);
    // @ts-expect-error ButtonContext deliberately has no `forUser` — §6.1:
    // the presser always IS the locked user, and `message` on
    // `button.pressed` is a reference with no route to resolve a lock from
    // (D20). A later lane that adds this property back should see THIS
    // line start compiling, which is exactly the regression the pin exists
    // to catch.
    const neverForUser = ctx.forUser;
    expect(neverForUser).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// the two new error classes
// --------------------------------------------------------------------------

describe('TooManyAliases and ForUserNotMember raise through the SDK error mapping', () => {
  function envelopeFor(code: string): Record<string, unknown> {
    return {
      error: {
        type: 'invalid_request_error',
        code,
        message: `message for ${code}`,
        doc_url: `https://bots.aurival.com/docs/errors#${code}`,
        request_id: 'req_1',
      },
    };
  }

  it('too_many_aliases maps to TooManyAliases', () => {
    const exc = fromEnvelope(envelopeFor('too_many_aliases'));
    expect(exc).toBeInstanceOf(TooManyAliases);
    expect(exc.code).toBe('too_many_aliases');
  });

  it('for_user_not_member maps to ForUserNotMember', () => {
    const exc = fromEnvelope(envelopeFor('for_user_not_member'));
    expect(exc).toBeInstanceOf(ForUserNotMember);
    expect(exc.code).toBe('for_user_not_member');
  });
});
