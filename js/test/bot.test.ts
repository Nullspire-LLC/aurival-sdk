/**
 * `conflicts` at sync (S11). The field has been on the wire since
 * AMENDMENT-01 A-5.2 and both SDKs dropped it silently, which is exactly the
 * silence it exists to end: the developer whose command never fires.
 */

import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { reportConflicts, syncCommandsAndReport } from '../src/bot.js';
import { HttpClient } from '../src/http.js';
import type { Logger } from '../src/http.js';
import type { Auth } from '../src/auth.js';

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
