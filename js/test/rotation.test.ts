/**
 * Proactive access-token rotation (SDK bot-api-curation, lane E seam S2).
 *
 * The server bye's a bot every ~15 minutes with `access_token_expired`
 * (SOCKET-V1 REAUTH_RECONNECT). This adds a SDK-side timer that refreshes
 * ahead of that, at `expires_at - headroom - jitter`, then does a clean
 * client close (code 1000) and reconnects immediately with the new token —
 * never printing a status line for it, and never touching the reactive
 * fallback's own behaviour if the proactive refresh itself fails.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOKEN_REFRESH_HEADROOM_MS } from '../src/auth.js';
import { Socket } from '../src/socket.js';
import { FakeAuth, FakeHttpClient, makeCapturingLogger, makeSocket } from './socket.test.js';
import { byeFrame, sendHello, startGateway, waitUntil } from './wsserver.js';

async function runUntilStopped(socket: Socket, signal: AbortSignal): Promise<void> {
  try {
    await socket.run(signal);
  } catch {
    // most tests stop the socket by aborting
  }
}

// --------------------------------------------------------------------------
// (a) fires at expires_at - headroom ± jitter, refresh BEFORE close, closes
//     1000, reconnects with the new token, prints nothing
// --------------------------------------------------------------------------

describe('proactive rotation', () => {
  it('refreshes, closes with code 1000, reconnects with the new token, and prints no status line', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
    try {
      const auth = new FakeAuth();
      // Deadline = expiresAt - headroom - jitter = (now+headroom+300) - headroom - 25 = now+275ms
      auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS + 300);
      const http = new FakeHttpClient(gateway.url);
      const { logger, records } = makeCapturingLogger();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { socket } = makeSocket(http, auth, {
          logger,
          rotationJitterMs: 50, // jitter fixed at 0.5 in makeSocket -> 25ms subtracted
          // Production's real 30s floor would swallow this test's timing;
          // override it to something well under the computed deadline so the
          // deadline itself (not the floor) governs when rotation fires.
          minRotationIntervalMs: 50,
        });
        const controller = new AbortController();
        const task = runUntilStopped(socket, controller.signal);
        try {
          const ok = await waitUntil(() => gateway.state.connectCount >= 2, 3000);
          expect(ok, `only ${gateway.state.connectCount} connections, want 2`).toBe(true);

          expect(auth.refreshCalls, 'never refreshed the token').toBeGreaterThanOrEqual(1);

          const close0 = gateway.state.closeFor(0);
          expect(close0, 'no close frame observed on the first connection').not.toBeNull();
          expect(close0?.code, 'rotation must close with code 1000').toBe(1000);

          // refresh must complete strictly before the close frame lands
          const refreshedAt = auth.refreshCompletedAt[0];
          expect(refreshedAt, 'refresh never recorded a completion time').toBeDefined();
          expect(refreshedAt as number).toBeLessThanOrEqual(close0!.at + 0.05);

          expect(
            records.some(
              (r) => r.level === 'debug' && r.message === 'aurival: rotating access token',
            ),
            `debug records: ${JSON.stringify(records)}`,
          ).toBe(true);

          expect(
            errorSpy.mock.calls.some(
              (c) => String(c[0]).includes('reconnecting') || String(c[0]).includes('reconnected'),
            ),
            `expected no reconnect status line, saw: ${JSON.stringify(errorSpy.mock.calls)}`,
          ).toBe(false);
        } finally {
          controller.abort();
          await task;
        }
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// (b) refresh failure -> no close; the bye fallback still reconnects
// --------------------------------------------------------------------------

describe('proactive rotation: refresh failure', () => {
  it('does not close the connection, and the reactive bye fallback still reconnects', async () => {
    let attempt = 0;
    const gateway = await startGateway(async (conn, idx) => {
      attempt += 1;
      if (idx === 0) {
        sendHello(conn, 20);
        // Give the (failing) rotation timer time to fire, then the server
        // sends the ordinary reactive bye, exactly as it does every ~15min.
        await new Promise((resolve) => setTimeout(resolve, 400));
        conn.send(byeFrame('access_token_expired', 'authentication_error'));
      } else {
        sendHello(conn, 20);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    try {
      const auth = new FakeAuth();
      auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS + 200);
      auth.failRefreshNext(new Error('exchange unavailable'));
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth, { rotationJitterMs: 20, minRotationIntervalMs: 50 });
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        // The reactive bye still lands and still reconnects.
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 3000);
        expect(ok, `only ${gateway.state.connectCount} connections`).toBe(true);

        // The failed proactive attempt must never have closed connection 0 —
        // only the server's own bye (sent at ~0.4s) may have. A rotation
        // close would show up around the ~0.19s deadline instead; the
        // client's own close-handshake echo of the server's bye-close is a
        // DIFFERENT close frame that always carries code 1000 too, so what
        // actually distinguishes "did rotation close it" is timing, not code.
        const close0 = gateway.state.closeFor(0);
        if (close0 !== null) {
          expect(
            close0.at,
            `a close landed at ${close0.at}s — too early to be the server's own bye`,
          ).toBeGreaterThanOrEqual(0.35);
        }
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
    void attempt;
  });
});

// --------------------------------------------------------------------------
// (c) status-line gating: unplanned drop prints both lines; rotation prints
//     neither
// --------------------------------------------------------------------------

describe('status line gating', () => {
  it('an unplanned drop prints reconnecting then reconnected', async () => {
    let attempt = 0;
    const gateway = await startGateway(async (conn) => {
      attempt += 1;
      if (attempt === 1) {
        sendHello(conn, 20);
        await new Promise((resolve) => setTimeout(resolve, 30));
        conn.close(); // bare close, no bye -> network fault
        return;
      }
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const lines: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        const auth = new FakeAuth();
        const http = new FakeHttpClient(gateway.url);
        const { socket } = makeSocket(http, auth);
        const controller = new AbortController();
        const task = runUntilStopped(socket, controller.signal);
        try {
          const sawReconnecting = await waitUntil(() =>
            lines.some((l) => l.includes('connection closed (network error), reconnecting in')),
          );
          expect(sawReconnecting, `never saw reconnecting in: ${JSON.stringify(lines)}`).toBe(
            true,
          );
          const sawReconnected = await waitUntil(() =>
            lines.some((l) => l.startsWith('aurival: reconnected after')),
          );
          expect(sawReconnected, `never saw reconnected in: ${JSON.stringify(lines)}`).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await gateway.close();
    }
  });

  it('a proactive rotation prints neither reconnecting nor reconnected', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
    try {
      const lines: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        const auth = new FakeAuth();
        auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS + 300);
        const http = new FakeHttpClient(gateway.url);
        const { socket } = makeSocket(http, auth, { rotationJitterMs: 50, minRotationIntervalMs: 50 });
        const controller = new AbortController();
        const task = runUntilStopped(socket, controller.signal);
        try {
          const ok = await waitUntil(() => gateway.state.connectCount >= 2, 3000);
          expect(ok, `only ${gateway.state.connectCount} connections`).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 100)); // let a stray hello handler run
          expect(
            lines.some((l) => l.includes('reconnecting') || l.includes('reconnected')),
            `expected no reconnect status lines, saw: ${JSON.stringify(lines)}`,
          ).toBe(false);
        } finally {
          controller.abort();
          await task;
        }
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// (d) log level for `bot-api bye: access_token_expired` vs everything else
// --------------------------------------------------------------------------

describe('bye log level', () => {
  it('logs access_token_expired at DEBUG', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn);
        conn.send(byeFrame('access_token_expired', 'authentication_error'));
      } else {
        sendHello(conn);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { logger, records } = makeCapturingLogger();
      const { socket } = makeSocket(http, auth, { logger });
      const controller = new AbortController();
      const task = socket.run(controller.signal).catch(() => {});
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 2000);
        expect(ok).toBe(true);
      } finally {
        controller.abort();
        await task;
      }
      const byeRecords = records.filter((r) => r.message.startsWith('bot-api bye:'));
      expect(byeRecords, `records: ${JSON.stringify(records)}`).toEqual([
        { level: 'debug', message: expect.stringContaining('access_token_expired') },
      ]);
    } finally {
      await gateway.close();
    }
  });

  it('logs every other bye code at WARNING', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(byeFrame('key_revoked', 'authentication_error'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { logger, records } = makeCapturingLogger();
      const { socket } = makeSocket(http, auth, { logger });
      const controller = new AbortController();
      await socket.run(controller.signal).catch(() => {});
      const byeRecords = records.filter((r) => r.message.startsWith('bot-api bye:'));
      expect(byeRecords, `records: ${JSON.stringify(records)}`).toEqual([
        { level: 'warn', message: expect.stringContaining('key_revoked') },
      ]);
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// Regression: a rotation whose `refresh()` is still in flight when its
// connection ends (a `bye` beat it, or a bare fault beat it) must not
// pollute a LATER connection once that stale `refresh()` finally resolves —
// `#rotating` may only ever be set by the timer that belongs to the CURRENT
// generation.
// --------------------------------------------------------------------------

describe('rotation flag does not leak across connections', () => {
  it('a stale rotation refresh resolving during a LATER connection must not mask that connection\'s real fault', async () => {
    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn, 20);
        // Wait past the rotation deadline (~120ms — see expiresAtMs below,
        // comfortably above the test's own 50ms minRotationIntervalMs floor)
        // so the timer has already fired and called refresh(), which the
        // test is holding open, BEFORE this bye is sent. The connection is
        // still fully open (its own close never happened — refresh() hasn't
        // resolved), so the bye is received normally and ends this
        // connection first.
        await new Promise((resolve) => setTimeout(resolve, 320));
        conn.send(byeFrame('server_restarting', 'api_error'));
        return;
      }
      if (idx === 1) {
        sendHello(conn, 20);
        // Give the test time to release the held refresh WHILE this
        // connection is live, then this connection ends with a genuine
        // network fault (bare close, no bye).
        await new Promise((resolve) => setTimeout(resolve, 200));
        conn.close();
        return;
      }
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const lines: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        const auth = new FakeAuth();
        // Rotation fires ~130ms into idx0 (well before idx0's bye, which the
        // gateway sends as soon as it connects — the timer still gets armed
        // and its refresh() call started before that bye is processed).
        auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS + 130);
        const release = auth.holdNextRefresh();
        const http = new FakeHttpClient(gateway.url);
        // A distinctive backoff makes a real sleepBackoff visually obvious
        // against an "immediate, no backoff" reconnect (a masked fault's gap
        // would be near 0ms; a real one is ~250ms here).
        const { socket } = makeSocket(http, auth, {
          rotationJitterMs: 20,
          minRotationIntervalMs: 50,
          backoffBase: 0.25,
          backoffCap: 0.25,
          jitter: () => 0.5,
        });
        const controller = new AbortController();
        const task = runUntilStopped(socket, controller.signal);
        // idx0's rotation timer was already armed (at hello time) against
        // the short TTL above. Bump `expiresAtMs` to something far in the
        // future shortly after — well before idx1 connects, but after idx0's
        // deadline was captured — so idx1's OWN `hello` computes a deadline
        // far away and never arms a rotation of its own. Without this, idx1
        // would independently want to rotate too, confounding the assertion
        // below (which is specifically about idx0's STALE refresh, not a
        // fresh one idx1 legitimately triggered).
        setTimeout(() => auth.setExpiresAtMs(Date.now() + 10 * TOKEN_REFRESH_HEADROOM_MS), 200);
        try {
          // idx0 ends via the bye (SHORT_WAIT_RECONNECT) long before the
          // held refresh() ever resolves, so idx0's rotation never actually
          // fires its own close.
          const reachedIdx1 = await waitUntil(() => gateway.state.connectCount >= 2, 3000);
          expect(reachedIdx1, 'never reached the second connection').toBe(true);

          // NOW, while idx1 is live, let idx0's stale refresh() resolve.
          // Before the generation guard, this would set `#rotating = true`
          // on the Socket instance while idx1 owns it.
          release();
          // Wait for the STALE refresh to actually COMPLETE (refreshCalls
          // increments the instant refresh() is entered, before the held
          // gate resolves — refreshCompletedAt only grows once it finishes).
          await waitUntil(() => auth.refreshCompletedAt.length >= 1, 2000);

          const reachedIdx2 = await waitUntil(() => gateway.state.connectCount >= 3, 4000);
          expect(reachedIdx2, `only ${gateway.state.connectCount} connections, want 3`).toBe(
            true,
          );

          // idx1's bare close is a genuine fault. It must still be
          // announced and backed off — never silently masked as "our own
          // planned rotation" by the stale refresh from idx0.
          expect(
            lines.some((l) => l.includes('connection closed (network error), reconnecting in')),
            `idx1's genuine fault must still print reconnecting; saw: ${JSON.stringify(lines)}`,
          ).toBe(true);

          const gap = gateway.state.connectTimes[2]! - gateway.state.connectTimes[1]!;
          expect(
            gap,
            `gap between idx1 and idx2 was ${gap}s — too small to be a real backoff sleep ` +
              `(bug: the stale rotation refresh leaked #rotating into idx1's connection)`,
          ).toBeGreaterThan(0.1);
        } finally {
          controller.abort();
          await task;
        }
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// Regression: a token TTL at or under the refresh headroom must not turn
// rotation into a hot refresh/close/redial loop. `MIN_ROTATION_INTERVAL_MS`
// bounds how OFTEN the cycle may repeat, not just a single computed
// deadline — a per-rotation clamp on a negative timeout is not enough,
// because the very next connection recomputes the same negative deadline.
// --------------------------------------------------------------------------

describe('rotation floor bounds the whole cycle, not just one timeout', () => {
  it('successive rotations for a too-short TTL are spaced by at least the floor, not ~immediate', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
    try {
      const auth = new FakeAuth();
      // At or under the headroom: expires_at - headroom - jitter is already
      // in the past on EVERY connection this test's floor is a small,
      // injected one — production's real default is exercised separately
      // below, where a 30s wait would make the test suite far too slow.
      auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS - 5000);
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth, {
        rotationJitterMs: 0,
        minRotationIntervalMs: 300,
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 4, 4000);
        expect(ok, `only ${gateway.state.connectCount} connections, want >= 4`).toBe(true);

        // Every successive pair of connections is a rotation (the deadline
        // is always in the past, so the floor — not the deadline — governs
        // every single one of them). Each gap must be at least the floor,
        // not the ~0ms a negative-deadline clamp alone would allow once the
        // cycle repeats.
        for (let i = 1; i < gateway.state.connectTimes.length; i += 1) {
          const gap = gateway.state.connectTimes[i]! - gateway.state.connectTimes[i - 1]!;
          expect(
            gap,
            `gap ${i} was ${gap}s — rotation fired faster than the ${300}ms floor allows`,
          ).toBeGreaterThanOrEqual(0.29); // 300ms floor, 10ms slack for scheduling jitter
        }
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('with no override, a too-short TTL does not rotate again within a couple of seconds (real 30s floor)', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn, 20);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
    try {
      const auth = new FakeAuth();
      auth.setExpiresAtMs(Date.now() + TOKEN_REFRESH_HEADROOM_MS - 5000);
      const http = new FakeHttpClient(gateway.url);
      // No minRotationIntervalMs override: production's real 30s floor.
      // Under the old 250ms-style floor this would already have rotated
      // several times within this window.
      const { socket } = makeSocket(http, auth, { rotationJitterMs: 0 });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(
          gateway.state.connectCount,
          'rotated within 1.5s despite no override — the real floor is not 30s',
        ).toBe(1);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });
});
