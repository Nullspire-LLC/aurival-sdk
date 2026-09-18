/**
 * AMENDMENT-08 §4/§5's dispatch-level wiring, end to end over a real gateway
 * connection (same scaffolding as `bot.test.ts`'s `Bot#on`/`Bot#command`
 * suites) — the once-per-window command notice, the hooks that replace it,
 * and the button press's automatic cooldown ack, including its silent
 * swallow of `button_already_used`/`not_found` (the cross-lane ruling) and
 * the socket-level ack that still happens for a refused press.
 *
 * `cooldown.test.ts` covers the primitive itself and every attachment-time
 * bound check; this file is what happens when a real press or invocation
 * comes down the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bot } from '../src/bot.js';
import { Button } from '../src/embeds.js';
import type { Context } from '../src/events.js';
import { CooldownRetryAfterInvalid } from '../src/errors.js';
import { KeyFile, MachineKey, type Machine } from '../src/auth.js';
import { COMMAND_COOLDOWN_NOTICE_TEMPLATE, commandCooldownNotice } from '../src/caps.js';
import { sendHello, startGateway, waitUntil, type Script } from './wsserver.js';

let stderrLines: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrLines = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    stderrLines.push(String(line));
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

function commandInvokedEventFor(
  eventId: string,
  command: string,
  sequence: number,
  sender: { id: string; handle?: string; name?: string } = { id: 'user_1' },
): Record<string, unknown> {
  return {
    op: 'event',
    d: {
      object: 'event',
      id: eventId,
      type: 'command.invoked',
      created_at: '2026-01-01T00:00:00Z',
      sequence,
      data: {
        command,
        arguments: '',
        message: `msg_${eventId}`,
        chat: { object: 'chat', id: 'chat_1', type: 'dm', name: null },
        sender: { object: 'user', id: sender.id, handle: sender.handle ?? 'h', name: sender.name ?? 'n' },
      },
    },
  };
}

function buttonPressedEventFor(
  eventId: string,
  sequence: number,
  opts: { message?: string; button?: string; interaction?: string; user?: string } = {},
): Record<string, unknown> {
  return {
    op: 'event',
    d: {
      object: 'event',
      id: eventId,
      type: 'button.pressed',
      created_at: '2026-01-01T00:00:00Z',
      sequence,
      data: {
        chat: { object: 'chat', id: 'chat_1', type: 'dm', name: null },
        user: { object: 'user', id: opts.user ?? 'user_1', handle: 'h', name: 'n' },
        message: opts.message ?? 'msg_1',
        button: opts.button ?? 'again',
        interaction: opts.interaction ?? eventId,
      },
    },
  };
}

interface AckCall {
  interaction: string;
  body: unknown;
}

/** One combined REST + gateway fake server: token exchange, command sync,
 * message send (captured), and interaction ack (captured, scriptable). */
async function startCombinedFakeServer(
  script: Script,
  opts: {
    sentMessages?: Record<string, unknown>[];
    ackCalls?: AckCall[];
    ackResponder?: (call: AckCall, index: number) => { status: number; body?: Record<string, unknown> };
  } = {},
) {
  const sentMessages = opts.sentMessages ?? [];
  const ackCalls = opts.ackCalls ?? [];
  let ackIndex = 0;
  const gateway = await startGateway(script, (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsedBody: unknown = raw ? JSON.parse(raw) : undefined;

      if (req.url === '/v1/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'tok_test',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        return;
      }
      if (
        req.url?.startsWith('/v1/bots/') &&
        req.url.endsWith('/commands') &&
        req.method === 'PUT'
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }));
        return;
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        sentMessages.push(parsedBody as Record<string, unknown>);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'message', id: `msg_sent_${sentMessages.length}` }));
        return;
      }
      const ackMatch = /^\/v1\/interactions\/([^/]+)\/ack$/.exec(req.url ?? '');
      if (ackMatch !== null && req.method === 'POST') {
        const call: AckCall = { interaction: ackMatch[1] as string, body: parsedBody };
        ackCalls.push(call);
        const index = ackIndex;
        ackIndex += 1;
        const response = opts.ackResponder?.(call, index) ?? { status: 204 };
        if (response.status === 204) {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response.body ?? {}));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'invalid_request_error',
          code: 'not_found',
          message: 'not found',
          doc_url: 'https://bots.aurival.com/docs/errors#not_found',
        }),
      );
    })();
  });
  const host = gateway.url.replace(/^ws:\/\//, 'http://').replace(/\/v1\/gateway$/, '');
  return { ...gateway, host, sentMessages, ackCalls };
}

async function withPairedBot<T>(
  gateway: { host: string },
  build: (dir: string, keyPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-cooldown-test-'));
  const keyPath = path.join(dir, 'machine.json');
  const machine: Machine = {
    bot: 'bot_test',
    machine: 'machine_test',
    host: gateway.host,
    created: '2026-01-01T00:00:00Z',
  };
  await new KeyFile(keyPath).save(MachineKey.generate(), machine);
  try {
    return await build(dir, keyPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('the sentence itself', () => {
  it('is byte-identical to the spec table', () => {
    expect(COMMAND_COOLDOWN_NOTICE_TEMPLATE).toBe('Slow down. Try /{name} again in {n} s.');
    expect(commandCooldownNotice('roll', 5)).toBe('Slow down. Try /roll again in 5 s.');
  });
});

describe('command cooldown — the built-in notice, once per bucket per window (§4)', () => {
  it('the first invocation runs the handler and sends no notice; the second in the same window is refused, and sends the notice exactly once', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let handlerCalls = 0;
      bot.command('roll', { cooldown: { rate: 1, per: 5 } }, async () => {
        handlerCalls += 1;
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok, 'evt_2 was never acked').toBe(true);
        expect(handlerCalls).toBe(1);
        expect(gateway.sentMessages).toHaveLength(1);
        const body = gateway.sentMessages[0] as Record<string, unknown>;
        expect(body['text']).toBe('Slow down. Try /roll again in 5 s.');
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('silences the rest of the window: three rapid refusals still send exactly one notice', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      conn.send(commandInvokedEventFor('evt_3', 'roll', 3));
      conn.send(commandInvokedEventFor('evt_4', 'roll', 4));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      bot.command('roll', { cooldown: { rate: 1, per: 30 } }, async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_4'));
        expect(ok).toBe(true);
        expect(gateway.sentMessages).toHaveLength(1);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a refused invocation never reaches the handler', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let calls = 0;
      bot.command('roll', { cooldown: { rate: 1, per: 30 } }, async () => {
        calls += 1;
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(calls).toBe(1);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });
});

describe('command cooldown — hooks replace the notice (§4)', () => {
  it('a per-command onCooldown hook replaces the built-in notice, and receives (ctx, retryAfter)', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let hookCtx: Context | undefined;
      let hookRetryAfter: number | undefined;
      bot.command(
        'roll',
        {
          cooldown: { rate: 1, per: 30 },
          onCooldown: (ctx, retryAfter) => {
            hookCtx = ctx;
            hookRetryAfter = retryAfter;
          },
        },
        async () => undefined,
      );
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(gateway.sentMessages).toHaveLength(0);
        expect(hookCtx?.command).toBe('roll');
        expect(typeof hookRetryAfter).toBe('number');
        expect(hookRetryAfter as number).toBeGreaterThan(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a hook that does nothing suppresses the notice entirely', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      bot.command('roll', { cooldown: { rate: 1, per: 30 }, onCooldown: () => undefined }, async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(gateway.sentMessages).toHaveLength(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a per-command hook beats the bot-level one — only the command hook runs', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let botLevelCalls = 0;
      let commandLevelCalls = 0;
      bot.onCooldown(() => {
        botLevelCalls += 1;
      });
      bot.command(
        'roll',
        { cooldown: { rate: 1, per: 30 }, onCooldown: () => { commandLevelCalls += 1; } },
        async () => undefined,
      );
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(commandLevelCalls).toBe(1);
        expect(botLevelCalls).toBe(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a bot-level onCooldown runs for a command with no hook of its own', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let botLevelCalls = 0;
      bot.onCooldown(() => {
        botLevelCalls += 1;
      });
      bot.command('roll', { cooldown: { rate: 1, per: 30 } }, async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(botLevelCalls).toBe(1);
        expect(gateway.sentMessages).toHaveLength(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a throwing hook reaches onError, and the bot stays up for the next command', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEventFor('evt_1', 'roll', 1));
      conn.send(commandInvokedEventFor('evt_2', 'roll', 2));
      conn.send(commandInvokedEventFor('evt_3', 'ping', 3));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      const errors: unknown[] = [];
      bot.onError((err) => {
        errors.push(err);
      });
      let pingCalls = 0;
      bot.command(
        'roll',
        {
          cooldown: { rate: 1, per: 30 },
          onCooldown: () => {
            throw new Error('hook boom');
          },
        },
        async () => undefined,
      );
      bot.command('ping', async () => {
        pingCalls += 1;
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_3'));
        expect(ok).toBe(true);
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('hook boom');
        // The bot is still up: a later, unrelated command still dispatches.
        expect(pingCalls).toBe(1);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });
});

describe('button press — the automatic cooldown ack (§3, §5.1)', () => {
  it('a refused press sends the cooldown ack with the exact wire body, and never reaches the handler', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
      conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true, buttonCooldown: { rate: 1, per: 30 } });
      let handlerCalls = 0;
      bot.on('button.pressed', async () => {
        handlerCalls += 1;
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok, 'evt_2 (the refused press) was never acked').toBe(true);
        // The socket-level ack happens for BOTH presses — dispatch always
        // resolves, cooldown-refused or not.
        expect(gateway.state.acksFor(0)).toEqual(expect.arrayContaining(['evt_1', 'evt_2']));
        expect(handlerCalls).toBe(1);
        expect(gateway.ackCalls).toHaveLength(1);
        expect(gateway.ackCalls[0]?.interaction).toBe('evt_2');
        const body = gateway.ackCalls[0]?.body as Record<string, unknown>;
        expect(body).toEqual({
          cooldown: { retry_after_ms: expect.any(Number) as unknown as number },
        });
        const cooldown = body['cooldown'] as Record<string, unknown>;
        expect(Number.isInteger(cooldown['retry_after_ms'])).toBe(true);
        expect(cooldown['retry_after_ms'] as number).toBeGreaterThan(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a bot with no buttonCooldown configured still has one: the default refuses a second press', async () => {
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
      conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      // No `buttonCooldown` option at all — proves `new Cooldown(1, 2.0,
      // 'user')`'s default is live on a plain `new Bot(...)`, not just on
      // the primitive in isolation.
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      let handlerCalls = 0;
      bot.on('button.pressed', async () => {
        handlerCalls += 1;
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(handlerCalls).toBe(1);
        expect(gateway.ackCalls).toHaveLength(1);
        expect(gateway.ackCalls[0]?.interaction).toBe('evt_2');
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a bot with zero on(\'button.pressed\', ...) handlers still cooldown-acks a too-fast press', async () => {
    // AMENDMENT-08 §1/§5: the button default applies to every bot with no
    // line of code, and the presser must not be left under pending ink —
    // even a bot that never calls `on('button.pressed', ...)` at all (it
    // only sends cards, or handles presses some other way not yet wired
    // up). The socket must still route the press through the cooldown
    // check, and the refusal must still ack, with no developer handler in
    // the picture whatsoever.
    const gateway = await startCombinedFakeServer(async (conn) => {
      sendHello(conn);
      conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
      conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
      // Deliberately no `bot.on('button.pressed', ...)` at all.
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok, 'evt_2 (the refused press) was never acked').toBe(true);
        // Both presses still get their socket-level event ack — dispatch
        // resolves either way, handler or no handler, refused or not.
        expect(gateway.state.acksFor(0)).toEqual(expect.arrayContaining(['evt_1', 'evt_2']));
        expect(gateway.ackCalls).toHaveLength(1);
        expect(gateway.ackCalls[0]?.interaction).toBe('evt_2');
        const body = gateway.ackCalls[0]?.body as Record<string, unknown>;
        expect(body).toEqual({
          cooldown: { retry_after_ms: expect.any(Number) as unknown as number },
        });
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('a per-button cooldown recorded by reply() beats a disabled bot default, through the real send -> press round trip', async () => {
    // Event dispatch is concurrent, not serial (socket.ts's #handleEvent
    // fires each event's handler without awaiting it), so the two presses
    // must not go out until the `deal` reply's card cooldown has actually
    // been recorded — otherwise both presses race ahead of `reply()` and
    // land on an as-yet-unrecorded card, which is exactly what happened the
    // first time this test was written (both reached the handler).
    const sentMessages: Record<string, unknown>[] = [];
    const gateway = await startCombinedFakeServer(
      async (conn) => {
        sendHello(conn);
        conn.send(commandInvokedEventFor('evt_deal', 'deal', 1));
        const start = Date.now();
        while (sentMessages.length < 1 && Date.now() - start < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The server has the POST body, but the client still needs the
        // response round trip to come back and run `recordCardCooldown`
        // before the card lookup table has the entry — give it a moment.
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Both presses target the card `deal`'s reply sent, on the button
        // that reply attached its own cooldown to.
        conn.send(buttonPressedEventFor('evt_p1', 2, { message: 'msg_sent_1', button: 'again', interaction: 'evt_p1' }));
        conn.send(buttonPressedEventFor('evt_p2', 3, { message: 'msg_sent_1', button: 'again', interaction: 'evt_p2' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      { sentMessages },
    );
    await withPairedBot(gateway, async (_dir, keyPath) => {
      // The bot default is disabled entirely — only the button's own
      // cooldown, recorded by `reply()`'s card lookup table, can refuse.
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true, buttonCooldown: null });
      let handlerCalls = 0;
      bot.on('button.pressed', async () => {
        handlerCalls += 1;
      });
      bot.command('deal', async (ctx) => {
        await ctx.reply('cards!', {
          buttons: [new Button({ id: 'again', label: 'Again', cooldown: { rate: 1, per: 30 } })],
        });
      });
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const sent = await waitUntil(() => gateway.sentMessages.length === 1);
        expect(sent, 'deal never replied').toBe(true);
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_p2'));
        expect(ok, 'evt_p2 (the refused press) was never acked').toBe(true);
        expect(handlerCalls).toBe(1);
        expect(gateway.ackCalls).toHaveLength(1);
        expect(gateway.ackCalls[0]?.interaction).toBe('evt_p2');
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('swallows button_already_used from the cooldown ack silently — no onError, nothing thrown, bot stays up', async () => {
    const errors: unknown[] = [];
    const gateway = await startCombinedFakeServer(
      async (conn) => {
        sendHello(conn);
        conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
        conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
        conn.send(buttonPressedEventFor('evt_3', 3, { interaction: 'evt_3' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      {
        // Every cooldown ack call is for a refused press (a pass never acks),
        // so every one of them hits the swallowed status here.
        ackResponder: () => ({
          status: 409,
          body: {
            type: 'invalid_request_error',
            code: 'button_already_used',
            message: 'already used',
            doc_url: 'https://bots.aurival.com/docs/errors#button_already_used',
          },
        }),
      },
    );
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true, buttonCooldown: { rate: 1, per: 30 } });
      bot.onError((err) => {
        errors.push(err);
      });
      bot.on('button.pressed', async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        // The bot default is unscoped (§3: attachmentScope = ()), so evt_3
        // shares evt_1/evt_2's bucket and is refused too — its ack also
        // gets swallowed. Its socket-level ack landing anyway is the proof
        // the swallow above did not take the bot down.
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_3'));
        expect(ok).toBe(true);
        expect(errors).toHaveLength(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('swallows not_found from the cooldown ack silently too', async () => {
    const errors: unknown[] = [];
    const gateway = await startCombinedFakeServer(
      async (conn) => {
        sendHello(conn);
        conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
        conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      {
        ackResponder: () => ({
          status: 404,
          body: {
            type: 'invalid_request_error',
            code: 'not_found',
            message: 'gone',
            doc_url: 'https://bots.aurival.com/docs/errors#not_found',
          },
        }),
      },
    );
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true, buttonCooldown: { rate: 1, per: 30 } });
      bot.onError((err) => {
        errors.push(err);
      });
      bot.on('button.pressed', async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(errors).toHaveLength(0);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });

  it('every other status from the cooldown ack goes through the normal onError path', async () => {
    const errors: unknown[] = [];
    const gateway = await startCombinedFakeServer(
      async (conn) => {
        sendHello(conn);
        conn.send(buttonPressedEventFor('evt_1', 1, { interaction: 'evt_1' }));
        conn.send(buttonPressedEventFor('evt_2', 2, { interaction: 'evt_2' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      {
        ackResponder: () => ({
          status: 400,
          body: {
            type: 'invalid_request_error',
            code: 'cooldown_retry_after_invalid',
            message: 'bad retry_after_ms',
            doc_url: 'https://bots.aurival.com/docs/errors#cooldown_retry_after_invalid',
          },
        }),
      },
    );
    await withPairedBot(gateway, async (_dir, keyPath) => {
      const bot = new Bot({ host: gateway.host, keyPath, quiet: true, buttonCooldown: { rate: 1, per: 30 } });
      bot.onError((err) => {
        errors.push(err);
      });
      bot.on('button.pressed', async () => undefined);
      const controller = new AbortController();
      const task = bot.start(controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(CooldownRetryAfterInvalid);
      } finally {
        controller.abort();
        await task;
      }
    });
    await gateway.close();
  });
});
