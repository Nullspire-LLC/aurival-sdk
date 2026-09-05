/**
 * Every row of the `bye` table gets a behavioural test: a real in-process
 * websocket server sends the actual `bye`, and we assert on what
 * `Socket.run()` DOES — reconnect, wait, or raise — never on `BYE_ACTIONS`
 * directly.
 */

import { describe, expect, it } from 'vitest';
import { AuthenticationError, AurivalAPIError } from '../src/errors.js';
import { ByeAction, actionForBye } from '../src/socket.js';
import { FakeAuth, FakeHttpClient, makeSocket } from './socket.test.js';
import { byeFrame, sendHello, startGateway, waitUntil } from './wsserver.js';

// --------------------------------------------------------------------------
// action_for_bye: pure fallback logic, independent of the table's contents
// --------------------------------------------------------------------------

describe('actionForBye', () => {
  it('ignores the type for a known code', () => {
    expect(actionForBye('key_revoked', 'invalid_request_error')).toBe(ByeAction.RAISE);
  });

  it.each([
    ['api_error', ByeAction.SHORT_WAIT_RECONNECT],
    ['authentication_error', ByeAction.RAISE],
    ['invalid_request_error', ByeAction.RAISE],
    ['permission_error', ByeAction.RAISE],
    ['rate_limit_error', ByeAction.RAISE],
  ] as const)('falls back on type %s -> %s for an unknown code', (errorType, expected) => {
    expect(actionForBye('some_future_code_not_in_the_table', errorType)).toBe(expected);
  });
});

// --------------------------------------------------------------------------
// access_token_expired: reauth, reconnect NOW, no backoff, "once" per
// connection (not per process)
// --------------------------------------------------------------------------

describe('access_token_expired', () => {
  it('reconnects immediately, twice per connection', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx < 2) {
        sendHello(conn);
        conn.send(byeFrame('access_token_expired', 'authentication_error'));
      } else {
        sendHello(conn);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 3, 2000);
        expect(ok, `only ${gateway.state.connectCount} connections, want 3`).toBe(true);
        expect(auth.refreshCalls).toBe(2);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('reconnects immediately, not backed off', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn);
        conn.send(byeFrame('access_token_expired', 'authentication_error'));
      } else {
        sendHello(conn);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      // backoff_base is large; if REAUTH_RECONNECT ever slept on it, the
      // second connection would land far later than immediate.
      const { socket } = makeSocket(http, auth, { backoffBase: 5, backoffCap: 5 });
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 2000);
        expect(ok).toBe(true);
        const elapsed = gateway.state.connectTimes[1]! - gateway.state.connectTimes[0]!;
        expect(
          elapsed,
          `reconnect took ${elapsed}s — that's a backoff, not immediate`,
        ).toBeLessThan(0.5);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('raises when the re-exchange itself fails with AuthenticationError', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(byeFrame('access_token_expired', 'authentication_error'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      auth.failRefreshNext(
        new AuthenticationError({
          type: 'authentication_error',
          code: 'bad_assertion',
          message: 'x',
          doc_url: 'x',
        }),
      );
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        await expect(socket.run(controller.signal)).rejects.toBeInstanceOf(AuthenticationError);
        expect(gateway.state.connectCount, 'reconnected despite the re-exchange failing').toBe(1);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// The nine RAISE codes: no reconnect
// --------------------------------------------------------------------------

const RAISE_CODES: ReadonlyArray<readonly [string, string]> = [
  ['key_revoked', 'authentication_error'],
  ['key_already_paired', 'authentication_error'],
  ['access_token_invalid', 'authentication_error'],
  ['session_superseded', 'invalid_request_error'],
  ['frame_too_large', 'invalid_request_error'],
  ['bot_suspended', 'permission_error'],
  // SDK-39: these three arrive as a `bye` at HEAD on the fiftieth `problem`
  // (gateway.go's MaxSocketProblemsBeforeBye) — the table names them, not
  // `too_many_problems`, which has no producing path yet.
  ['frame_invalid', 'invalid_request_error'],
  ['unknown_operation', 'invalid_request_error'],
  ['ack_unknown_event', 'invalid_request_error'],
];

describe.each(RAISE_CODES)('bye code %s raises and never reconnects', (code, errorType) => {
  it('raises and never reconnects', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(byeFrame(code, errorType));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        let caught: unknown;
        try {
          await socket.run(controller.signal);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(AurivalAPIError);
        expect((caught as AurivalAPIError).code).toBe(code);
        expect(
          gateway.state.connectCount,
          'reconnected after a code the table says to raise on',
        ).toBe(1);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// server_restarting / idle_timeout: ONE short jittered wait, not escalating
// --------------------------------------------------------------------------

describe.each(['server_restarting', 'idle_timeout'] as const)('bye code %s', (code) => {
  it('reconnects with one short wait, not escalating', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn);
        conn.send(byeFrame(code, 'api_error'));
      } else {
        sendHello(conn);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      // Fixed jitter (0.5) makes both waits deterministic:
      //   short wait  = 0.02 + 0.5*(0.03-0.02) = 0.025s
      //   escalating  = 0.5 * 0.01 * 2**0       = 0.005s
      // Chosen apart so a mutation to the escalating path is visible either way.
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 2000);
        expect(ok).toBe(true);
        const elapsed = gateway.state.connectTimes[1]! - gateway.state.connectTimes[0]!;
        expect(elapsed, `elapsed=${elapsed}, not a single short wait`).toBeGreaterThanOrEqual(
          0.015,
        );
        expect(elapsed).toBeLessThanOrEqual(0.5);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// Unknown bye code: falls back on the ERRORS-V1 type, behaviourally
// --------------------------------------------------------------------------

describe('unknown bye code', () => {
  it('reconnects when the type is api_error', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn);
        conn.send(byeFrame('brand_new_code_not_in_any_table', 'api_error'));
      } else {
        sendHello(conn);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 2000);
        expect(ok, 'an unknown api_error-typed bye did not reconnect').toBe(true);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('raises when the type is anything else', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(byeFrame('brand_new_code_not_in_any_table', 'invalid_request_error'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        await expect(socket.run(controller.signal)).rejects.toBeInstanceOf(AurivalAPIError);
        expect(gateway.state.connectCount).toBe(1);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await gateway.close();
    }
  });
});
