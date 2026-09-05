/**
 * The socket's connect path, under SDK-33.
 *
 * A refused handshake is ordinary — a token that aged out during a reconnect
 * does it. So the failure must never reach a log line or a thrown error's
 * message/stack, and this is the test that says so.
 */

import util from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Auth } from '../src/auth.js';
import type { HttpClient } from '../src/http.js';
import { Socket } from '../src/socket.js';
import { startRefusingGateway, waitUntil } from './wsserver.js';

const TOKEN = 'attok_never_log_this_particular_value_12345';

class FixedAuth {
  bot = 'bot_1';
  async token(): Promise<string> {
    return TOKEN;
  }
  async refresh(): Promise<string> {
    return TOKEN;
  }
}

describe('socket redaction', () => {
  it('never leaks the token across a failed websocket handshake', async () => {
    const gateway = await startRefusingGateway();
    try {
      const auth = new FixedAuth();
      const http = { gatewayUrl: () => gateway.url } as unknown as HttpClient;

      const logLines: string[] = [];
      const caughtErrors: unknown[] = [];
      const logger = {
        debug: (m: string, ...a: unknown[]) => logLines.push(format(m, a)),
        info: (m: string, ...a: unknown[]) => logLines.push(format(m, a)),
        warn: (m: string, ...a: unknown[]) => logLines.push(format(m, a)),
        error: (m: string, ...a: unknown[]) => logLines.push(format(m, a)),
      };
      function format(m: string, a: unknown[]): string {
        return [m, ...a].join(' ');
      }

      const socket = new Socket(http, auth as unknown as Auth, {
        dispatch: async () => {
          throw new Error('nothing should be dispatched over a refused handshake');
        },
        onProblem: () => {},
        logger,
        backoffBase: 0.01,
        backoffCap: 0.02,
      });

      const controller = new AbortController();
      const runPromise = socket.run(controller.signal).catch((err: unknown) => {
        caughtErrors.push(err);
      });

      // A few refused handshakes and backoffs.
      await waitUntil(() => gateway.seenAuth.length >= 3, 1000);
      controller.abort();
      await runPromise;

      // The negative assertion below is worthless unless the token really
      // went out on the wire — otherwise "not in the log" is trivially true.
      expect(gateway.seenAuth.length, 'the handshake never reached the server').toBeGreaterThan(0);
      expect(gateway.seenAuth[0], 'the socket did not send the token it was given').toContain(
        TOKEN,
      );

      const haystack =
        logLines.join('\n') +
        '\n' +
        caughtErrors
          .map((e) => (e instanceof Error ? (e.stack ?? e.message) : String(e)))
          .join('\n') +
        '\n' +
        caughtErrors.map((e) => util.inspect(e, { depth: 10 })).join('\n');

      expect(haystack, 'the access token reached a log line or thrown error').not.toContain(TOKEN);
    } finally {
      await gateway.close();
    }
  });
});
