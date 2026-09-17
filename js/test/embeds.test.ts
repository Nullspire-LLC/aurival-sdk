import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAP_BAD_BUTTON_STYLE,
  CAP_BUTTON_ID_TOO_LONG,
  CAP_DESCRIPTION_TOO_LONG,
  CAP_DUPLICATE_BUTTON_ID,
  CAP_IMAGE_URL_NOT_HTTPS,
  CAP_LABEL_TOO_LONG,
  CAP_LINK_STYLE_DEFERRED,
  CAP_TITLE_TOO_LONG,
  CAP_TOO_MANY_BUTTONS,
  CAP_TOO_MANY_EMBEDS,
  CAP_TOO_MANY_FIELDS,
  EMPTY_MESSAGE,
} from '../src/caps.js';
import { Button, Embed, serialiseButtons, serialiseEmbeds } from '../src/embeds.js';
import { BotContext, ButtonContext, Event, MemberContext, contextFor } from '../src/events.js';
import type { Message } from '../src/events.js';
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

function makeButtonEvent(data: Record<string, unknown>): Event {
  return Event.fromFrame({
    id: 'evt_01J9',
    type: 'button.pressed',
    created_at: '2026-09-17T18:04:20Z',
    sequence: 1,
    data,
  });
}

const STORED_MESSAGE: Record<string, unknown> = {
  id: 'msg_1',
  text: '',
  created_at: '2026-09-17T18:04:00Z',
  sender: 'usr_bot',
};

describe('Embed builder chain', () => {
  it('produces the wire shape key for key', () => {
    const embed = new Embed({
      title: 'Trivia round 4',
      description: 'Which ocean is the deepest?',
      color: '#3E6E8E',
    })
      .setAuthor('Quizbot', 'https://cdn.aurival.com/q.png')
      .setThumbnail('https://cdn.aurival.com/t.png')
      .setImage('https://cdn.aurival.com/i.png')
      .addField('Players', '6', true)
      .setFooter('Answer within 30s')
      .setTimestamp('2026-09-17T18:04:00Z');

    expect(embed.toJSON()).toEqual({
      title: 'Trivia round 4',
      description: 'Which ocean is the deepest?',
      color: '#3E6E8E',
      author: { name: 'Quizbot', icon: 'https://cdn.aurival.com/q.png' },
      thumbnail: { url: 'https://cdn.aurival.com/t.png' },
      image: { url: 'https://cdn.aurival.com/i.png' },
      fields: [{ name: 'Players', value: '6', inline: true }],
      footer: { text: 'Answer within 30s' },
      timestamp: '2026-09-17T18:04:00Z',
    });
  });

  it('a Date timestamp becomes UTC RFC3339 with Z', () => {
    const embed = new Embed().setTimestamp(new Date('2026-09-17T18:04:00.000Z'));
    expect(embed.toJSON()['timestamp']).toBe('2026-09-17T18:04:00.000Z');
  });

  it('omits fields when empty and omits every absent key', () => {
    const embed = new Embed({ title: 'bare' });
    expect(embed.toJSON()).toEqual({ title: 'bare' });
  });

  it('a future embed key survives a round trip', () => {
    const withUnknown = { title: 'x', some_future_key: { nested: true } };
    const decoded = Embed.fromJSON(withUnknown);
    expect(decoded.toJSON()).toEqual(withUnknown);
  });
});

describe('Button builder', () => {
  it('the easy call defaults id from the label and style to primary', () => {
    const button = new Button({ label: 'Pacific' });
    expect(button.toJSON()).toEqual({ id: 'pacific', label: 'Pacific', style: 'primary' });
  });

  it('slugifies a multi-word label', () => {
    const button = new Button({ label: 'The Pacific Ocean!' });
    expect(button.id).toBe('the-pacific-ocean');
  });

  it('round trips through toJSON/fromJSON', () => {
    const button = new Button({ label: 'Pacific', id: 'pacific', style: 'secondary' });
    expect(Button.fromJSON(button.toJSON()).toJSON()).toEqual(button.toJSON());
  });
});

describe('cap sentences — one case per violation', () => {
  it('CAP_TOO_MANY_EMBEDS: a 4th embed is refused', () => {
    const embeds = [
      new Embed({ title: 'a' }),
      new Embed({ title: 'b' }),
      new Embed({ title: 'c' }),
      new Embed({ title: 'd' }),
    ];
    expect(() => serialiseEmbeds(embeds)).toThrowError(CAP_TOO_MANY_EMBEDS);
  });

  it('CAP_TOO_MANY_FIELDS: the 7th field on one embed is refused at addField time', () => {
    const embed = new Embed();
    for (let i = 0; i < 6; i++) embed.addField(`f${i}`, 'v');
    expect(() => embed.addField('f6', 'v')).toThrowError(CAP_TOO_MANY_FIELDS);
  });

  it('CAP_TOO_MANY_FIELDS: split across embeds (4 + 3) is refused at serialise time', () => {
    const first = new Embed();
    for (let i = 0; i < 4; i++) first.addField(`f${i}`, 'v');
    const second = new Embed();
    for (let i = 0; i < 3; i++) second.addField(`g${i}`, 'v');
    expect(() => serialiseEmbeds([first, second])).toThrowError(CAP_TOO_MANY_FIELDS);
  });

  it('CAP_TOO_MANY_BUTTONS: a 6th button is refused', () => {
    const buttons = Array.from({ length: 6 }, (_, i) => new Button({ label: `b${i}` }));
    expect(() => serialiseButtons(buttons)).toThrowError(CAP_TOO_MANY_BUTTONS);
  });

  it('CAP_LABEL_TOO_LONG: a 25-code-point label is refused', () => {
    expect(() => new Button({ label: 'a'.repeat(25) })).toThrowError(CAP_LABEL_TOO_LONG);
  });

  it('CAP_LABEL_TOO_LONG counts code points, not UTF-16 units (a surrogate pair is one)', () => {
    // 24 astral emoji = 24 code points but 48 UTF-16 units.
    const label = '\u{1F600}'.repeat(24);
    expect(() => new Button({ label })).not.toThrow();
    expect(() => new Button({ label: label + '\u{1F600}' })).toThrowError(CAP_LABEL_TOO_LONG);
  });

  it('CAP_BUTTON_ID_TOO_LONG: an explicit 33-char id is refused', () => {
    expect(() => new Button({ label: 'x', id: 'a'.repeat(33) })).toThrowError(
      CAP_BUTTON_ID_TOO_LONG,
    );
  });

  it('CAP_DUPLICATE_BUTTON_ID: two buttons sharing an id are refused', () => {
    const buttons = [new Button({ label: 'a', id: 'x' }), new Button({ label: 'b', id: 'x' })];
    expect(() => serialiseButtons(buttons)).toThrowError(CAP_DUPLICATE_BUTTON_ID);
  });

  it('CAP_BAD_BUTTON_STYLE: an unrecognized style is refused', () => {
    expect(() => new Button({ label: 'x', style: 'ghost' })).toThrowError(CAP_BAD_BUTTON_STYLE);
  });

  it('CAP_LINK_STYLE_DEFERRED: style "link" is refused with its own sentence, not the generic one', () => {
    expect(() => new Button({ label: 'x', style: 'link' })).toThrowError(CAP_LINK_STYLE_DEFERRED);
  });

  it('CAP_TITLE_TOO_LONG: a 257-char title is refused', () => {
    expect(() => new Embed({ title: 'a'.repeat(257) })).toThrowError(CAP_TITLE_TOO_LONG);
  });

  it('CAP_DESCRIPTION_TOO_LONG: a 1025-char description is refused', () => {
    expect(() => new Embed({ description: 'a'.repeat(1025) })).toThrowError(
      CAP_DESCRIPTION_TOO_LONG,
    );
  });

  it('CAP_IMAGE_URL_NOT_HTTPS: a non-https image url is refused', () => {
    expect(() => new Embed().setImage('http://cdn.aurival.com/i.png')).toThrowError(
      CAP_IMAGE_URL_NOT_HTTPS,
    );
  });

  it('CAP_IMAGE_URL_NOT_HTTPS: a non-https thumbnail url is refused', () => {
    expect(() => new Embed().setThumbnail('http://cdn.aurival.com/t.png')).toThrowError(
      CAP_IMAGE_URL_NOT_HTTPS,
    );
  });

  it('CAP_IMAGE_URL_NOT_HTTPS: a non-https author icon is refused', () => {
    expect(() => new Embed().setAuthor('Quizbot', 'http://cdn.aurival.com/q.png')).toThrowError(
      CAP_IMAGE_URL_NOT_HTTPS,
    );
  });
});

describe('a plain object literal is validated exactly like a builder', () => {
  it('an over-long label in a raw object is refused with the same sentence', () => {
    expect(() =>
      serialiseButtons([{ label: 'a'.repeat(25), id: 'x', style: 'primary' }]),
    ).toThrowError(CAP_LABEL_TOO_LONG);
  });

  it('a non-https image url in a raw object is refused with the same sentence', () => {
    expect(() => serialiseEmbeds([{ title: 't', image: { url: 'http://nope' } }])).toThrowError(
      CAP_IMAGE_URL_NOT_HTTPS,
    );
  });

  it('a raw object is not a bypass for the duplicate-id cap', () => {
    expect(() =>
      serialiseButtons([
        { label: 'a', id: 'x', style: 'primary' },
        new Button({ label: 'b', id: 'x' }),
      ]),
    ).toThrowError(CAP_DUPLICATE_BUTTON_ID);
  });

  it('a valid raw object passes through unchanged', () => {
    const [serialised] = serialiseButtons([{ label: 'Pacific', id: 'pacific', style: 'primary' }]);
    expect(serialised).toEqual({ id: 'pacific', label: 'Pacific', style: 'primary' });
  });
});

describe('serialiseEmbeds/serialiseButtons omit an absent or empty array', () => {
  it('undefined and [] both produce []', () => {
    expect(serialiseEmbeds(undefined)).toEqual([]);
    expect(serialiseEmbeds([])).toEqual([]);
    expect(serialiseButtons(undefined)).toEqual([]);
    expect(serialiseButtons([])).toEqual([]);
  });
});

describe('send/reply serialise embeds/buttons and text: "" is accepted alongside them', () => {
  function buildBotCtx(http: HttpClient): BotContext {
    const event = Event.fromFrame({
      id: 'evt_1',
      type: 'bot.added',
      created_at: '2026-09-17T00:00:00Z',
      sequence: 1,
      data: {
        chat: { id: 'chat_1', type: 'group', name: null },
        actor: { id: 'usr_1', handle: 'h', name: 'n' },
      },
    });
    return BotContext.fromEvent(event, http);
  }

  it('reply(text, { embeds, buttons }) puts both arrays in the body', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    const embed = new Embed({ title: 'round 4' });
    const button = new Button({ label: 'Pacific' });
    await ctx.reply('', { embeds: [embed], buttons: [button] });
    const body = requests[0]?.body as { embeds?: unknown[]; buttons?: unknown[]; text?: string };
    expect(body.text).toBe('');
    expect(body.embeds).toEqual([{ title: 'round 4' }]);
    expect(body.buttons).toEqual([{ id: 'pacific', label: 'Pacific', style: 'primary' }]);
  });

  it('reply({ embeds }) sends an embed-only reply with no text argument', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    await ctx.reply({ embeds: [new Embed({ title: 'now playing' })] });
    const body = requests[0]?.body as { text?: string; embeds?: unknown[] };
    expect(body.text).toBe('');
    expect(body.embeds).toEqual([{ title: 'now playing' }]);
  });

  it('send(chat, { embeds }) sends an embed-only message with no text argument', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    await ctx.send('chat_2', { embeds: [{ title: 'reminder' }] });
    const body = requests[0]?.body as { text?: string; embeds?: unknown[] };
    expect(body.text).toBe('');
    expect(body.embeds).toEqual([{ title: 'reminder' }]);
  });

  it('refuses a send with no text, no embeds and no buttons', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    await expect(ctx.reply({})).rejects.toThrow(EMPTY_MESSAGE);
    await expect(ctx.send('chat_2', {})).rejects.toThrow(EMPTY_MESSAGE);
    expect(requests).toEqual([]);
  });

  it('send(chat, text) omits embeds/buttons entirely when neither is passed', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    await ctx.send('chat_2', 'hi');
    const body = requests[0]?.body as Record<string, unknown>;
    expect('embeds' in body).toBe(false);
    expect('buttons' in body).toBe(false);
  });

  it('send(chat, text, { embeds }) accepts a plain object literal for an embed', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const ctx = buildBotCtx(http);
    await ctx.send('chat_2', 'hi', { embeds: [{ title: 'raw' }] });
    const body = requests[0]?.body as { embeds?: unknown[] };
    expect(body.embeds).toEqual([{ title: 'raw' }]);
  });
});

describe('Message decode: embeds/buttons/button_used, null and absent are identical', () => {
  function decode(extra: Record<string, unknown>): Promise<Message> {
    return new Promise((resolve) => {
      startServer((_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...STORED_MESSAGE, ...extra }));
      }).then(({ url, server }) => {
        openServers.push(server);
        const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
        const event = Event.fromFrame({
          id: 'evt_1',
          type: 'member.joined',
          created_at: '2026-09-17T00:00:00Z',
          sequence: 1,
          data: {
            chat: { id: 'chat_1', type: 'group', name: null },
            user: { id: 'u', handle: 'h', name: 'n' },
          },
        });
        const ctx = MemberContext.fromEvent(event, http);
        void ctx.reply('hi').then(resolve);
      });
    });
  }

  it('null-valued and absent-key payloads decode to the same Message', async () => {
    const withNulls = await decode({ embeds: null, buttons: null, button_used: null });
    const withAbsent = await decode({});
    expect(withNulls.embeds).toEqual([]);
    expect(withAbsent.embeds).toEqual([]);
    expect(withNulls.buttons).toEqual([]);
    expect(withAbsent.buttons).toEqual([]);
    expect(withNulls.button_used).toBeNull();
    expect(withAbsent.button_used).toBeNull();
  });
});

describe('ButtonContext', () => {
  it('carries chat, user, message, button and interaction', () => {
    const event = makeButtonEvent({
      chat: { id: 'chat_01J9', type: 'group', name: null },
      message: 'msg_01J9',
      button: 'pacific',
      interaction: 'evt_01J9',
      user: { object: 'user', id: 'usr_g', handle: 'wingriddenangel', name: 'Gustav' },
    });
    const ctx = contextFor(event, new HttpClient('http://x', new FakeAuth() as unknown as Auth));
    expect(ctx).toBeInstanceOf(ButtonContext);
    if (!(ctx instanceof ButtonContext)) throw new Error('unreachable');
    expect(ctx.chat.id).toBe('chat_01J9');
    expect(ctx.message.id).toBe('msg_01J9');
    expect(ctx.button).toBe('pacific');
    expect(ctx.interaction).toBe('evt_01J9');
    expect(ctx.user).toEqual({ id: 'usr_g', handle: 'wingriddenangel', name: 'Gustav' });
  });

  it('ack() POSTs /v1/interactions/{interaction}/ack with ctx.interaction verbatim and tolerates 204', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeButtonEvent({
      chat: { id: 'chat_1', type: 'group', name: null },
      message: 'msg_1',
      button: 'pacific',
      interaction: 'evt_01J9',
      user: { id: 'usr_g', handle: 'h', name: 'n' },
    });
    const ctx = ButtonContext.fromEvent(event, http);
    await expect(ctx.ack()).resolves.toBeUndefined();
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/v1/interactions/evt_01J9/ack');
  });

  it('reply() quotes the card (the message id)', async () => {
    const { url, server, requests } = await startServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STORED_MESSAGE));
    });
    openServers.push(server);
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    const event = makeButtonEvent({
      chat: { id: 'chat_1', type: 'group', name: null },
      message: 'msg_quote_me',
      button: 'pacific',
      interaction: 'evt_1',
      user: { id: 'usr_g', handle: 'h', name: 'n' },
    });
    const ctx = ButtonContext.fromEvent(event, http);
    await ctx.reply('correct!');
    const body = requests[0]?.body as { reply_to?: string };
    expect(body.reply_to).toBe('msg_quote_me');
  });
});

describe('an unknown event type still yields EventContext (forward-compat door stays open)', () => {
  it('does not treat button.pressed as falling through the default arm', () => {
    const event = makeButtonEvent({
      chat: { id: 'chat_1', type: 'group', name: null },
      message: 'msg_1',
      button: 'x',
      interaction: 'evt_1',
      user: { id: 'usr_1', handle: 'h', name: 'n' },
    });
    const http = new HttpClient('http://x', new FakeAuth() as unknown as Auth);
    expect(contextFor(event, http)).toBeInstanceOf(ButtonContext);
  });
});
