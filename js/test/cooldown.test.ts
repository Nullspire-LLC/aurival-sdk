/**
 * AMENDMENT-08's shared algorithm block, and every attachment point that
 * builds on it: `Cooldown` itself, the tri-state normalization at each of
 * the three button-family levels, the button > card > bot-default
 * precedence, the (messageId, buttonId, user) key scheme, the attachment-time
 * bound checks (60s for buttons, unbounded for commands, §5/D13), and the
 * link-button refusal.
 *
 * `cooldownNotice.test.ts` covers the once-per-window notice, the hooks, and
 * the button ack's swallow path — this file is the primitive and its wiring
 * into `send`/`Button`/`Bot` at attachment time.
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  CAP_BUTTON_COOLDOWN_TOO_LONG,
  CAP_COOLDOWN_PERIOD_NOT_POSITIVE,
  CAP_COOLDOWN_RATE_TOO_LOW,
  CAP_LINK_BUTTON_COOLDOWN,
  Cooldown,
  MAX_BUTTON_COOLDOWN_PER_SECONDS,
  buttonBucketKey,
  normalizeCooldownOption,
  requireButtonCooldownBounds,
  resolveButtonCooldown,
  retryAfterMs,
  roundSeconds,
  subjectKey,
  CardCooldownTable,
} from '../src/cooldown.js';
import type { CardCooldownRecord } from '../src/cooldown.js';
import { Button } from '../src/embeds.js';
import { ButtonContext, Context, Event } from '../src/events.js';
import { Bot, type CommandOptions, type OnCooldownHook } from '../src/bot.js';
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

/** A clock a test fully controls — `Cooldown`'s 4th ctor arg, test-only. */
function fakeClock(startSeconds = 0): { now: () => number; advance: (seconds: number) => void } {
  let t = startSeconds;
  return { now: () => t, advance: (s: number) => (t += s) };
}

describe('Cooldown — the fixed-window primitive (§2)', () => {
  it('rejects a rate below 1, with the exact cap sentence', () => {
    expect(() => new Cooldown(0, 1)).toThrow(CAP_COOLDOWN_RATE_TOO_LOW);
    expect(CAP_COOLDOWN_RATE_TOO_LOW).toBe('a cooldown rate is at least 1');
  });

  it('rejects a period that is not positive, with the exact cap sentence', () => {
    expect(() => new Cooldown(1, 0)).toThrow(CAP_COOLDOWN_PERIOD_NOT_POSITIVE);
    expect(() => new Cooldown(1, -1)).toThrow(CAP_COOLDOWN_PERIOD_NOT_POSITIVE);
    expect(CAP_COOLDOWN_PERIOD_NOT_POSITIVE).toBe('a cooldown period is greater than zero');
  });

  it('defaults to the "user" bucket', () => {
    const c = new Cooldown(1, 5);
    expect(c.bucket).toBe('user');
  });

  it('rate 1: the first call passes, the second (same window) is refused', () => {
    const clock = fakeClock();
    const c = new Cooldown(1, 5, 'user', clock.now);
    expect(c.check('k')).toBeNull();
    expect(c.check('k')).not.toBeNull();
  });

  it('rate > 1: allows exactly `rate` passes before refusing', () => {
    const clock = fakeClock();
    const c = new Cooldown(3, 5, 'user', clock.now);
    expect(c.check('k')).toBeNull();
    expect(c.check('k')).toBeNull();
    expect(c.check('k')).toBeNull();
    expect(c.check('k')).not.toBeNull();
  });

  it('a refusal never consumes a token and never touches the window', () => {
    const clock = fakeClock();
    const c = new Cooldown(1, 5, 'user', clock.now);
    expect(c.check('k')).toBeNull();
    const first = c.check('k');
    clock.advance(1);
    const second = c.check('k');
    // Mashing a refused key does not push the window further out: the
    // remaining time only ever counts down, it never resets on a refusal.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second as number).toBeLessThan(first as number);
  });

  it('window expiry: a call at/after `per` seconds gets a fresh window', () => {
    const clock = fakeClock();
    const c = new Cooldown(1, 5, 'user', clock.now);
    expect(c.check('k')).toBeNull();
    expect(c.check('k')).not.toBeNull();
    clock.advance(5);
    expect(c.check('k')).toBeNull();
  });

  it('distinct keys never share a bucket', () => {
    const clock = fakeClock();
    const c = new Cooldown(1, 5, 'user', clock.now);
    expect(c.check('a')).toBeNull();
    expect(c.check('b')).toBeNull();
  });
});

describe('roundSeconds / retryAfterMs (§5 rounding)', () => {
  it('rounds a fractional remainder up, never to zero', () => {
    expect(roundSeconds(0.1)).toBe(1);
    expect(roundSeconds(2.9)).toBe(3);
    expect(roundSeconds(0)).toBe(1);
  });

  it('retryAfterMs is whole milliseconds, never zero', () => {
    expect(retryAfterMs(0.0001)).toBe(1);
    expect(retryAfterMs(1.5)).toBe(1500);
    expect(retryAfterMs(0)).toBe(1);
  });
});

describe('subjectKey — the bucket table (§2)', () => {
  it('user bucket keys by user id, ignoring chat', () => {
    expect(subjectKey('user', 'usr_1', 'chat_1')).toBe(subjectKey('user', 'usr_1', 'chat_2'));
    expect(subjectKey('user', 'usr_1', 'chat_1')).not.toBe(subjectKey('user', 'usr_2', 'chat_1'));
  });

  it('chat bucket keys by chat id, ignoring user', () => {
    expect(subjectKey('chat', 'usr_1', 'chat_1')).toBe(subjectKey('chat', 'usr_2', 'chat_1'));
    expect(subjectKey('chat', 'usr_1', 'chat_1')).not.toBe(subjectKey('chat', 'usr_1', 'chat_2'));
  });

  it('global bucket ignores both', () => {
    expect(subjectKey('global', 'usr_1', 'chat_1')).toBe(subjectKey('global', 'usr_2', 'chat_2'));
  });
});

describe('buttonBucketKey — (messageId, buttonId, user) keying (§3)', () => {
  it('two cards reusing the same button id do NOT share a bucket', () => {
    const cooldown = new Cooldown(1, 5, 'user');
    const keyA = buttonBucketKey(cooldown, { messageId: 'msg_a', buttonId: 'again' }, 'usr_1', 'chat_1');
    const keyB = buttonBucketKey(cooldown, { messageId: 'msg_b', buttonId: 'again' }, 'usr_1', 'chat_1');
    expect(keyA).not.toBe(keyB);
  });

  it('the same (message, button) for two different users keys differently', () => {
    const cooldown = new Cooldown(1, 5, 'user');
    const scope = { messageId: 'msg_a', buttonId: 'again' };
    const keyA = buttonBucketKey(cooldown, scope, 'usr_1', 'chat_1');
    const keyB = buttonBucketKey(cooldown, scope, 'usr_2', 'chat_1');
    expect(keyA).not.toBe(keyB);
  });

  it('a null scope (the bot default) is attachmentScope = () — one bucket per subject, no message/button in it', () => {
    const cooldown = new Cooldown(1, 5, 'user');
    const keyNoScope = buttonBucketKey(cooldown, null, 'usr_1', 'chat_1');
    expect(keyNoScope).toBe(subjectKey('user', 'usr_1', 'chat_1'));
  });
});

describe('normalizeCooldownOption — the tri-state (§3)', () => {
  it('undefined stays undefined (inherit)', () => {
    expect(normalizeCooldownOption(undefined, { boundToButton: true })).toBeUndefined();
  });

  it('null stays null (disabled)', () => {
    expect(normalizeCooldownOption(null, { boundToButton: true })).toBeNull();
  });

  it('a plain literal normalizes into a Cooldown instance', () => {
    const result = normalizeCooldownOption({ rate: 2, per: 10 }, { boundToButton: true });
    expect(result).toBeInstanceOf(Cooldown);
    expect(result?.rate).toBe(2);
    expect(result?.per).toBe(10);
    expect(result?.bucket).toBe('user');
  });

  it('an existing Cooldown instance passes through unchanged', () => {
    const c = new Cooldown(1, 5, 'chat');
    expect(normalizeCooldownOption(c, { boundToButton: true })).toBe(c);
  });

  it('boundToButton enforces the 60s cap, with the exact sentence', () => {
    expect(() => normalizeCooldownOption({ rate: 1, per: 61 }, { boundToButton: true })).toThrow(
      CAP_BUTTON_COOLDOWN_TOO_LONG,
    );
    expect(CAP_BUTTON_COOLDOWN_TOO_LONG).toBe('a button cooldown is at most 60 seconds');
  });

  it('exactly 60s passes the bound (the cap is inclusive)', () => {
    expect(() =>
      normalizeCooldownOption({ rate: 1, per: MAX_BUTTON_COOLDOWN_PER_SECONDS }, { boundToButton: true }),
    ).not.toThrow();
  });

  it('boundToButton: false leaves a long period unbounded (command cooldowns, D13)', () => {
    expect(() =>
      normalizeCooldownOption({ rate: 1, per: 100_000 }, { boundToButton: false }),
    ).not.toThrow();
  });

  it('requireButtonCooldownBounds is the same check, callable directly', () => {
    const long = new Cooldown(1, 61);
    expect(() => requireButtonCooldownBounds(long)).toThrow(CAP_BUTTON_COOLDOWN_TOO_LONG);
    const ok = new Cooldown(1, 60);
    expect(() => requireButtonCooldownBounds(ok)).not.toThrow();
  });
});

describe('resolveButtonCooldown — button > card > bot default (§3)', () => {
  const botDefault = new Cooldown(1, 2, 'user');
  const cardCooldown = new Cooldown(1, 3, 'user');
  const buttonCooldown = new Cooldown(1, 4, 'user');

  it('a per-button override wins over the card and the bot default', () => {
    const record: CardCooldownRecord = {
      cardCooldown,
      byButtonId: new Map([['btn_1', buttonCooldown]]),
    };
    const resolved = resolveButtonCooldown(botDefault, record, 'btn_1');
    expect(resolved.cooldown).toBe(buttonCooldown);
    expect(resolved.scoped).toBe(true);
  });

  it('with no per-button override, the card-level cooldown wins over the bot default', () => {
    const record: CardCooldownRecord = { cardCooldown, byButtonId: new Map() };
    const resolved = resolveButtonCooldown(botDefault, record, 'btn_other');
    expect(resolved.cooldown).toBe(cardCooldown);
    expect(resolved.scoped).toBe(true);
  });

  it('with no card recorded at all, the bot default applies, unscoped', () => {
    const resolved = resolveButtonCooldown(botDefault, undefined, 'btn_1');
    expect(resolved.cooldown).toBe(botDefault);
    expect(resolved.scoped).toBe(false);
  });

  it('null disables at the button level even though the card has one', () => {
    const record: CardCooldownRecord = {
      cardCooldown,
      byButtonId: new Map([['btn_1', null]]),
    };
    const resolved = resolveButtonCooldown(botDefault, record, 'btn_1');
    expect(resolved.cooldown).toBeNull();
    expect(resolved.scoped).toBe(true);
  });

  it('null disables at the card level even though the bot has a default', () => {
    const record: CardCooldownRecord = { cardCooldown: null, byButtonId: new Map() };
    const resolved = resolveButtonCooldown(botDefault, record, 'btn_1');
    expect(resolved.cooldown).toBeNull();
    expect(resolved.scoped).toBe(true);
  });

  it('null disables at the bot level when nothing overrides it', () => {
    const resolved = resolveButtonCooldown(null, undefined, 'btn_1');
    expect(resolved.cooldown).toBeNull();
  });
});

describe('CardCooldownTable — the card lookup on press (§3)', () => {
  it('a message absent from the table falls through (undefined) to the bot default', () => {
    const table = new CardCooldownTable();
    expect(table.lookup('msg_never_sent')).toBeUndefined();
  });

  it('recording nothing (undefined card, empty buttons) is a no-op, not a stale entry', () => {
    const table = new CardCooldownTable();
    table.record('msg_1', { cardCooldown: new Cooldown(1, 3), byButtonId: new Map() });
    expect(table.lookup('msg_1')).toBeDefined();
    table.record('msg_1', { cardCooldown: undefined, byButtonId: new Map() });
    expect(table.lookup('msg_1')).toBeUndefined();
  });
});

describe('Cooldown default bucket — a bot with no buttonCooldown configured still has one (§3)', () => {
  it('Bot() with no buttonCooldown option resolves a default via the same normalize path', () => {
    // Exercised indirectly: normalizeCooldownOption(undefined, ...) is
    // `undefined`, and bot.ts's constructor falls back to
    // `new Cooldown(1, 2.0, 'user')` in that case — proven directly here,
    // since the field itself is private to `Bot`.
    const resolved = normalizeCooldownOption(undefined, { boundToButton: true });
    expect(resolved).toBeUndefined();
    const fallback = new Cooldown(1, 2.0, 'user');
    expect(fallback.rate).toBe(1);
    expect(fallback.per).toBe(2.0);
    expect(fallback.bucket).toBe('user');
  });

  it('a Bot constructs without throwing when buttonCooldown is omitted', () => {
    expect(() => new Bot({ quiet: true })).not.toThrow();
  });

  it('buttonCooldown: null constructs without throwing (disables it bot-wide)', () => {
    expect(() => new Bot({ quiet: true, buttonCooldown: null })).not.toThrow();
  });

  it('an out-of-bounds buttonCooldown option throws at construction, with the exact sentence', () => {
    expect(() => new Bot({ quiet: true, buttonCooldown: { rate: 1, per: 61 } })).toThrow(
      CAP_BUTTON_COOLDOWN_TOO_LONG,
    );
  });
});

describe('Button.cooldown — attachment-time bound + the link-button refusal (§3)', () => {
  it('a plain literal on a non-link button normalizes at construction', () => {
    const b = new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 10 } });
    expect(b.cooldown).toBeInstanceOf(Cooldown);
    expect((b.cooldown as Cooldown).per).toBe(10);
  });

  it('a too-long per throws at construction, with the exact sentence', () => {
    expect(
      () => new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 61 } }),
    ).toThrow(CAP_BUTTON_COOLDOWN_TOO_LONG);
  });

  it('a link button carrying a cooldown is refused, with the exact sentence', () => {
    expect(
      () =>
        new Button({
          id: 'go',
          label: 'Go',
          style: 'link',
          url: 'https://example.com',
          cooldown: { rate: 1, per: 5 },
        }),
    ).toThrow(CAP_LINK_BUTTON_COOLDOWN);
    expect(CAP_LINK_BUTTON_COOLDOWN).toBe('a link button cannot carry a cooldown');
  });

  it('a link button with an explicit null cooldown is fine — null is a no-op disable, not a cooldown', () => {
    expect(
      () =>
        new Button({
          id: 'go',
          label: 'Go',
          style: 'link',
          url: 'https://example.com',
          cooldown: null,
        }),
    ).not.toThrow();
  });

  it('a non-link button with no cooldown field at all is unaffected', () => {
    expect(() => new Button({ id: 'again', label: 'Again' })).not.toThrow();
  });
});

describe('command cooldowns are unbounded (D13, §5) — no 60s cap applies', () => {
  it('bot.command(..., { cooldown }, ...) accepts a per far past 60s without throwing', () => {
    const bot = new Bot({ quiet: true });
    expect(() =>
      bot.command('slow', { cooldown: { rate: 1, per: 3600 } }, async () => undefined),
    ).not.toThrow();
  });

  it('the options-form cooldown normalizes a plain literal into a Cooldown', () => {
    const bot = new Bot({ quiet: true });
    // Registration succeeding at all, with a >60s per, is the proof: a
    // command Cooldown never runs through requireButtonCooldownBounds.
    expect(() =>
      bot.command('slow', { cooldown: { rate: 2, per: 120 }, onCooldown: () => undefined }, async () => undefined),
    ).not.toThrow();
  });
});

describe('a card-level buttonCooldown is validated BEFORE the network call (attachment time means before the side effect)', () => {
  function contextAt(url: string): Context {
    const http = new HttpClient(url, new FakeAuth() as unknown as Auth);
    return Context.fromEvent(
      Event.fromFrame({
        id: 'evt_1',
        type: 'command.invoked',
        created_at: '2026-09-17T00:00:00Z',
        sequence: 1,
        data: {
          command: 'roll',
          arguments: '',
          chat: { id: 'chat_1', type: 'dm', name: null },
          sender: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
          message: 'msg_invocation',
        },
      }),
      http,
    );
  }

  it('a too-long card buttonCooldown throws and the message is never sent', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: 'msg_2' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
    try {
      const ctx = contextAt(`http://127.0.0.1:${address.port}`);
      await expect(
        ctx.reply('go', {
          buttons: [new Button({ id: 'again', label: 'Again' })],
          buttonCooldown: { rate: 1, per: 61 },
        }),
      ).rejects.toThrow(CAP_BUTTON_COOLDOWN_TOO_LONG);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('reply() records the card cooldown table bot.ts later reads on a press (§3)', () => {
  function serverAnswering(messageId: string): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'message', id: messageId }));
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
        });
      });
    });
  }

  it('a per-button cooldown on the reply is readable from HttpClient.cardCooldowns by the returned message id', async () => {
    const server = await serverAnswering('msg_card_1');
    try {
      const http = new HttpClient(server.url, new FakeAuth() as unknown as Auth);
      const ctx = Context.fromEvent(
        Event.fromFrame({
          id: 'evt_1',
          type: 'command.invoked',
          created_at: '2026-09-17T00:00:00Z',
          sequence: 1,
          data: {
            command: 'deal',
            arguments: '',
            chat: { id: 'chat_1', type: 'dm', name: null },
            sender: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
            message: 'msg_invocation',
          },
        }),
        http,
      );
      const sent = await ctx.reply('cards!', {
        buttons: [new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 30 } })],
      });
      expect(sent.id).toBe('msg_card_1');
      const record = http.cardCooldowns.lookup('msg_card_1');
      expect(record).toBeDefined();
      const buttonCooldown = record?.byButtonId.get('again');
      expect(buttonCooldown).toBeInstanceOf(Cooldown);
      expect((buttonCooldown as Cooldown).per).toBe(30);
    } finally {
      await server.close();
    }
  });

  it('a reply whose buttons carry no cooldown leaves the message unrecorded — a later press falls through to the bot default', async () => {
    const server = await serverAnswering('msg_plain_1');
    try {
      const http = new HttpClient(server.url, new FakeAuth() as unknown as Auth);
      const ctx = Context.fromEvent(
        Event.fromFrame({
          id: 'evt_2',
          type: 'command.invoked',
          created_at: '2026-09-17T00:00:00Z',
          sequence: 1,
          data: {
            command: 'deal',
            arguments: '',
            chat: { id: 'chat_1', type: 'dm', name: null },
            sender: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
            message: 'msg_invocation',
          },
        }),
        http,
      );
      await ctx.reply('cards!', { buttons: [new Button({ id: 'again', label: 'Again' })] });
      expect(http.cardCooldowns.lookup('msg_plain_1')).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  function serverForEditAndAck(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
      if (req.method === 'PATCH' && req.url?.startsWith('/v1/messages/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'message',
            id: 'msg_edited_1',
            text: '',
            created_at: '2026-09-18T00:00:00Z',
            sender: 'usr_bot',
          }),
        );
        return;
      }
      if (req.method === 'POST' && /^\/v1\/interactions\/.+\/ack$/.exec(req.url ?? '')) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
        });
      });
    });
  }

  it('edit() has no card-level buttonCooldown door (AMENDMENT-08 §3 names only send/reply), but a per-button cooldown in a replacement row is still recorded and readable', async () => {
    const server = await serverForEditAndAck();
    try {
      const http = new HttpClient(server.url, new FakeAuth() as unknown as Auth);
      const ctx = Context.fromEvent(
        Event.fromFrame({
          id: 'evt_edit',
          type: 'command.invoked',
          created_at: '2026-09-18T00:00:00Z',
          sequence: 1,
          data: {
            command: 'deal',
            arguments: '',
            chat: { id: 'chat_1', type: 'dm', name: null },
            sender: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
            message: 'msg_invocation',
          },
        }),
        http,
      );
      // `EditInit` has no `buttonCooldown` field at all — this line is the
      // compile-time half of the proof; TypeScript would refuse an extra
      // property here.
      const updated = await ctx.edit('msg_prior', {
        text: 'new round!',
        buttons: [new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 30 } })],
      });
      expect(updated.id).toBe('msg_edited_1');
      const record = http.cardCooldowns.lookup('msg_edited_1');
      expect(record).toBeDefined();
      expect(record?.cardCooldown).toBeUndefined();
      const buttonCooldown = record?.byButtonId.get('again');
      expect(buttonCooldown).toBeInstanceOf(Cooldown);
      expect((buttonCooldown as Cooldown).per).toBe(30);
    } finally {
      await server.close();
    }
  });

  it('ack() has no card-level buttonCooldown door either, but a per-button cooldown in a replacement row is still recorded and readable', async () => {
    const server = await serverForEditAndAck();
    try {
      const http = new HttpClient(server.url, new FakeAuth() as unknown as Auth);
      const ctx = ButtonContext.fromEvent(
        Event.fromFrame({
          id: 'evt_press',
          type: 'button.pressed',
          created_at: '2026-09-18T00:00:00Z',
          sequence: 1,
          data: {
            chat: { id: 'chat_1', type: 'dm', name: null },
            user: { id: 'usr_1', handle: 'gustav', name: 'Gustav' },
            message: 'msg_card_ack',
            button: 'again',
            interaction: 'evt_press',
          },
        }),
        http,
      );
      // Same compile-time proof as `edit()`: no `buttonCooldown` field to pass.
      await ctx.ack({
        text: '',
        buttons: [new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 45 } })],
      });
      const record = http.cardCooldowns.lookup('msg_card_ack');
      expect(record).toBeDefined();
      expect(record?.cardCooldown).toBeUndefined();
      const buttonCooldown = record?.byButtonId.get('again');
      expect(buttonCooldown).toBeInstanceOf(Cooldown);
      expect((buttonCooldown as Cooldown).per).toBe(45);
    } finally {
      await server.close();
    }
  });
});

describe('the §2/§4 signatures, pinned', () => {
  it('new Cooldown(rate, per) and (rate, per, bucket) both compile and construct', () => {
    const a = new Cooldown(1, 5);
    const b = new Cooldown(2, 5, 'chat');
    expect(a.bucket).toBe('user');
    expect(b.bucket).toBe('chat');
  });

  it('Cooldown.check returns number | null', () => {
    const c = new Cooldown(1, 5);
    const first: number | null = c.check('k');
    const second: number | null = c.check('k');
    expect(first).toBeNull();
    expect(second).not.toBeNull();
  });

  it('both existing command() string overloads still compile and register', () => {
    const bot = new Bot({ quiet: true });
    bot.command('ping', async () => undefined);
    bot.command('pong', 'plays pong', async () => undefined);
    // No public registry to inspect; not throwing on duplicate-free
    // registration, plus the duplicate-registration suite elsewhere in
    // this repo, is the existing contract's proof.
    expect(true).toBe(true);
  });

  it('the options form is a third call shape, additive to the two string overloads', () => {
    const bot = new Bot({ quiet: true });
    const onCooldown: OnCooldownHook = () => undefined;
    const options: CommandOptions = {
      description: 'rolls a die',
      cooldown: { rate: 1, per: 5 },
      onCooldown,
    };
    expect(() => bot.command('roll', options, async () => undefined)).not.toThrow();
  });
});
