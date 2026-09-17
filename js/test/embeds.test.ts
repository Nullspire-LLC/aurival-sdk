import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAP_AUTHOR_URL_WITHOUT_NAME,
  CAP_BAD_BUTTON_STYLE,
  CAP_BUTTON_ID_TOO_LONG,
  CAP_BUTTON_MISSING_LABEL,
  CAP_DESCRIPTION_TOO_LONG,
  CAP_DUPLICATE_BUTTON_ID,
  CAP_EMBED_FOOTER_TEXT_REQUIRED,
  CAP_EMBED_URL_WITHOUT_TITLE,
  CAP_IMAGE_URL_NOT_HTTPS,
  CAP_INVALID_BUTTON_EMOJI,
  CAP_LABEL_TOO_LONG,
  CAP_LINK_BUTTON_MISSING_URL,
  CAP_LINK_URL_NOT_HTTPS,
  CAP_LINK_URL_TOO_LONG,
  CAP_TITLE_TOO_LONG,
  CAP_TOO_MANY_BUTTONS,
  CAP_TOO_MANY_EMBEDS,
  CAP_TOO_MANY_FIELDS,
  CAP_URL_ON_NON_LINK_BUTTON,
  EMPTY_MESSAGE,
  MAX_BUTTON_EMOJI_RUNES,
  MAX_LINK_URL_RUNES,
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

  it('style "link" is a recognised style now, refused only for its missing url', () => {
    expect(() => new Button({ label: 'x', style: 'link' })).toThrowError(
      CAP_LINK_BUTTON_MISSING_URL,
    );
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

describe('AMENDMENT-06 — link buttons', () => {
  it('Button.link builds a link pill, slugs its id and carries the url on the wire', () => {
    const button = Button.link({ label: 'Full lineup', url: 'https://aurival.com/lineup' });
    expect(button.toJSON()).toEqual({
      id: 'full-lineup',
      label: 'Full lineup',
      style: 'link',
      url: 'https://aurival.com/lineup',
    });
  });

  it('Button.link takes an explicit id and an emoji', () => {
    const button = Button.link({
      label: 'Notes',
      url: 'https://example.com/notes',
      id: 'notes',
      emoji: '\u{1F4DD}',
    });
    expect(button.toJSON()).toEqual({
      id: 'notes',
      label: 'Notes',
      style: 'link',
      emoji: '\u{1F4DD}',
      url: 'https://example.com/notes',
    });
  });

  it('CAP_LINK_BUTTON_MISSING_URL: style "link" without a url is refused, builder and raw object alike', () => {
    expect(() => new Button({ label: 'x', style: 'link' })).toThrowError(
      CAP_LINK_BUTTON_MISSING_URL,
    );
    expect(() => serialiseButtons([{ label: 'x', id: 'x', style: 'link' }])).toThrowError(
      CAP_LINK_BUTTON_MISSING_URL,
    );
  });

  it('CAP_URL_ON_NON_LINK_BUTTON: a url on a primary button is refused rather than dropped', () => {
    expect(() => new Button({ label: 'x', url: 'https://aurival.com' })).toThrowError(
      CAP_URL_ON_NON_LINK_BUTTON,
    );
    expect(() =>
      serialiseButtons([{ label: 'x', id: 'x', style: 'secondary', url: 'https://aurival.com' }]),
    ).toThrowError(CAP_URL_ON_NON_LINK_BUTTON);
  });

  it('CAP_LINK_URL_NOT_HTTPS: a link target answers with the link sentence, not the image one', () => {
    expect(() => Button.link({ label: 'x', url: 'http://aurival.com' })).toThrowError(
      CAP_LINK_URL_NOT_HTTPS,
    );
  });

  it('CAP_LINK_URL_TOO_LONG: the bound counts runes, so a surrogate pair is one', () => {
    const padding = 'a'.repeat(MAX_LINK_URL_RUNES - 'https://a.com/'.length);
    const atTheBound = `https://a.com/${padding}`;
    expect(() => Button.link({ label: 'x', url: atTheBound })).not.toThrow();
    expect(() => Button.link({ label: 'x', url: `${atTheBound}a` })).toThrowError(
      CAP_LINK_URL_TOO_LONG,
    );
    // 2048 runes of astral emoji are 4096 UTF-16 units and still legal.
    const astral = `https://a.com/${'\u{1F600}'.repeat(MAX_LINK_URL_RUNES - 'https://a.com/'.length)}`;
    expect(() => Button.link({ label: 'x', url: astral })).not.toThrow();
  });

  it('a link-only row is a legal card', () => {
    const serialised = serialiseButtons([
      Button.link({ label: 'One', url: 'https://aurival.com/1' }),
      Button.link({ label: 'Two', url: 'https://aurival.com/2' }),
    ]);
    expect(serialised.map((b) => b['style'])).toEqual(['link', 'link']);
  });

  it('a link button round trips through toJSON/fromJSON with its url intact', () => {
    const button = Button.link({ label: 'Notes', url: 'https://example.com/notes' });
    expect(Button.fromJSON(button.toJSON()).toJSON()).toEqual(button.toJSON());
  });
});

describe('AMENDMENT-06 — button emoji', () => {
  it('an emoji rides alongside the label and does not count toward the 24-rune cap', () => {
    const button = new Button({ label: 'a'.repeat(24), emoji: '\u{23F0}' });
    expect(button.toJSON()).toEqual({
      id: 'a'.repeat(24),
      label: 'a'.repeat(24),
      style: 'primary',
      emoji: '\u{23F0}',
    });
  });

  /**
   * The server's own truth table, ported row for row from
   * `backend-go/internal/botapi/emoji_test.go` with its case names kept, so a
   * divergence between this SDK, the python SDK and the server is one failing
   * row here rather than a bot author getting two different answers to the
   * same emoji. The python SDK carries the identical table.
   */
  const SERVER_EMOJI_TABLE: Array<[string, string, boolean]> = [
    // The four the amendment names as must-pass.
    ['a plain pictograph', '\u{1F3B2}', true],
    ['a zwj family', '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}', true],
    ['a flag', '\u{1F1F8}\u{1F1EA}', true],
    ['a keycap', '1\u{FE0F}\u{20E3}', true],

    // The must-fail set.
    ['two pictographs', '\u{1F3B2}\u{1F3B2}', false],
    ['plain letters', 'ab', false],
    ['a shortcode', ':dice:', false],
    ['the empty string', '', false],
    ['an ascii plus', '+', false],
    ['a bare digit', '1', false],
    ['half a flag', '\u{1F1F8}', false],
    ['two flags', '\u{1F1F8}\u{1F1EA}\u{1F1F8}\u{1F1EA}', false],

    // Skin tone and variation selectors ride along with one base.
    ['a skin tone modifier', '\u{1F44D}\u{1F3FD}', true],
    ['the emoji variation selector', '\u{2764}\u{FE0F}', true],
    ['the text variation selector', '\u{2764}\u{FE0E}', true],
    ['a zwj family with a skin tone', '\u{1F468}\u{1F3FB}\u{200D}\u{1F373}', true],

    // A subdivision flag: a pictographic base, tag characters, cancel tag.
    [
      'a tag sequence flag',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
      true,
    ],

    // A keycap without its enclosing mark, and one with no base at all.
    ['a digit with a variation selector but no keycap', '1\u{FE0F}', false],
    ['a hash keycap', '#\u{20E3}', true],
    ['a star keycap', '*\u{FE0F}\u{20E3}', true],
    ['a keycap mark with no base', '\u{20E3}', false],

    // The ASCII symbol classes. Sm admits all of these, which is exactly why
    // the pictographic test floors at U+0080.
    ['an ascii less-than', '<', false],
    ['an ascii equals', '=', false],
    ['an ascii pipe', '|', false],
    ['an ascii tilde', '~', false],
    ['an ascii dollar', '$', false],

    // Non-ascii symbols that ARE legal under the deliberately permissive rule.
    ['an arrow', '\u{2192}', true],
    ['a copyright sign', '\u{00A9}', true],

    // Joiner hygiene and the outer bound.
    ['a trailing joiner', '\u{1F468}\u{200D}', false],
    ['a leading joiner', '\u{200D}\u{1F468}', false],
    ['a pictograph glued to a regional indicator', '\u{1F3B2}\u{1F1F8}', false],
    ['an overlong paste', '\u{1F3B2}\u{200D}'.repeat(MAX_BUTTON_EMOJI_RUNES), false],
    ['prose after a pictograph', '\u{1F3B2} go', false],
  ];

  it("the table is the server's, all 33 rows of it", () => {
    expect(SERVER_EMOJI_TABLE).toHaveLength(33);
  });

  /**
   * The table above is a hand port, and a hand port rots the moment L1 edits
   * the server. This reads `TestValidEmoji`'s own cases out of the Go source
   * and asserts our copy still says the same thing, row for row, so a rule
   * change on the backend fails here instead of shipping as an SDK that
   * quietly disagrees with the service it talks to.
   *
   * Canonical-only: the public mirror ships `sdk/` alone, so the Go source is
   * not there to compare against. The table keeps running in the mirror
   * either way - this guard only adds the drift check where the server is on
   * disk.
   */
  const GO_EMOJI_TEST_PATH = fileURLToPath(
    new URL('../../../backend-go/internal/botapi/emoji_test.go', import.meta.url),
  );

  /** Go's double-quoted string form, for the escapes this table actually uses. */
  const unquoteGo = (literal: string): string => {
    const simple: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"' };
    let out = '';
    let i = 1;
    while (i < literal.length - 1) {
      const char = literal[i] as string;
      if (char !== '\\') {
        out += char;
        i += 1;
        continue;
      }
      const kind = literal[i + 1] as string;
      if (kind === 'U') {
        out += String.fromCodePoint(parseInt(literal.slice(i + 2, i + 10), 16));
        i += 10;
      } else if (kind === 'u') {
        out += String.fromCodePoint(parseInt(literal.slice(i + 2, i + 6), 16));
        i += 6;
      } else if (kind === 'x') {
        out += String.fromCodePoint(parseInt(literal.slice(i + 2, i + 4), 16));
        i += 4;
      } else if (simple[kind] !== undefined) {
        out += simple[kind] as string;
        i += 2;
      } else {
        // Guessed decoding would make this guard pass on the wrong string.
        throw new Error(`unhandled Go escape ${literal.slice(i, i + 2)}`);
      }
    }
    return out;
  };

  const parseGoEmojiTable = (): Array<[string, string, boolean]> => {
    const source = readFileSync(GO_EMOJI_TEST_PATH, 'utf8');
    const body = source.slice(
      source.indexOf('cases := []struct'),
      source.indexOf('for _, c := range cases'),
    );
    const row = /\{("(?:[^"\\]|\\.)*"),\s*([\s\S]+?),\s*(true|false)\},/g;
    const repeat = /^strings\.Repeat\(("(?:[^"\\]|\\.)*"),\s*MaxButtonEmojiRunes\)$/;
    const rows: Array<[string, string, boolean]> = [];
    for (const match of body.matchAll(row)) {
      const value = (match[2] as string).trim();
      const repeated = repeat.exec(value);
      let emoji: string;
      if (repeated) {
        emoji = unquoteGo(repeated[1] as string).repeat(MAX_BUTTON_EMOJI_RUNES);
      } else if (value.startsWith('"')) {
        emoji = unquoteGo(value);
      } else {
        throw new Error(`unparsed case value ${value} - the regex is stale`);
      }
      rows.push([unquoteGo(match[1] as string), emoji, match[3] === 'true']);
    }
    return rows;
  };

  it.skipIf(!existsSync(GO_EMOJI_TEST_PATH))(
    "the truth table is still the server's truth table",
    () => {
      const server = parseGoEmojiTable();
      expect(
        server.length,
        'failed to parse TestValidEmoji out of emoji_test.go - the regex is stale',
      ).toBeGreaterThan(0);
      // The server is authoritative (AMENDMENT-06 §3): port the change,
      // re-grade, and never land an SDK check stricter than the server's.
      expect(server).toEqual(SERVER_EMOJI_TABLE);
    },
  );

  it.each(SERVER_EMOJI_TABLE)('%s', (_name, emoji, legal) => {
    if (legal) {
      expect(() => new Button({ label: 'x', emoji })).not.toThrow();
    } else {
      expect(() => new Button({ label: 'x', emoji })).toThrowError(CAP_INVALID_BUTTON_EMOJI);
    }
  });

  it('MAX_BUTTON_EMOJI_RUNES bounds the value before the runes are read one by one', () => {
    // Otherwise-legal sequences either side of the bound, so the only thing
    // that can refuse the second one is the bound itself.
    const atTheBound = '\u{1F468}' + '\u{FE0F}'.repeat(MAX_BUTTON_EMOJI_RUNES - 1);
    expect([...atTheBound]).toHaveLength(MAX_BUTTON_EMOJI_RUNES);
    expect(() => new Button({ label: 'x', emoji: atTheBound })).not.toThrow();

    const past = atTheBound + '\u{FE0F}';
    expect([...past]).toHaveLength(MAX_BUTTON_EMOJI_RUNES + 1);
    expect(() => new Button({ label: 'x', emoji: past })).toThrowError(CAP_INVALID_BUTTON_EMOJI);
  });

  it('a raw object is not a bypass for the emoji check', () => {
    expect(() =>
      serialiseButtons([{ label: 'x', id: 'x', style: 'primary', emoji: 'ab' }]),
    ).toThrowError(CAP_INVALID_BUTTON_EMOJI);
  });

  it('CAP_BUTTON_MISSING_LABEL: an emoji-only button is refused for its label, not its emoji', () => {
    expect(() => new Button({ label: '', emoji: '\u{23F0}' })).toThrowError(
      CAP_BUTTON_MISSING_LABEL,
    );
    expect(() => new Button({ label: '' })).toThrowError(CAP_BUTTON_MISSING_LABEL);
    expect(() => serialiseButtons([{ label: '', id: 'x', style: 'primary' }])).toThrowError(
      CAP_BUTTON_MISSING_LABEL,
    );
  });
});

describe('AMENDMENT-06 — embed footer icon, embed url and author url', () => {
  it('setFooter carries an icon onto the wire', () => {
    const embed = new Embed({ title: 't' }).setFooter(
      'set by deepcuts',
      'https://cdn.aurival.com/dc.png',
    );
    expect(embed.toJSON()['footer']).toEqual({
      text: 'set by deepcuts',
      icon: 'https://cdn.aurival.com/dc.png',
    });
  });

  it('CAP_IMAGE_URL_NOT_HTTPS: a footer icon is an image url and keeps the image sentence', () => {
    expect(() => new Embed().setFooter('t', 'http://cdn.aurival.com/dc.png')).toThrowError(
      CAP_IMAGE_URL_NOT_HTTPS,
    );
    expect(() =>
      serialiseEmbeds([{ title: 't', footer: { text: 'f', icon: 'http://nope' } }]),
    ).toThrowError(CAP_IMAGE_URL_NOT_HTTPS);
  });

  it('CAP_EMBED_FOOTER_TEXT_REQUIRED: an icon-only footer is refused on both paths', () => {
    expect(() => new Embed().setFooter('', 'https://cdn.aurival.com/dc.png')).toThrowError(
      CAP_EMBED_FOOTER_TEXT_REQUIRED,
    );
    expect(() =>
      serialiseEmbeds([{ title: 't', footer: { icon: 'https://cdn.aurival.com/dc.png' } }]),
    ).toThrowError(CAP_EMBED_FOOTER_TEXT_REQUIRED);
  });

  it('embed.url makes the title tappable and survives a round trip', () => {
    const embed = new Embed({ title: "Tonight's set", url: 'https://aurival.com/spaces/deepcuts' });
    expect(embed.toJSON()).toEqual({
      title: "Tonight's set",
      url: 'https://aurival.com/spaces/deepcuts',
    });
    expect(Embed.fromJSON(embed.toJSON()).toJSON()).toEqual(embed.toJSON());
  });

  it('CAP_EMBED_URL_WITHOUT_TITLE: a url with nothing to attach to is refused on both paths', () => {
    expect(() => new Embed({ url: 'https://aurival.com' })).toThrowError(
      CAP_EMBED_URL_WITHOUT_TITLE,
    );
    expect(() => serialiseEmbeds([{ url: 'https://aurival.com' }])).toThrowError(
      CAP_EMBED_URL_WITHOUT_TITLE,
    );
    expect(() => serialiseEmbeds([{ title: '', url: 'https://aurival.com' }])).toThrowError(
      CAP_EMBED_URL_WITHOUT_TITLE,
    );
  });

  it('CAP_LINK_URL_NOT_HTTPS: embed.url is a link target, not an image', () => {
    expect(() => new Embed({ title: 't', url: 'http://aurival.com' })).toThrowError(
      CAP_LINK_URL_NOT_HTTPS,
    );
  });

  it('setAuthor carries a url and survives a round trip', () => {
    const embed = new Embed({ title: 't' }).setAuthor(
      'Deep Cuts',
      'https://cdn.aurival.com/dc.png',
      'https://aurival.com/u/deepcuts',
    );
    expect(embed.toJSON()['author']).toEqual({
      name: 'Deep Cuts',
      icon: 'https://cdn.aurival.com/dc.png',
      url: 'https://aurival.com/u/deepcuts',
    });
    expect(Embed.fromJSON(embed.toJSON()).toJSON()).toEqual(embed.toJSON());
  });

  it('CAP_AUTHOR_URL_WITHOUT_NAME: an author url with no name is refused on both paths', () => {
    expect(() => new Embed().setAuthor('', undefined, 'https://aurival.com')).toThrowError(
      CAP_AUTHOR_URL_WITHOUT_NAME,
    );
    expect(() =>
      serialiseEmbeds([{ title: 't', author: { url: 'https://aurival.com' } }]),
    ).toThrowError(CAP_AUTHOR_URL_WITHOUT_NAME);
  });

  it('CAP_LINK_URL_NOT_HTTPS: an author url is a link target, not an image', () => {
    expect(() => new Embed().setAuthor('Deep Cuts', undefined, 'http://aurival.com')).toThrowError(
      CAP_LINK_URL_NOT_HTTPS,
    );
  });
});

describe('AMENDMENT-06 §9 — a card with none of the new fields is byte-identical to today', () => {
  it('no url, emoji or footer icon key appears anywhere, and none is emitted as null', () => {
    const embeds = serialiseEmbeds([
      new Embed({ title: 'Trivia round 4', description: 'Which ocean is the deepest?' })
        .setAuthor('Quizbot', 'https://cdn.aurival.com/q.png')
        .addField('Players', '6', true)
        .setFooter('Answer within 30s'),
    ]);
    const buttons = serialiseButtons([new Button({ label: 'Pacific' })]);

    expect(embeds).toEqual([
      {
        title: 'Trivia round 4',
        description: 'Which ocean is the deepest?',
        author: { name: 'Quizbot', icon: 'https://cdn.aurival.com/q.png' },
        fields: [{ name: 'Players', value: '6', inline: true }],
        footer: { text: 'Answer within 30s' },
      },
    ]);
    expect(buttons).toEqual([{ id: 'pacific', label: 'Pacific', style: 'primary' }]);
    expect(JSON.stringify({ embeds, buttons })).not.toContain('null');
    expect(JSON.stringify({ embeds, buttons })).not.toContain('"url"');
    expect(JSON.stringify({ embeds, buttons })).not.toContain('"emoji"');
  });
});

/**
 * AMENDMENT-06 §5 fixes the eight new sentences in a table and says they are
 * to be copied byte for byte into this SDK. This reads that table back and
 * compares, so a reworded sentence here is a failing test rather than a
 * mismatch a bot author discovers by getting two different wordings from the
 * two sides of the same refusal.
 *
 * `sdk/` is copied wholesale into the public mirror repo, where
 * `docs/engineering/` does not exist — so the file's absence skips this test
 * rather than reddening the mirror's CI.
 */
const AMENDMENT_PATH = fileURLToPath(
  new URL('../../../docs/engineering/bot-api/AMENDMENT-06.md', import.meta.url),
);

describe('AMENDMENT-06 §5 sentence parity', () => {
  it.skipIf(!existsSync(AMENDMENT_PATH))(
    'every new cap sentence matches the amendment character for character',
    () => {
      const doc = readFileSync(AMENDMENT_PATH, 'utf8');
      const expected: Record<string, string> = {
        link_url_not_https: CAP_LINK_URL_NOT_HTTPS,
        link_url_too_long: CAP_LINK_URL_TOO_LONG,
        link_button_missing_url: CAP_LINK_BUTTON_MISSING_URL,
        url_on_non_link_button: CAP_URL_ON_NON_LINK_BUTTON,
        invalid_button_emoji: CAP_INVALID_BUTTON_EMOJI,
        embed_url_without_title: CAP_EMBED_URL_WITHOUT_TITLE,
        author_url_without_name: CAP_AUTHOR_URL_WITHOUT_NAME,
        embed_footer_text_required: CAP_EMBED_FOOTER_TEXT_REQUIRED,
      };

      const rows = new Map<string, string>();
      for (const line of doc.split('\n')) {
        const match = /^\|\s*`([a-z_]+)`\s*\|\s*`(.+?)`\s*\|$/.exec(line.trim());
        if (match && match[1] !== undefined && match[2] !== undefined) {
          if (match[1] in expected) rows.set(match[1], match[2]);
        }
      }

      expect([...rows.keys()].sort()).toEqual(Object.keys(expected).sort());
      for (const [code, sentence] of rows) {
        // The doc templates the one sentence that names a number; the SDK
        // renders it from the constant, as it does every other numeric cap.
        const rendered = sentence.replace('{max}', String(MAX_LINK_URL_RUNES));
        expect(rendered).toBe(expected[code]);
      }
    },
  );

  it.skipIf(!existsSync(AMENDMENT_PATH))(
    'the changed button-style sentence matches §5 and the retired one is gone from src/',
    () => {
      const doc = readFileSync(AMENDMENT_PATH, 'utf8');
      expect(doc).toContain(CAP_BAD_BUTTON_STYLE);
      expect(CAP_BAD_BUTTON_STYLE).toBe(
        'a button style must be one of primary, secondary, danger, link',
      );

      const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
      const sources = readdirSync(srcDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(join(srcDir, name), 'utf8'))
        .join('\n');
      expect(sources).not.toContain('link buttons are not supported in v1');
    },
  );
});
