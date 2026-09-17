/**
 * AMENDMENT-07 §10's js SDK contract tests: editing a card in place, and an
 * ack that carries its replacement.
 *
 * Everything here asserts the REQUEST BYTES, not the SDK's own idea of what it
 * sent — the whole point of §9's three states is that `undefined`, `null` and
 * `[]` reach the wire as three different things, and only the raw body proves
 * it. The scaffolding is `test/events.test.ts`'s: a real `node:http` server per
 * test, never a fetch mock, extended with the raw request string so
 * "no body at all" can be told apart from `{}`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ButtonContext, Context, Event, type EditInit } from '../src/events.js';
import { Button, Embed } from '../src/embeds.js';
import { NOTHING_TO_EDIT } from '../src/caps.js';
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
  /** The body EXACTLY as it arrived. `''` is "no body was sent at all". */
  raw: string;
  body: unknown;
}

async function startServer(
  handler: (res: ServerResponse, captured: CapturedRequest) => void,
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
        raw,
        body,
      };
      requests.push(captured);
      handler(res, captured);
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

/** The stored message a PATCH answers with — shape is irrelevant to these tests, only the request is. */
const EDITED_WIRE = {
  id: 'msg_1',
  text: 'edited',
  sent_at: '2026-09-17T00:00:00Z',
  sender: { id: 'usr_bot', handle: '', name: '' },
  reply_to: null,
};

function first(requests: CapturedRequest[]): CapturedRequest {
  const req = requests[0];
  if (req === undefined) throw new Error('expected exactly one captured request');
  return req;
}

/** A `Context` whose http points at the given fake server. */
function contextAt(url: string): Context {
  const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
  return Context.fromEvent(
    Event.fromFrame({
      id: 'evt_1',
      type: 'command.invoked',
      created_at: '2026-09-17T00:00:00Z',
      sequence: 1,
      data: {
        command: 'ping',
        arguments: '',
        chat: { id: 'chat_1', type: 'dm', name: null },
        sender: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
        message: 'msg_invocation',
      },
    }),
    http,
  );
}

/** A `ButtonContext` whose http points at the given fake server. */
function buttonContextAt(url: string): ButtonContext {
  const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
  return ButtonContext.fromEvent(
    Event.fromFrame({
      id: 'evt_2',
      type: 'button.pressed',
      created_at: '2026-09-17T00:00:00Z',
      sequence: 2,
      data: {
        chat: { id: 'chat_1', type: 'dm', name: null },
        user: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
        message: 'msg_1',
        button: 'jupiter',
        interaction: 'evt_01J9',
      },
    }),
    http,
  );
}

/** Runs one `edit` against a fake PATCH endpoint and hands back what arrived. */
async function captureEdit(
  run: (ctx: Context) => Promise<unknown>,
): Promise<CapturedRequest> {
  const { url, server, requests } = await startServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(EDITED_WIRE));
  });
  openServers.push(server);
  await run(contextAt(url));
  expect(requests).toHaveLength(1);
  return first(requests);
}

/** Runs one `ack` against a fake 204 endpoint and hands back what arrived. */
async function captureAck(run: (ctx: ButtonContext) => Promise<void>): Promise<CapturedRequest> {
  const { url, server, requests } = await startServer((res) => {
    res.writeHead(204);
    res.end();
  });
  openServers.push(server);
  await run(buttonContextAt(url));
  expect(requests).toHaveLength(1);
  return first(requests);
}

describe('ctx.edit — one part at a time (AMENDMENT-07 §2)', () => {
  it('text alone sends only `text`, and the route/method are unchanged', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { text: 'done!' }));
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/v1/messages/msg_1');
    expect(req.body).toEqual({ text: 'done!' });
  });

  it('embeds alone sends only `embeds`, serialised exactly as send serialises them', async () => {
    const req = await captureEdit((ctx) =>
      ctx.edit('msg_1', {
        embeds: [new Embed({ title: 'Jupiter', color: '#3E6E8E' }).addField('Answered by', 'Gustav', true)],
      }),
    );
    expect(req.body).toEqual({
      embeds: [
        {
          title: 'Jupiter',
          color: '#3E6E8E',
          fields: [{ name: 'Answered by', value: 'Gustav', inline: true }],
        },
      ],
    });
  });

  it('buttons alone sends only `buttons`', async () => {
    const req = await captureEdit((ctx) =>
      ctx.edit('msg_1', { buttons: [new Button({ id: 'again', label: 'Play again' })] }),
    );
    expect(req.body).toEqual({
      buttons: [{ id: 'again', label: 'Play again', style: 'primary' }],
    });
  });

  it('a part not passed is ABSENT from the body, never null — §2 reads absent as "keep it"', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { text: 'only words' }));
    const body = req.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['text']);
    expect('embeds' in body).toBe(false);
    expect('buttons' in body).toBe(false);
  });
});

describe('ctx.edit — clearing a part (AMENDMENT-07 §9)', () => {
  it('`embeds: []` puts null on the wire', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { embeds: [] }));
    expect(req.raw).toBe('{"embeds":null}');
    expect(req.body).toEqual({ embeds: null });
  });

  it('`embeds: null` puts null on the wire', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { embeds: null }));
    expect(req.raw).toBe('{"embeds":null}');
  });

  it('`buttons: []` puts null on the wire', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { buttons: [] }));
    expect(req.raw).toBe('{"buttons":null}');
  });

  it('`buttons: null` puts null on the wire', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { buttons: null }));
    expect(req.raw).toBe('{"buttons":null}');
  });

  it('clearing both at once leaves the card with its text (§2: a message never loses its card)', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { embeds: [], buttons: null }));
    expect(req.body).toEqual({ embeds: null, buttons: null });
  });
});

describe('ctx.edit — empty text is a value, not an omission (AMENDMENT-07 §2)', () => {
  it("`text: ''` is PRESENT in the body and does not throw", async () => {
    const req = await captureEdit((ctx) =>
      ctx.edit('msg_1', { text: '', embeds: [new Embed({ title: 'Jupiter' })] }),
    );
    const body = req.body as Record<string, unknown>;
    expect('text' in body).toBe(true);
    expect(body['text']).toBe('');
  });

  it("`text: ''` alone is sent, NOT refused by the send-side EMPTY_MESSAGE guard", async () => {
    // The server checks emptiness on the MERGED card (§2), which the SDK
    // cannot see — so the precondition that guards `send` must not run here.
    const req = await captureEdit((ctx) => ctx.edit('msg_1', { text: '' }));
    expect(req.raw).toBe('{"text":""}');
  });

  it('the bare string form still means `{ text }`, byte for byte as in 0.5.0', async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', 'done!'));
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/v1/messages/msg_1');
    expect(req.raw).toBe('{"text":"done!"}');
  });

  it("the string form accepts '' too, and sends it", async () => {
    const req = await captureEdit((ctx) => ctx.edit('msg_1', ''));
    expect(req.raw).toBe('{"text":""}');
  });
});

describe('ctx.edit — nothing to edit (AMENDMENT-07 §7)', () => {
  const sentence = 'an edit needs text, embeds or buttons';

  it('the sentence constant is byte-identical to the spec table', () => {
    expect(NOTHING_TO_EDIT).toBe(sentence);
  });

  it('`edit(msg)` with no second argument throws before any request', async () => {
    const { url, server, requests } = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(EDITED_WIRE));
    });
    openServers.push(server);
    await expect(contextAt(url).edit('msg_1')).rejects.toThrow(sentence);
    expect(requests).toHaveLength(0);
  });

  it('`edit(msg, {})` throws the same sentence, and sends nothing', async () => {
    const { url, server, requests } = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(EDITED_WIRE));
    });
    openServers.push(server);
    await expect(contextAt(url).edit('msg_1', {})).rejects.toThrow(sentence);
    expect(requests).toHaveLength(0);
  });
});

describe('ctx.ack — the §8 trivia round', () => {
  it('a body carrying all three parts is posted to the ack route as one request', async () => {
    const req = await captureAck((ctx) =>
      ctx.ack({
        text: '',
        embeds: [
          new Embed({
            title: 'Jupiter',
            color: '#3E6E8E',
            description: 'Correct. It is about **eleven** Earths across.',
          }).addField('Answered by', 'Gustav', true),
        ],
        buttons: [new Button({ id: 'again', label: 'Play again', style: 'primary' })],
      }),
    );
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/interactions/evt_01J9/ack');
    expect(req.body).toEqual({
      text: '',
      embeds: [
        {
          title: 'Jupiter',
          color: '#3E6E8E',
          description: 'Correct. It is about **eleven** Earths across.',
          fields: [{ name: 'Answered by', value: 'Gustav', inline: true }],
        },
      ],
      buttons: [{ id: 'again', label: 'Play again', style: 'primary' }],
    });
  });

  it('clearing works on ack exactly as on edit', async () => {
    const req = await captureAck((ctx) => ctx.ack({ buttons: [] }));
    expect(req.raw).toBe('{"buttons":null}');
  });

  it("an ack body may be `text: ''` alone — there is no emptiness precondition here", async () => {
    const req = await captureAck((ctx) => ctx.ack({ text: '' }));
    expect(req.raw).toBe('{"text":""}');
  });
});

describe('ctx.ack() with no argument is byte-identical to 0.5.0 (AMENDMENT-07 §3)', () => {
  it('sends NO body at all — not `{}` — and no content-type header', async () => {
    const req = await captureAck((ctx) => ctx.ack());
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/interactions/evt_01J9/ack');
    // The RAW request, not the parsed one: `{}` would also parse to an empty
    // object, and the two are different bytes on the wire.
    expect(req.raw).toBe('');
    expect(req.headers['content-type']).toBeUndefined();
    // A bodyless POST still carries `content-length: 0` — that is Node's
    // fetch, not the SDK, and 0.5.0's bare ack sent the same. `content-type`
    // is the discriminator: `request()` only sets it alongside a body.
    expect(req.headers['content-length']).toBe('0');
    // The idempotency key is still sent, as it was in 0.5.0.
    expect(typeof req.headers['idempotency-key']).toBe('string');
  });

  it('`ack({})` also sends no body — an empty init is not a card replacement', async () => {
    const req = await captureAck((ctx) => ctx.ack({}));
    expect(req.raw).toBe('');
  });
});

describe('the §9 signatures, pinned', () => {
  // Type-level: these assertions are checked by `tsc --noEmit`, not at runtime.
  // The second argument of the init form is exactly §9's object, every key
  // optional, with `null` legal on the two clearable parts and NOT on `text`.
  const initForm = {
    text: '',
    embeds: null,
    buttons: null,
  } satisfies EditInit;

  const arrayForm = {
    embeds: [new Embed({ title: 'a' })],
    buttons: [new Button({ id: 'b', label: 'b' })],
  } satisfies EditInit;

  const plainObjectForm = {
    embeds: [{ title: 'a' }],
    buttons: [{ id: 'b', label: 'b' }],
  } satisfies EditInit;

  type EditSecondArgument = Parameters<Context['edit']>[1];
  type AckArgument = Parameters<ButtonContext['ack']>[0];

  it('`EditInit` accepts §9\'s three shapes: clears, builders, and plain objects', () => {
    expect(initForm.text).toBe('');
    expect(arrayForm.embeds).toHaveLength(1);
    expect(plainObjectForm.buttons).toHaveLength(1);
  });

  it('edit is (message, textOrInit) and ack is (init) at runtime', () => {
    // `Function.length` counts declared parameters up to the first default or
    // rest: TypeScript's `?` emits no default, so the optional tails still
    // count. Optionality itself is proven above, by the calls that omit them —
    // `ctx.ack()` reaching the server and `ctx.edit(msg)` throwing
    // NOTHING_TO_EDIT rather than a TypeError.
    expect(Context.prototype.edit.length).toBe(2);
    expect(ButtonContext.prototype.ack.length).toBe(1);
  });

  it('the init type is assignable from both an EditInit and a bare string on edit', async () => {
    const asInit: EditSecondArgument = initForm;
    const asString: EditSecondArgument | string = 'done!';
    const ackArg: AckArgument = { text: 'ok' };
    expect(asInit).toBe(initForm);
    expect(asString).toBe('done!');
    expect(ackArg.text).toBe('ok');
  });
});
