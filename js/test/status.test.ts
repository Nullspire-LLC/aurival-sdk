/**
 * `aurival: …` status banners (SDK status-banner spec): one line per
 * connection-lifecycle moment, stderr only, colored only on a real TTY,
 * silenced by `quiet: true` or `AURIVAL_QUIET=1`.
 *
 * Unit-level: the six emitters in `src/status.ts` plus the duration helper.
 * Wired-level: a real in-process gateway (the same harness `socket.test.ts`
 * uses) drives `Socket` end to end and asserts the right banner fires at the
 * right moment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../src/auth.js';
import { AurivalAPIError } from '../src/errors.js';
import type { Event } from '../src/events.js';
import type { HttpClient } from '../src/http.js';
import { Socket } from '../src/socket.js';
import * as status from '../src/status.js';
import { FakeAuth, FakeHttpClient } from './socket.test.js';
import { byeFrame, startGateway, waitUntil } from './wsserver.js';

// --------------------------------------------------------------------------
// stderr capture harness
// --------------------------------------------------------------------------

let lines: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;
let originalQuietEnv: string | undefined;

beforeEach(() => {
  lines = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  originalIsTTY = process.stderr.isTTY;
  originalQuietEnv = process.env['AURIVAL_QUIET'];
  delete process.env['AURIVAL_QUIET'];
});

afterEach(() => {
  errorSpy.mockRestore();
  setTTY(originalIsTTY);
  if (originalQuietEnv === undefined) delete process.env['AURIVAL_QUIET'];
  else process.env['AURIVAL_QUIET'] = originalQuietEnv;
});

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
}

function strip(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9]+m/g, '');
}

// --------------------------------------------------------------------------
// formatDuration
// --------------------------------------------------------------------------

describe('formatDuration', () => {
  it('renders sub-minute spans with one decimal place', () => {
    expect(status.formatDuration(2300)).toBe('2.3s');
  });

  it('renders minute-scale spans as minutes and whole seconds', () => {
    expect(status.formatDuration(65_000)).toBe('1m 5s');
  });

  it('renders hour-scale spans as hours and minutes', () => {
    expect(status.formatDuration(3_900_000)).toBe('1h 5m');
  });

  it('never goes negative on a clock that raced backwards', () => {
    expect(status.formatDuration(-50)).toBe('0s');
  });
});

// --------------------------------------------------------------------------
// isQuiet
// --------------------------------------------------------------------------

describe('isQuiet', () => {
  it('is false by default', () => {
    expect(status.isQuiet(undefined)).toBe(false);
    expect(status.isQuiet(false)).toBe(false);
  });

  it('is true when the constructor option is true', () => {
    expect(status.isQuiet(true)).toBe(true);
  });

  it('is true when AURIVAL_QUIET=1, even with the option left off', () => {
    process.env['AURIVAL_QUIET'] = '1';
    expect(status.isQuiet(undefined)).toBe(true);
  });

  it('ignores AURIVAL_QUIET values other than "1"', () => {
    process.env['AURIVAL_QUIET'] = 'true';
    expect(status.isQuiet(undefined)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// the six emitters — exact wording, color-on-TTY-only, quiet suppression
// --------------------------------------------------------------------------

describe('connecting', () => {
  it('prints the exact connecting line', () => {
    setTTY(false);
    status.connecting('acme.bot', false);
    expect(lines).toEqual(['aurival: connecting to bots.aurival.com as acme.bot…']);
  });

  it('colors yellow on a TTY, plain otherwise', () => {
    setTTY(true);
    status.connecting('acme.bot', false);
    expect(lines[0]).toBe('\x1b[33maurival: connecting to bots.aurival.com as acme.bot…\x1b[0m');

    lines = [];
    setTTY(false);
    status.connecting('acme.bot', false);
    expect(lines[0]).toBe('aurival: connecting to bots.aurival.com as acme.bot…');
  });

  it('is silent when quiet', () => {
    setTTY(false);
    status.connecting('acme.bot', true);
    expect(lines).toEqual([]);
  });

  it('is silent under AURIVAL_QUIET=1 even without the option', () => {
    process.env['AURIVAL_QUIET'] = '1';
    setTTY(false);
    status.connecting('acme.bot', status.isQuiet(undefined));
    expect(lines).toEqual([]);
  });
});

describe('connected', () => {
  it('prints bot name, an 8-char short session id, and the command count', () => {
    setTTY(false);
    status.connected('acme.bot', 'sess_1234567890', 3, false);
    expect(lines).toEqual([
      'aurival: connected — acme.bot, session sess_123, 3 commands registered. ' +
        'Waiting for commands. (Ctrl+C to stop)',
    ]);
  });

  it('colors green on a TTY', () => {
    setTTY(true);
    status.connected('acme.bot', 'sess_1234567890', 3, false);
    expect(lines[0]?.startsWith('\x1b[32m')).toBe(true);
    expect(lines[0]?.endsWith('\x1b[0m')).toBe(true);
  });

  it('is silent when quiet', () => {
    status.connected('acme.bot', 'sess_1234567890', 3, true);
    expect(lines).toEqual([]);
  });
});

describe('reconnecting', () => {
  it('prints the reason and the delay rounded to one decimal', () => {
    setTTY(false);
    status.reconnecting('idle_timeout', 2.34, false);
    expect(lines).toEqual(['aurival: connection closed (idle_timeout), reconnecting in 2.3s…']);
  });

  it('accepts "network error" as the reason for an unnamed fault', () => {
    setTTY(false);
    status.reconnecting('network error', 0.5, false);
    expect(lines).toEqual([
      'aurival: connection closed (network error), reconnecting in 0.5s…',
    ]);
  });

  it('colors yellow on a TTY', () => {
    setTTY(true);
    status.reconnecting('idle_timeout', 2.3, false);
    expect(lines[0]?.startsWith('\x1b[33m')).toBe(true);
  });

  it('is silent when quiet', () => {
    status.reconnecting('idle_timeout', 2.3, true);
    expect(lines).toEqual([]);
  });
});

describe('reconnected', () => {
  it('prints elapsed time via formatDuration', () => {
    setTTY(false);
    status.reconnected(2300, false);
    expect(lines).toEqual(['aurival: reconnected after 2.3s']);
  });

  it('colors green on a TTY', () => {
    setTTY(true);
    status.reconnected(2300, false);
    expect(lines[0]?.startsWith('\x1b[32m')).toBe(true);
  });

  it('is silent when quiet', () => {
    status.reconnected(2300, true);
    expect(lines).toEqual([]);
  });
});

describe('stopped', () => {
  it('prints the code and the reused error message', () => {
    setTTY(false);
    status.stopped('key_revoked', 'this key was revoked, remove ./.aurival/ and pair again', false);
    expect(lines).toEqual([
      'aurival: stopped — key_revoked: this key was revoked, remove ./.aurival/ and pair again',
    ]);
  });

  it('colors red on a TTY', () => {
    setTTY(true);
    status.stopped('key_revoked', 'go fix it', false);
    expect(lines[0]?.startsWith('\x1b[31m')).toBe(true);
  });

  it('is silent when quiet', () => {
    status.stopped('key_revoked', 'go fix it', true);
    expect(lines).toEqual([]);
  });

  it('uses friendlier text for session_superseded, no docUrl line by default', () => {
    setTTY(false);
    status.stopped('session_superseded', 'ignored, friendly text wins', false);
    expect(lines).toEqual([
      'aurival: stopped — another copy of this bot connected (elsewhere). One socket per bot: stop the other copy, then start this one again.',
    ]);
  });

  it('appends a doc_url line for session_superseded when given', () => {
    setTTY(false);
    status.stopped(
      'session_superseded',
      'ignored, friendly text wins',
      false,
      'https://bots.aurival.com/docs/errors#session_superseded',
    );
    expect(lines).toEqual([
      'aurival: stopped — another copy of this bot connected (elsewhere). One socket per bot: stop the other copy, then start this one again.\nhttps://bots.aurival.com/docs/errors#session_superseded',
    ]);
  });

  it('uses friendlier text for bot_suspended, no docUrl line by default', () => {
    setTTY(false);
    status.stopped('bot_suspended', 'ignored, friendly text wins', false);
    expect(lines).toEqual([
      'aurival: stopped — this bot is paused by its owner. Resume it from the app, then start again.',
    ]);
  });

  it('appends a doc_url line for bot_suspended when given', () => {
    setTTY(false);
    status.stopped(
      'bot_suspended',
      'ignored, friendly text wins',
      false,
      'https://bots.aurival.com/docs/errors#bot_suspended',
    );
    expect(lines).toEqual([
      'aurival: stopped — this bot is paused by its owner. Resume it from the app, then start again.\nhttps://bots.aurival.com/docs/errors#bot_suspended',
    ]);
  });

  it('ignores docUrl for every other code, unchanged one-line format', () => {
    setTTY(false);
    status.stopped(
      'key_revoked',
      'this key was revoked, remove ./.aurival/ and pair again',
      false,
      'https://bots.aurival.com/docs/errors#key_revoked',
    );
    expect(lines).toEqual([
      'aurival: stopped — key_revoked: this key was revoked, remove ./.aurival/ and pair again',
    ]);
  });
});

describe('duplicateCommand', () => {
  it('prints the exact duplicate-registration line', () => {
    setTTY(false);
    status.duplicateCommand('ping', false);
    expect(lines).toEqual(['aurival: command "ping" registered twice, the later definition wins']);
  });

  it('colors yellow on a TTY', () => {
    setTTY(true);
    status.duplicateCommand('ping', false);
    expect(lines[0]).toBe(
      '\x1b[33maurival: command "ping" registered twice, the later definition wins\x1b[0m',
    );
  });

  it('is silent when quiet', () => {
    status.duplicateCommand('ping', true);
    expect(lines).toEqual([]);
  });
});

describe('noCommands', () => {
  it('prints the exact no-commands-registered line', () => {
    setTTY(false);
    status.noCommands(false);
    expect(lines).toEqual([
      'aurival: no commands registered, this bot will connect and wait forever. Add @bot.command(...) before run().',
    ]);
  });

  it('colors yellow on a TTY', () => {
    setTTY(true);
    status.noCommands(false);
    expect(lines[0]?.startsWith('\x1b[33m')).toBe(true);
  });

  it('is silent when quiet', () => {
    status.noCommands(true);
    expect(lines).toEqual([]);
  });
});

describe('disconnected', () => {
  it('prints uptime via formatDuration', () => {
    setTTY(false);
    status.disconnected(65_000, false);
    expect(lines).toEqual(['aurival: disconnected after 1m 5s']);
  });

  it('never colors, even on a TTY — a clean stop is not an error', () => {
    setTTY(true);
    status.disconnected(65_000, false);
    expect(lines[0]).toBe('aurival: disconnected after 1m 5s');
  });

  it('is silent when quiet', () => {
    status.disconnected(65_000, true);
    expect(lines).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// wired through Socket: the real emitter fires at the real moment
// --------------------------------------------------------------------------

function makeWiredSocket(
  http: FakeHttpClient,
  auth: FakeAuth,
  overrides: {
    botName?: string;
    commandCount?: number;
    quiet?: boolean;
  } = {},
): { socket: Socket; dispatched: Event[] } {
  const dispatched: Event[] = [];
  const socket = new Socket(http as unknown as HttpClient, auth as unknown as Auth, {
    dispatch: async (event) => {
      dispatched.push(event);
    },
    onProblem: () => {
      // not under test here
    },
    botName: overrides.botName ?? 'acme.bot',
    commandCount: overrides.commandCount ?? 2,
    quiet: overrides.quiet ?? false,
    backoffBase: 0.01,
    backoffCap: 0.05,
    shortWaitRange: [0.02, 0.03],
    jitter: () => 0.5,
  });
  return { socket, dispatched };
}

async function runUntilStopped(socket: Socket, signal: AbortSignal): Promise<void> {
  try {
    await socket.run(signal);
  } catch {
    // most of these tests stop the socket by aborting; a stray rejection is
    // not what they check
  }
}

describe('wired through Socket', () => {
  it('prints connected once, on the first hello, using botName/commandCount', async () => {
    const gateway = await startGateway(async (conn) => {
      conn.send({
        op: 'hello',
        d: { session_id: 'sess_1234567890', heartbeat_interval_ms: 20, resuming_from_sequence: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth, { botName: 'acme.bot', commandCount: 4 });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() =>
          lines.some((l) => l.includes('aurival: connected — acme.bot, session sess_123')),
        );
        expect(ok, `never saw connected in: ${JSON.stringify(lines)}`).toBe(true);
        expect(lines.some((l) => l.includes('4 commands registered'))).toBe(true);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('prints reconnecting on a network-fault close, then reconnected on the next hello', async () => {
    let attempt = 0;
    const gateway = await startGateway(async (conn) => {
      attempt += 1;
      if (attempt === 1) {
        conn.send({ op: 'hello', d: { session_id: 's1', heartbeat_interval_ms: 20 } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        conn.close(); // no `bye` — a bare network fault
        return;
      }
      conn.send({ op: 'hello', d: { session_id: 's2', heartbeat_interval_ms: 20 } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const sawReconnecting = await waitUntil(() =>
          lines.some((l) => l.includes('connection closed (network error), reconnecting in')),
        );
        expect(sawReconnecting, `never saw reconnecting in: ${JSON.stringify(lines)}`).toBe(true);
        const sawReconnected = await waitUntil(() =>
          lines.some((l) => l.startsWith('aurival: reconnected after')),
        );
        expect(sawReconnected, `never saw reconnected in: ${JSON.stringify(lines)}`).toBe(true);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('prints reconnecting with the bye code on a short-wait bye', async () => {
    let attempt = 0;
    const gateway = await startGateway(async (conn) => {
      attempt += 1;
      if (attempt === 1) {
        conn.send({ op: 'hello', d: { session_id: 's1', heartbeat_interval_ms: 20 } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        conn.send(byeFrame('idle_timeout', 'api_error'));
        return;
      }
      conn.send({ op: 'hello', d: { session_id: 's2', heartbeat_interval_ms: 20 } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() =>
          lines.some((l) => l.includes('connection closed (idle_timeout), reconnecting in')),
        );
        expect(ok, `never saw it in: ${JSON.stringify(lines)}`).toBe(true);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('prints stopped once, with the bye message, on a raise-action bye', async () => {
    const gateway = await startGateway(async (conn) => {
      conn.send({ op: 'hello', d: { session_id: 's1', heartbeat_interval_ms: 20 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      conn.send(byeFrame('key_revoked', 'authentication_error'));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth);
      const controller = new AbortController();
      await expect(socket.run(controller.signal)).rejects.toBeInstanceOf(AurivalAPIError);
      const stoppedLines = lines.filter((l) => l.startsWith('aurival: stopped —'));
      expect(stoppedLines, `saw: ${JSON.stringify(lines)}`).toEqual([
        'aurival: stopped — key_revoked: bye: key_revoked',
      ]);
    } finally {
      await gateway.close();
    }
  });

  it('prints disconnected with uptime on a clean SIGINT-style stop', async () => {
    const gateway = await startGateway(async (conn) => {
      conn.send({ op: 'hello', d: { session_id: 's1', heartbeat_interval_ms: 20 } });
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      const connectedOk = await waitUntil(() => lines.some((l) => l.includes('connected —')));
      expect(connectedOk).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      await task;
      expect(lines.some((l) => l.startsWith('aurival: disconnected after'))).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it('is completely silent end to end when quiet: true', async () => {
    let attempt = 0;
    const gateway = await startGateway(async (conn) => {
      attempt += 1;
      if (attempt === 1) {
        conn.send({ op: 'hello', d: { session_id: 's1', heartbeat_interval_ms: 20 } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        conn.close();
        return;
      }
      conn.send({ op: 'hello', d: { session_id: 's2', heartbeat_interval_ms: 20 } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      setTTY(false);
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeWiredSocket(http, auth, { quiet: true });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await waitUntil(() => false, 150); // give reconnect a real chance to fire
      } finally {
        controller.abort();
        await task;
      }
      expect(lines).toEqual([]);
    } finally {
      await gateway.close();
    }
  });
});
