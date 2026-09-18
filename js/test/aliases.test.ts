/**
 * AMENDMENT-09 §2/§13.1, L3's `aliases.test.ts`: command aliases end to end
 * — the sync payload, dispatch, `ctx.command` vs `ctx.invokedAs`, the one
 * shared cooldown bucket across every spelling, the cooldown notice naming
 * the typed token, both pre-existing string overloads staying unchanged,
 * and the local `MAX_ALIASES_PER_COMMAND` cap.
 *
 * Registration/sync-payload assertions use `syncCommandsAndReport` directly
 * (`bot.test.ts`'s own model for that seam); dispatch and cooldown
 * assertions run a real `Bot` over a real gateway connection
 * (`cooldownNotice.test.ts`'s model) so this is the same path a running bot
 * actually takes, not a mocked `Socket`.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AurivalError } from '../src/errors.js';
import { Bot, syncCommandsAndReport } from '../src/bot.js';
import type { Context } from '../src/events.js';
import { HttpClient } from '../src/http.js';
import type { Logger } from '../src/http.js';
import type { Auth, Machine } from '../src/auth.js';
import { KeyFile, MachineKey } from '../src/auth.js';
import { COMMAND_COOLDOWN_NOTICE_TEMPLATE, commandCooldownNotice } from '../src/caps.js';
import { sendHello, startGateway, waitUntil } from './wsserver.js';

function recorder(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (m: string) => warnings.push(m),
    error: () => undefined,
  };
  return { log, warnings };
}

function listOf(commands: Array<Record<string, unknown>>): Record<string, unknown> {
  return { object: 'list', data: commands, has_more: false, next_cursor: null };
}

// --------------------------------------------------------------------------
// registration -> sync payload
// --------------------------------------------------------------------------

describe('aliases on registration reach the sync payload', () => {
  it('sends the declared aliases array alongside name/description', async () => {
    let capturedBody: unknown;
    const server = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listOf([])));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const { log } = recorder();
      const fakeAuth = { token: () => Promise.resolve('tok'), refresh: () => Promise.resolve('tok') };
      const client = new HttpClient(`http://127.0.0.1:${port}`, fakeAuth as unknown as Auth);
      await syncCommandsAndReport(
        client,
        'bot_1',
        [{ name: 'roll', description: 'Roll a die', aliases: ['r', 'dice'] }],
        log,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(capturedBody).toEqual({
      commands: [{ name: 'roll', description: 'Roll a die', aliases: ['r', 'dice'] }],
    });
  });

  it('OMITS the aliases key entirely when a command declares none', async () => {
    let capturedBody: unknown;
    const server = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listOf([])));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const { log } = recorder();
      const fakeAuth = { token: () => Promise.resolve('tok'), refresh: () => Promise.resolve('tok') };
      const client = new HttpClient(`http://127.0.0.1:${port}`, fakeAuth as unknown as Auth);
      await syncCommandsAndReport(client, 'bot_1', [{ name: 'ping', description: '' }], log);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(capturedBody).toEqual({ commands: [{ name: 'ping', description: '' }] });
    const body = capturedBody as { commands: Array<Record<string, unknown>> };
    expect('aliases' in body.commands[0]!).toBe(false);
  });
});

describe('Bot#command: aliases at registration', () => {
  it('a bare Command a caller can hand syncCommandsAndReport carries an aliases array through', () => {
    // `Bot#command` itself is exercised end to end below (dispatch); this
    // pins the option door's shape directly.
    const bot = new Bot({ quiet: true });
    expect(() =>
      bot.command('roll', { description: 'Roll a die', aliases: ['r', 'dice'] }, async () => undefined),
    ).not.toThrow();
  });

  it('more than MAX_ALIASES_PER_COMMAND (3) throws with CAP_TOO_MANY_ALIASES', () => {
    const bot = new Bot({ quiet: true });
    let thrown: unknown;
    try {
      bot.command('roll', { aliases: ['a', 'b', 'c', 'd'] }, async () => undefined);
    } catch (exc) {
      thrown = exc;
    }
    expect(thrown).toBeInstanceOf(AurivalError);
    expect((thrown as Error).message).toBe('a command declares at most 3 aliases');
  });

  it('exactly MAX_ALIASES_PER_COMMAND (3) is accepted', () => {
    const bot = new Bot({ quiet: true });
    expect(() =>
      bot.command('roll', { aliases: ['a', 'b', 'c'] }, async () => undefined),
    ).not.toThrow();
  });

  it('both pre-existing string overloads still work unchanged: command(name, handler)', () => {
    const bot = new Bot({ quiet: true });
    expect(() => bot.command('ping', async () => undefined)).not.toThrow();
  });

  it('both pre-existing string overloads still work unchanged: command(name, description, handler)', () => {
    const bot = new Bot({ quiet: true });
    expect(() => bot.command('ping', 'replies pong', async () => undefined)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// dispatch + ctx.command / ctx.invokedAs, over a real gateway connection
// --------------------------------------------------------------------------

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
  sequence: number,
  opts: { command: string; invokedAs?: string; sender?: string } = { command: 'roll' },
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    command: opts.command,
    arguments: '',
    message: `msg_${eventId}`,
    chat: { object: 'chat', id: 'chat_1', type: 'dm', name: null },
    sender: { object: 'user', id: opts.sender ?? 'user_1', handle: 'h', name: 'n' },
  };
  if (opts.invokedAs !== undefined) data['invoked_as'] = opts.invokedAs;
  return {
    op: 'event',
    d: {
      object: 'event',
      id: eventId,
      type: 'command.invoked',
      created_at: '2026-01-01T00:00:00Z',
      sequence,
      data,
    },
  };
}

async function startCombinedFakeServer(
  script: Parameters<typeof startGateway>[0],
  sentMessages: Array<{ text: string }> = [],
) {
  const gateway = await startGateway(script, (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
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
      if (req.url?.startsWith('/v1/bots/') && req.url.endsWith('/commands') && req.method === 'PUT') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listOf([])));
        return;
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: string };
        sentMessages.push({ text: body.text ?? '' });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'message', id: 'msg_reply', text: body.text ?? '' }));
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
  return { ...gateway, host };
}

async function withRunningBot(
  script: Parameters<typeof startGateway>[0],
  build: (bot: Bot) => void,
  run: (gateway: Awaited<ReturnType<typeof startCombinedFakeServer>>) => Promise<void>,
  sentMessages: Array<{ text: string }> = [],
): Promise<void> {
  const gateway = await startCombinedFakeServer(script, sentMessages);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-alias-test-'));
  const keyPath = path.join(dir, 'machine.json');
  const machine: Machine = {
    bot: 'bot_test',
    machine: 'machine_test',
    host: gateway.host,
    created: '2026-01-01T00:00:00Z',
  };
  await new KeyFile(keyPath).save(MachineKey.generate(), machine);
  const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
  build(bot);
  const controller = new AbortController();
  const task = bot.start(controller.signal);
  try {
    await run(gateway);
  } finally {
    controller.abort();
    await task;
    await gateway.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('dispatch: the handler fires on an alias, and ctx.command/ctx.invokedAs', () => {
  it('a handler registered for the canonical name fires when the wire names an alias as invoked_as', async () => {
    let seen: Context | null = null;
    await withRunningBot(
      async (conn) => {
        sendHello(conn);
        conn.send(commandInvokedEventFor('evt_alias', 1, { command: 'roll', invokedAs: 'r' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      (bot) => {
        bot.command('roll', async (ctx) => {
          seen = ctx;
        });
      },
      async (gateway) => {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_alias'));
        expect(ok, 'command.invoked was never acked').toBe(true);
      },
    );
    expect(seen).not.toBeNull();
    const ctx = seen as unknown as Context;
    expect(ctx.command).toBe('roll');
    expect(ctx.invokedAs).toBe('r');
  });

  it('a canonical call has ctx.command === ctx.invokedAs', async () => {
    let seen: Context | null = null;
    await withRunningBot(
      async (conn) => {
        sendHello(conn);
        conn.send(commandInvokedEventFor('evt_canon', 1, { command: 'roll', invokedAs: 'roll' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      (bot) => {
        bot.command('roll', async (ctx) => {
          seen = ctx;
        });
      },
      async (gateway) => {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_canon'));
        expect(ok).toBe(true);
      },
    );
    const ctx = seen as unknown as Context;
    expect(ctx.command).toBe('roll');
    expect(ctx.invokedAs).toBe('roll');
    expect(ctx.command).toBe(ctx.invokedAs);
  });

  it('invokedAs falls back to command when the wire omits invoked_as (pre-deploy backend)', async () => {
    let seen: Context | null = null;
    await withRunningBot(
      async (conn) => {
        sendHello(conn);
        // No `invoked_as` key at all — the pre-AMENDMENT-09 wire shape.
        conn.send(commandInvokedEventFor('evt_old', 1, { command: 'roll' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      (bot) => {
        bot.command('roll', async (ctx) => {
          seen = ctx;
        });
      },
      async (gateway) => {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_old'));
        expect(ok).toBe(true);
      },
    );
    const ctx = seen as unknown as Context;
    expect(ctx.command).toBe('roll');
    expect(ctx.invokedAs).toBe('roll');
  });
});

// --------------------------------------------------------------------------
// one cooldown bucket across every spelling, and the notice's typed token
// --------------------------------------------------------------------------

describe('one cooldown bucket across every alias spelling (§13.1)', () => {
  it('two different aliases inside the window produce one refusal, not two fresh passes', async () => {
    const replies: string[] = [];
    let calls = 0;
    await withRunningBot(
      async (conn) => {
        sendHello(conn);
        conn.send(commandInvokedEventFor('evt_1', 1, { command: 'roll', invokedAs: 'roll' }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        conn.send(commandInvokedEventFor('evt_2', 2, { command: 'roll', invokedAs: 'r' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      (bot) => {
        bot.command('roll', { cooldown: { rate: 1, per: 30 } }, async (ctx) => {
          calls += 1;
          replies.push(await ctx.reply('rolled a 4').then((m) => m.text));
        });
      },
      async (gateway) => {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
      },
    );
    // Only the first call (the canonical spelling) ran the handler; the
    // second, on the alias, hit the SAME bucket and was refused.
    expect(calls).toBe(1);
  });

  it('the cooldown notice names the TYPED token, while COMMAND_COOLDOWN_NOTICE_TEMPLATE itself is unchanged', async () => {
    expect(COMMAND_COOLDOWN_NOTICE_TEMPLATE).toBe('Slow down. Try /{name} again in {n} s.');
    const sentMessages: Array<{ text: string }> = [];
    await withRunningBot(
      async (conn) => {
        sendHello(conn);
        conn.send(commandInvokedEventFor('evt_1', 1, { command: 'roll', invokedAs: 'roll' }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        conn.send(commandInvokedEventFor('evt_2', 2, { command: 'roll', invokedAs: 'dice' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      (bot) => {
        bot.command('roll', { cooldown: { rate: 1, per: 30 } }, async (ctx) => {
          await ctx.reply('rolled a 4');
        });
      },
      async (gateway) => {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_2'));
        expect(ok).toBe(true);
      },
      sentMessages,
    );
    // The first invocation ran the handler and replied 'rolled a 4'; the
    // second, refused by the shared bucket, replied with the built-in
    // notice — naming `dice`, the token that call actually typed, not the
    // canonical `roll`.
    expect(sentMessages.map((m) => m.text)).toEqual([
      'rolled a 4',
      commandCooldownNotice('dice', 30),
    ]);
    expect(sentMessages[1]?.text).toContain('/dice');
    expect(sentMessages[1]?.text).not.toContain('/roll');
  });
});
