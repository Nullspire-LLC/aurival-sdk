import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BotContext,
  Context,
  Event,
  EventContext,
  MemberContext,
  Mention,
  ReactionContext,
  contextFor,
  mention,
} from '../src/events.js';
import * as errors from '../src/errors.js';
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
    expect(ctx.chat).toEqual({ id: 'chat_1', type: 'dm', name: null, member_count: null });
    expect(ctx.sender).toEqual({ id: 'user_1', handle: 'gustav', name: 'Gustav' });
    expect(ctx.event).toBe(event);
  });

  it('carries message, the `msg_` id of the invocation (BA-R27 depends on it) as an id-only Message when there is no invoking_message (BA-R42: old-server fallback)', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message?.id).toBe('msg_the_invocation');
    expect(ctx.message?.text).toBe('');
    expect(ctx.message?.sent_at).toBe('');
    expect(ctx.message?.sender).toBeNull();
    expect(ctx.message?.reply_to).toBeNull();
  });

  it('message is an empty Message, never null, when absent (BA-R68: a command always has one)', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message.id).toBe('');
  });

  it('message is an empty Message when not a string', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 12345,
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message.id).toBe('');
  });
});

describe('Context.fromEvent > invoking_message (BA-R42)', () => {
  it('a full invoking_message payload maps every field, including a non-null reply_to', () => {
    const event = makeInvokedEvent({
      command: 'echo',
      arguments: 'hello there',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
      invoking_message: {
        object: 'message',
        id: 'msg_the_invocation',
        text: '/echo hello there',
        sent_at: '2026-09-05T00:00:00Z',
        sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
        reply_to: 'msg_earlier',
      },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message?.id).toBe('msg_the_invocation');
    expect(ctx.message?.text).toBe('/echo hello there');
    expect(ctx.message?.sent_at).toBe('2026-09-05T00:00:00Z');
    expect(ctx.message?.sender).toEqual({ id: 'user_1', handle: 'gustav', name: 'Gustav' });
    expect(ctx.message?.reply_to).toBe('msg_earlier');
  });

  it('a null reply_to on the wire yields ctx.message.reply_to of null', () => {
    const event = makeInvokedEvent({
      command: 'echo',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
      invoking_message: {
        object: 'message',
        id: 'msg_the_invocation',
        text: '/echo',
        sent_at: '2026-09-05T00:00:00Z',
        sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
        reply_to: null,
      },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message?.reply_to).toBeNull();
  });

  it('id-only fallback: message present but no invoking_message yields a Message whose text is "" not undefined/crash (old server, BA-R42 compat)', () => {
    const event = makeInvokedEvent({
      command: 'echo',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_old_server',
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.message?.id).toBe('msg_old_server');
    expect(ctx.message?.text).toBe('');
  });
});

describe('Context.reply', () => {
  it('quotes the invoking message: {chat, text, reply_to} plus an Idempotency-Key (BA-R27)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'message',
          id: 'msg_sent',
          chat: 'chat_1',
          sender: 'usr_bot',
          text: 'hello there',
          created_at: '2026-09-16T00:00:00Z',
        }),
      );
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
    // The stored entity (created_at, sender as a bare id) decodes into the
    // same `Message` shape events carry, so `result.id` goes straight back
    // into edit()/delete()/react() (BA-R68).
    expect(result).toEqual({
      id: 'msg_sent',
      text: 'hello there',
      sent_at: '2026-09-16T00:00:00Z',
      sender: { id: 'usr_bot', handle: '', name: '' },
      reply_to: null,
    });
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

  it('reply() sends reply_to = the invoking message id from a full invoking_message payload (BA-R42)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(server);

    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeInvokedEvent({
      command: 'echo',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_the_invocation',
      invoking_message: {
        object: 'message',
        id: 'msg_the_invocation',
        text: '/echo',
        sent_at: '2026-09-05T00:00:00Z',
        sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
        reply_to: null,
      },
    });
    const ctx = Context.fromEvent(event, http);

    await ctx.reply('hello there');
    const req = requests[0];
    if (req === undefined) throw new Error('expected one captured request');
    expect(req.body).toEqual({
      chat: 'chat_1',
      text: 'hello there',
      reply_to: 'msg_the_invocation',
    });
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

// --------------------------------------------------------------------------
// AMENDMENT-04: chat.member_count, contextFor, Mention, actions
// --------------------------------------------------------------------------

function makeGenericEvent(type: string, data: Record<string, unknown>): Event {
  return Event.fromFrame({
    id: 'evt_g1',
    type,
    created_at: '2026-09-16T00:00:00Z',
    sequence: 1,
    data,
  });
}

describe('Chat.member_count', () => {
  it('is a number when the wire frame carries it', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null, member_count: 3 },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.chat.member_count).toBe(3);
  });

  it('is null, never defaulted to 0, when the wire frame omits it', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
    });
    const ctx = Context.fromEvent(event, new HttpClient('http://example.invalid'));
    expect(ctx.chat.member_count).toBeNull();
    expect('member_count' in ctx.chat).toBe(true);
  });
});

describe('contextFor: one context class per event family (BA-R68)', () => {
  const http = new HttpClient('http://example.invalid');

  it('member.joined builds a MemberContext with chat and user, and no sender/actor/emoji fields at all', () => {
    const event = makeGenericEvent('member.joined', {
      chat: { id: 'chat_1', type: 'group', name: null, member_count: 4 },
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
    });
    const ctx = contextFor(event, http);
    expect(ctx).toBeInstanceOf(MemberContext);
    if (!(ctx instanceof MemberContext)) throw new Error('unreachable');
    expect(ctx.user).toEqual({ id: 'user_9', handle: 'newbie', name: 'Newbie' });
    expect(ctx.chat.member_count).toBe(4);
    // The class carries only what the family delivers, so autocomplete never
    // offers a field that is always empty.
    expect('sender' in ctx).toBe(false);
    expect('actor' in ctx).toBe(false);
    expect('emoji' in ctx).toBe(false);
    expect('message' in ctx).toBe(false);
  });

  it('member.left builds a MemberContext too', () => {
    const event = makeGenericEvent('member.left', {
      chat: { id: 'chat_1', type: 'group', name: null },
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
    });
    expect(contextFor(event, http)).toBeInstanceOf(MemberContext);
  });

  it('bot.added / bot.removed build a BotContext with chat and actor', () => {
    for (const type of ['bot.added', 'bot.removed']) {
      const event = makeGenericEvent(type, {
        chat: { id: 'chat_1', type: 'group', name: null },
        actor: { id: 'user_2', handle: 'op', name: 'Op' },
      });
      const ctx = contextFor(event, http);
      expect(ctx).toBeInstanceOf(BotContext);
      if (!(ctx instanceof BotContext)) throw new Error('unreachable');
      expect(ctx.actor).toEqual({ id: 'user_2', handle: 'op', name: 'Op' });
      expect('user' in ctx).toBe(false);
    }
  });

  it('reaction.added builds a ReactionContext with chat, sender, message (id-only) and emoji', () => {
    const event = makeGenericEvent('reaction.added', {
      chat: { id: 'chat_1', type: 'group', name: null },
      message: 'msg_77',
      emoji: '\u{1F44D}',
      sender: { id: 'user_3', handle: 'reactor', name: 'Reactor' },
    });
    const ctx = contextFor(event, http);
    expect(ctx).toBeInstanceOf(ReactionContext);
    if (!(ctx instanceof ReactionContext)) throw new Error('unreachable');
    expect(ctx.emoji).toBe('\u{1F44D}');
    expect(ctx.message).toEqual({
      id: 'msg_77',
      text: '',
      sent_at: '',
      sender: null,
      reply_to: null,
    });
    expect(ctx.sender).toEqual({ id: 'user_3', handle: 'reactor', name: 'Reactor' });
  });

  it('command.invoked builds the command Context', () => {
    const event = makeInvokedEvent({
      command: 'ping',
      arguments: '',
      chat: { id: 'chat_1', type: 'dm', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      message: 'msg_1',
    });
    const ctx = contextFor(event, http);
    expect(ctx).toBeInstanceOf(Context);
    if (!(ctx instanceof Context)) throw new Error('unreachable');
    expect(ctx.sender.handle).toBe('gustav');
    expect(ctx.message.id).toBe('msg_1');
  });

  it('a known family pins its fields as present: a short frame yields empty entities, never null', () => {
    const member = contextFor(makeGenericEvent('member.joined', { chat: { id: 'chat_1' } }), http);
    if (!(member instanceof MemberContext)) throw new Error('expected MemberContext');
    expect(member.user).toEqual({ id: '', handle: '', name: '' });
    const reaction = contextFor(makeGenericEvent('reaction.added', {}), http);
    if (!(reaction instanceof ReactionContext)) throw new Error('expected ReactionContext');
    expect(reaction.message.id).toBe('');
    expect(reaction.emoji).toBe('');
    expect(reaction.chat.id).toBe('');
  });

  it('a known family ignores a stray field the contract says it does not carry (CONTRACT-V1 §3.1, matches python)', () => {
    const event = makeGenericEvent('member.joined', {
      chat: { id: 'chat_1', type: 'group', name: null },
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
      // None of these belong on member.joined — they must not leak through.
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      actor: { id: 'user_2', handle: 'op', name: 'Op' },
      emoji: '\u{1F44D}',
      message: 'msg_1',
    });
    const ctx = contextFor(event, http);
    expect(ctx).toBeInstanceOf(MemberContext);
    expect(Object.keys(ctx).sort()).toEqual(['chat', 'event', 'user']);
  });

  it('an unknown/future event type never throws and builds an EventContext with everything but chat null', () => {
    const event = makeGenericEvent('something.new.from.the.future', { a: 1 });
    expect(() => contextFor(event, http)).not.toThrow();
    const ctx = contextFor(event, http);
    expect(ctx).toBeInstanceOf(EventContext);
    if (!(ctx instanceof EventContext)) throw new Error('unreachable');
    expect(ctx.chat.id).toBe('');
    expect(ctx.sender).toBeNull();
    expect(ctx.user).toBeNull();
    expect(ctx.actor).toBeNull();
    expect(ctx.emoji).toBeNull();
    expect(ctx.message).toBeNull();
  });

  it('an unknown type populates opportunistically — nothing is pinned, so whatever the frame carries is surfaced', () => {
    const event = makeGenericEvent('something.new.from.the.future', {
      chat: { id: 'chat_1', type: 'group', name: null },
      sender: { id: 'user_1', handle: 'gustav', name: 'Gustav' },
      actor: { id: 'user_2', handle: 'op', name: 'Op' },
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
      emoji: '\u{1F44D}',
      message: 'msg_1',
    });
    const ctx = contextFor(event, http);
    if (!(ctx instanceof EventContext)) throw new Error('expected EventContext');
    expect(ctx.sender).toEqual({ id: 'user_1', handle: 'gustav', name: 'Gustav' });
    expect(ctx.actor).toEqual({ id: 'user_2', handle: 'op', name: 'Op' });
    expect(ctx.user).toEqual({ id: 'user_9', handle: 'newbie', name: 'Newbie' });
    expect(ctx.emoji).toBe('\u{1F44D}');
    expect(ctx.message?.id).toBe('msg_1');
  });

  it('reply() from a ReactionContext quotes the reacted-to message; from a MemberContext it floats free', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_new', text: 'x' }));
    });
    openServers.push(server);
    const live = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const reaction = contextFor(
      makeGenericEvent('reaction.added', {
        chat: { id: 'chat_1', type: 'group', name: null },
        message: 'msg_77',
        emoji: '\u{1F44D}',
        sender: { id: 'user_3', handle: 'reactor', name: 'Reactor' },
      }),
      live,
    );
    await reaction.reply('thanks');
    const member = contextFor(
      makeGenericEvent('member.joined', {
        chat: { id: 'chat_1', type: 'group', name: null },
        user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
      }),
      live,
    );
    await member.reply('welcome');
    expect(requests[0]?.body).toEqual({ chat: 'chat_1', text: 'thanks', reply_to: 'msg_77' });
    expect(requests[1]?.body).toEqual({ chat: 'chat_1', text: 'welcome' });
  });
});

describe('Mention', () => {
  it('token is "@" + handle, never "@{handle}"', () => {
    const m = mention({ id: 'usr_1', handle: 'gustav', name: 'Gustav' });
    expect(m.token).toBe('@gustav');
    expect(m.token).not.toContain('{');
  });

  it('entry is the wire shape {user: id}', () => {
    const m = mention({ id: 'usr_1', handle: 'gustav', name: 'Gustav' });
    expect(m.entry).toEqual({ user: 'usr_1' });
  });

  it('toString() template-literals the token into text', () => {
    const m = mention({ id: 'usr_1', handle: 'gustav', name: 'Gustav' });
    expect(`hi ${m}!`).toBe('hi @gustav!');
  });

  it('is an instance of the exported Mention class', () => {
    const m = mention({ id: 'usr_1', handle: 'gustav', name: 'Gustav' });
    expect(m).toBeInstanceOf(Mention);
  });
});

describe('Context actions', () => {
  function buildGenericCtx(http: HttpClient): MemberContext {
    const event = makeGenericEvent('member.joined', {
      chat: { id: 'chat_1', type: 'group', name: null },
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
    });
    return MemberContext.fromEvent(event, http);
  }

  it('typing(true) POSTs .../typing with {is_typing: true}, never "state"', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await ctx.typing(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/v1/chats/chat_1/typing');
    expect(requests[0]?.body).toEqual({ is_typing: true });
  });

  it('withTyping sends true on entry and false on exit, even when the callback throws', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await expect(
      ctx.withTyping(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual({ is_typing: true });
    expect(requests[1]?.body).toEqual({ is_typing: false });
  });

  it('edit() PATCHes /v1/messages/{msg} with {text}', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_1', text: 'updated' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const result = await ctx.edit('msg_1', 'updated');
    expect(result.id).toBe('msg_1');
    expect(result.text).toBe('updated');
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.url).toBe('/v1/messages/msg_1');
    expect(requests[0]?.body).toEqual({ text: 'updated' });
  });

  it('delete() DELETEs /v1/messages/{msg} and returns nothing', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await ctx.delete('msg_1');
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe('/v1/messages/msg_1');
  });

  it('react() PUTs the percent-encoded emoji onto the message', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await ctx.react('msg_1', '\u{1F44D}');
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url).toBe(
      `/v1/messages/msg_1/reactions/${encodeURIComponent('\u{1F44D}')}`,
    );
  });

  it('unreact() DELETEs the percent-encoded emoji off the message', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await ctx.unreact('msg_1', '\u{1F44D}');
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(
      `/v1/messages/msg_1/reactions/${encodeURIComponent('\u{1F44D}')}`,
    );
  });

  it('send() POSTs /v1/messages with mentions built from Mention, User and raw {user} entries', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const user: import('../src/events.js').User = { id: 'usr_2', handle: 'b', name: 'B' };
    await ctx.send('chat_9', 'hi @a @b', {
      mentions: [mention({ id: 'usr_1', handle: 'a', name: 'A' }), user, { user: 'usr_3' }],
    });
    expect(requests[0]?.body).toEqual({
      chat: 'chat_9',
      text: 'hi @a @b',
      mentions: [{ user: 'usr_1' }, { user: 'usr_2' }, { user: 'usr_3' }],
    });
  });

  it('members() GETs the chat member list and decodes it into a MemberPage', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'user', id: 'usr_1', handle: 'a', name: 'A' }],
          has_more: true,
          next_cursor: 'cur_2',
        }),
      );
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const page = await ctx.members(undefined, { cursor: 'cur_1' });
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe('/v1/chats/chat_1/members?cursor=cur_1');
    expect(page.users).toEqual([{ id: 'usr_1', handle: 'a', name: 'A' }]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('cur_2');
  });

  it('nextCursor is null when hasMore is false, even if the envelope sends a cursor anyway (no off-by-one inference)', async () => {
    const { url, server } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: 'cur_stale',
        }),
      );
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const page = await ctx.members();
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('members() never auto-loads a second page — one call, one page', async () => {
    let calls = 0;
    const { url, server } = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [], has_more: true, next_cursor: 'cur_2' }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    await ctx.members();
    expect(calls).toBe(1);
  });

  it('edit/delete/react/unreact accept a Message object, not just its id string', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const message: import('../src/events.js').Message = {
      id: 'msg_1',
      text: 'hi',
      sent_at: '',
      sender: null,
      reply_to: null,
    };
    await ctx.delete(message);
    await ctx.react(message, '\u{1F44D}');
    await ctx.unreact(message, '\u{1F44D}');
    expect(requests[0]?.url).toBe('/v1/messages/msg_1');
    expect(requests[1]?.url).toBe(
      `/v1/messages/msg_1/reactions/${encodeURIComponent('\u{1F44D}')}`,
    );
    expect(requests[2]?.url).toBe(
      `/v1/messages/msg_1/reactions/${encodeURIComponent('\u{1F44D}')}`,
    );
  });

  it('send() and members() accept a Chat object, not just its id string', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildGenericCtx(http);
    const chat: import('../src/events.js').Chat = {
      id: 'chat_42',
      type: 'group',
      name: null,
      member_count: null,
    };
    await ctx.members(chat);
    expect(requests[0]?.url).toBe('/v1/chats/chat_42/members');
  });

  it('typing() throws AurivalError when the context has no chat id', async () => {
    const http = new HttpClient('http://127.0.0.1:1', new FakeAuth() as unknown as Auth);
    const event = makeGenericEvent('member.joined', {
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
    });
    const ctx = MemberContext.fromEvent(event, http);
    await expect(ctx.typing(true)).rejects.toBeInstanceOf(errors.AurivalError);
  });

  it('members() throws AurivalError when no chat id is available', async () => {
    const http = new HttpClient('http://127.0.0.1:1', new FakeAuth() as unknown as Auth);
    const event = makeGenericEvent('member.joined', {
      user: { id: 'user_9', handle: 'newbie', name: 'Newbie' },
    });
    const ctx = MemberContext.fromEvent(event, http);
    await expect(ctx.members()).rejects.toBeInstanceOf(errors.AurivalError);
  });
});
