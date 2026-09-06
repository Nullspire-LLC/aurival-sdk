/**
 * `conflicts` at sync (S11). The field has been on the wire since
 * AMENDMENT-01 A-5.2 and both SDKs dropped it silently, which is exactly the
 * silence it exists to end: the developer whose command never fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bot, reportConflicts, syncCommandsAndReport } from '../src/bot.js';
import { AurivalError, BotSuspended, SessionSuperseded } from '../src/errors.js';
import { HttpClient } from '../src/http.js';
import type { Logger } from '../src/http.js';
import { KeyFile, MachineKey, type Auth, type Machine } from '../src/auth.js';

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

/** The real `PUT /v1/bots/:bot/commands` body: a WireList of WireCommand. */
function listOf(commands: Array<Record<string, unknown>>): Record<string, unknown> {
  return { object: 'list', data: commands, has_more: false, next_cursor: null };
}

function command(name: string, conflicts: string[]): Record<string, unknown> {
  return { object: 'command', name, description: '', conflicts };
}

describe('syncCommandsAndReport', () => {
  // The whole point of the seam: the lane that syncs is the lane that reports,
  // so neither the first sync nor the rate-limited background retry can quietly
  // drop the field.
  it('reports what the real PUT answered', async () => {
    const server = http.createServer((req, res) => {
      void (async () => {
        for await (const _chunk of req) void _chunk;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listOf([command('ping', ['chat_zzz'])])));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { log, warnings } = recorder();
    try {
      const fakeAuth = {
        token: () => Promise.resolve('tok'),
        refresh: () => Promise.resolve('tok'),
      };
      const client = new HttpClient(`http://127.0.0.1:${port}`, fakeAuth as unknown as Auth);
      await syncCommandsAndReport(client, 'bot_1', [{ name: 'ping', description: '' }], log);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('chat_zzz');
  });
});

describe('reportConflicts', () => {
  it('warns once per conflict, naming the chat and the command', () => {
    const { log, warnings } = recorder();
    reportConflicts(listOf([command('ping', ['chat_aaa', 'chat_bbb'])]), log);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('chat_aaa');
    expect(warnings[0]).toContain('ping');
    expect(warnings[1]).toContain('chat_bbb');
  });

  it('warns for every command that has a conflict, not just the first', () => {
    const { log, warnings } = recorder();
    reportConflicts(
      listOf([
        command('ping', ['chat_aaa']),
        command('quiet', []),
        command('say', ['chat_bbb', 'chat_ccc']),
      ]),
      log,
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('chat_ccc');
    expect(warnings.join('\n')).not.toContain('quiet');
  });

  it('says nothing when nothing is shadowed', () => {
    const { log, warnings } = recorder();
    reportConflicts(listOf([command('ping', []), command('say', [])]), log);
    expect(warnings).toEqual([]);
  });

  // A response the SDK cannot read is not a reason to take a bot down: the sync
  // itself already succeeded by the time we get here.
  it('tolerates a body with no data, a non-array data, and junk rows', () => {
    const { log, warnings } = recorder();
    reportConflicts({}, log);
    reportConflicts({ data: 'nope' }, log);
    reportConflicts(listOf([{ name: 'ping' }, 7 as unknown as Record<string, unknown>]), log);
    reportConflicts(listOf([command('ping', [1 as unknown as string])]), log);
    expect(warnings).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// ergonomics: two silent footguns at startup (a duplicate registration that
// overwrites without a word, and a bot that will connect and wait forever
// because nothing was ever registered).
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

describe('Bot#run', () => {
  it('does not rethrow SessionSuperseded — a clean exit via process.exitCode, no traceback', async () => {
    const bot = new Bot({ quiet: true });
    vi.spyOn(bot, 'start').mockRejectedValue(
      new SessionSuperseded({
        type: 'invalid_request_error',
        code: 'session_superseded',
        message: 'displaced',
        doc_url: 'https://bots.aurival.com/docs/errors#session_superseded',
      }),
    );
    const before = process.exitCode;
    try {
      await expect(bot.run()).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it('does not rethrow BotSuspended either', async () => {
    const bot = new Bot({ quiet: true });
    vi.spyOn(bot, 'start').mockRejectedValue(
      new BotSuspended({
        type: 'permission_error',
        code: 'bot_suspended',
        message: 'paused',
        doc_url: 'https://bots.aurival.com/docs/errors#bot_suspended',
      }),
    );
    const before = process.exitCode;
    try {
      await expect(bot.run()).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it('rethrows every other fatal error unchanged', async () => {
    const bot = new Bot({ quiet: true });
    const boom = new AurivalError('boom');
    vi.spyOn(bot, 'start').mockRejectedValue(boom);
    await expect(bot.run()).rejects.toBe(boom);
  });
});

describe('Bot#command duplicate registration', () => {
  it('warns once, naming the command, when the same name is registered twice', () => {
    const bot = new Bot({ quiet: false });
    bot.command('ping', async () => undefined);
    expect(stderrLines).toEqual([]);
    bot.command('ping', async () => undefined);
    expect(stderrLines).toEqual([
      'aurival: command "ping" registered twice, the later definition wins',
    ]);
  });

  it('is case/whitespace-insensitive for the dedup check, but names the command as passed', () => {
    const bot = new Bot({ quiet: false });
    bot.command('Ping', async () => undefined);
    bot.command(' ping ', async () => undefined);
    expect(stderrLines).toEqual([
      'aurival: command " ping " registered twice, the later definition wins',
    ]);
  });

  it('says nothing for two different commands', () => {
    const bot = new Bot({ quiet: false });
    bot.command('ping', async () => undefined);
    bot.command('pong', async () => undefined);
    expect(stderrLines).toEqual([]);
  });

  it('is silent when quiet', () => {
    const bot = new Bot({ quiet: true });
    bot.command('ping', async () => undefined);
    bot.command('ping', async () => undefined);
    expect(stderrLines).toEqual([]);
  });
});

/**
 * A minimal real `node:http` server for `Bot#start`'s pre-connect leg: the
 * token exchange and the command sync PUT. No mocked `fetch` (repo
 * convention, see `auth.test.ts`) — a real server on an ephemeral port.
 */
function startFakeBotAPI(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      for await (const _chunk of req) void _chunk;
      if (req.url === '/v1/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'tok_test', expires_at: '2099-01-01T00:00:00Z' }),
        );
        return;
      }
      if (req.url?.startsWith('/v1/bots/') && req.url.endsWith('/commands') && req.method === 'PUT') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }));
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('Bot#start with zero registered commands', () => {
  it('warns before connecting, and still proceeds to connect', async () => {
    const api = await startFakeBotAPI();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-bot-test-'));
    const keyPath = path.join(dir, 'machine.json');
    const machine: Machine = {
      bot: 'bot_test',
      machine: 'machine_test',
      host: api.url,
      created: '2026-01-01T00:00:00Z',
    };
    await new KeyFile(keyPath).save(MachineKey.generate(), machine);

    try {
      const bot = new Bot({ host: api.url, keyPath, quiet: false });
      // Zero commands registered on purpose. Signal starts pre-aborted so
      // `Socket#run` returns immediately without ever dialing a gateway —
      // everything under test (sync, the warning, `connecting`) happens
      // before that point in `Bot#start`.
      const controller = new AbortController();
      controller.abort();
      await bot.start(controller.signal);

      const noCommandsIdx = stderrLines.findIndex((l) => l.includes('no commands registered'));
      const connectingIdx = stderrLines.findIndex((l) => l.includes('connecting to'));
      expect(noCommandsIdx).toBeGreaterThanOrEqual(0);
      expect(connectingIdx).toBeGreaterThanOrEqual(0);
      expect(noCommandsIdx).toBeLessThan(connectingIdx);
      expect(stderrLines[noCommandsIdx]).toBe(
        'aurival: no commands registered, this bot will connect and wait forever. Add @bot.command(...) before run().',
      );
    } finally {
      await api.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('says nothing when at least one command is registered', async () => {
    const api = await startFakeBotAPI();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-bot-test-'));
    const keyPath = path.join(dir, 'machine.json');
    const machine: Machine = {
      bot: 'bot_test',
      machine: 'machine_test',
      host: api.url,
      created: '2026-01-01T00:00:00Z',
    };
    await new KeyFile(keyPath).save(MachineKey.generate(), machine);

    try {
      const bot = new Bot({ host: api.url, keyPath, quiet: false });
      bot.command('ping', async () => undefined);
      const controller = new AbortController();
      controller.abort();
      await bot.start(controller.signal);

      expect(stderrLines.some((l) => l.includes('no commands registered'))).toBe(false);
    } finally {
      await api.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Bot#start command count cap (Lane 58 S2)', () => {
  it('throws locally, before any network call, past fifty registered commands', async () => {
    const bot = new Bot({ quiet: true });
    for (let i = 0; i < 51; i++) {
      bot.command(`cmd${i}`, async () => undefined);
    }

    await expect(bot.start()).rejects.toThrow(
      '51 commands registered, but the cap is 50 per bot',
    );
  });

  it('does not throw at exactly fifty registered commands', async () => {
    const api = await startFakeBotAPI();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-bot-test-'));
    const keyPath = path.join(dir, 'machine.json');
    const machine: Machine = {
      bot: 'bot_test',
      machine: 'machine_test',
      host: api.url,
      created: '2026-01-01T00:00:00Z',
    };
    await new KeyFile(keyPath).save(MachineKey.generate(), machine);

    try {
      const bot = new Bot({ host: api.url, keyPath, quiet: true });
      for (let i = 0; i < 50; i++) {
        bot.command(`cmd${i}`, async () => undefined);
      }
      const controller = new AbortController();
      controller.abort();
      await expect(bot.start(controller.signal)).resolves.toBeUndefined();
    } finally {
      await api.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
