/**
 * Behavioural tests for `Socket`: a real in-process websocket server sends
 * the actual frames, and we assert on what the socket DOES — never on
 * `BYE_ACTIONS` directly (that agrees with itself and can never fail).
 *
 * Shared harness (`FakeAuth`, `FakeHttpClient`, `makeSocket`) is exported for
 * `bye-table.test.ts` to reuse, mirroring `test_socket.py`.
 */

import { describe, expect, it } from 'vitest';
import type { Auth } from '../src/auth.js';
import type { AurivalAPIError } from '../src/errors.js';
import type { Event } from '../src/events.js';
import type { HttpClient, Logger } from '../src/http.js';
import { Socket } from '../src/socket.js';
import {
  backlogOverflowedEvent,
  commandInvokedEvent,
  deferred,
  problemFrame,
  sendHello,
  startGateway,
  waitUntil,
} from './wsserver.js';

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

/** Duck-types `Auth`: `token()` / `refresh()` / `expiresAtMs`. Errors queue FIFO. */
export class FakeAuth {
  tokenCalls = 0;
  refreshCalls = 0;
  /** `performance.now()`-scale seconds `refresh()` last completed at —
   * comparable with `wsserver.ts`'s `ReceivedClose.at`, so a test can prove
   * refresh happened BEFORE a close, not just that it happened at all. */
  refreshCompletedAt: number[] = [];
  expiresAtMs: number | null = null;
  #token: string;
  #tokenErrors: Error[] = [];
  #refreshErrors: Error[] = [];
  #nextExpiresAtMs: number | null = null;

  constructor(token = 'tok-0') {
    this.#token = token;
  }

  failTokenNext(err: Error): void {
    this.#tokenErrors.push(err);
  }

  failRefreshNext(err: Error): void {
    this.#refreshErrors.push(err);
  }

  /** Sets `expiresAtMs` now, and what it becomes again after the NEXT
   * successful `refresh()` (a real exchange always renews the expiry). */
  setExpiresAtMs(ms: number | null): void {
    this.expiresAtMs = ms;
    this.#nextExpiresAtMs = ms;
  }

  #refreshGate: Promise<void> | null = null;

  /** Makes the NEXT `refresh()` call hang until the returned function is
   * invoked — lets a test deterministically reproduce a rotation whose
   * refresh is still in flight when the connection that started it has
   * already moved on (SDK bot-api-curation: a stale rotation must not
   * pollute a LATER connection once its own refresh finally resolves). */
  #onRefreshEntered: (() => void) | null = null;

  /** Makes the NEXT `refresh()` call hang until `release()` is invoked, and
   * resolves `started` the INSTANT that call is actually entered (before it
   * starts waiting on the gate) — lets a test await the real event instead
   * of guessing a wall-clock delay for it. Used to deterministically
   * reproduce a rotation whose refresh is still in flight when the
   * connection that started it has already moved on (SDK
   * bot-api-curation: a stale rotation must not pollute a LATER connection
   * once its own refresh finally resolves). */
  holdNextRefresh(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    this.#refreshGate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      this.#onRefreshEntered = resolve;
    });
    return { started, release };
  }

  async token(): Promise<string> {
    this.tokenCalls += 1;
    const err = this.#tokenErrors.shift();
    if (err) throw err;
    return this.#token;
  }

  async refresh(): Promise<string> {
    this.refreshCalls += 1;
    if (this.#refreshGate) {
      const gate = this.#refreshGate;
      this.#refreshGate = null; // only the one held call waits
      this.#onRefreshEntered?.();
      this.#onRefreshEntered = null;
      await gate;
    }
    const err = this.#refreshErrors.shift();
    if (err) throw err;
    this.#token = `${this.#token}+r${this.refreshCalls}`;
    if (this.#nextExpiresAtMs !== null) this.expiresAtMs = this.#nextExpiresAtMs;
    this.refreshCompletedAt.push(performance.now() / 1000);
    return this.#token;
  }
}

/** Duck-types `HttpClient`: only `gatewayUrl()` is exercised here. */
export class FakeHttpClient {
  #url: string;
  constructor(url: string) {
    this.#url = url;
  }
  gatewayUrl(): string {
    return this.#url;
  }
}

export interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export function makeCapturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const logger: Logger = {
    debug: (m) => records.push({ level: 'debug', message: m }),
    info: (m) => records.push({ level: 'info', message: m }),
    warn: (m) => records.push({ level: 'warn', message: m }),
    error: (m) => records.push({ level: 'error', message: m }),
  };
  return { logger, records };
}

export interface MakeSocketOverrides {
  dispatch?: ((event: Event) => Promise<void>) | undefined;
  onProblem?: ((p: AurivalAPIError | Event) => void) | undefined;
  logger?: Logger | undefined;
  seenLimit?: number | undefined;
  backoffBase?: number | undefined;
  backoffCap?: number | undefined;
  shortWaitRange?: readonly [number, number] | undefined;
  jitter?: (() => number) | undefined;
  rotationJitterMs?: number | undefined;
  minRotationIntervalMs?: number | undefined;
}

export interface MadeSocket {
  socket: Socket;
  dispatched: Event[];
  problems: Array<AurivalAPIError | Event>;
}

/**
 * Deterministic, millisecond-scale waits — the same code path production
 * uses, just tiny numbers and a fixed (non-random) jitter.
 */
export function makeSocket(
  http: FakeHttpClient,
  auth: FakeAuth,
  overrides: MakeSocketOverrides = {},
): MadeSocket {
  const dispatched: Event[] = [];
  const problems: Array<AurivalAPIError | Event> = [];
  const dispatch = async (event: Event): Promise<void> => {
    dispatched.push(event);
    if (overrides.dispatch) await overrides.dispatch(event);
  };
  const onProblem = (p: AurivalAPIError | Event): void => {
    problems.push(p);
    overrides.onProblem?.(p);
  };
  const socket = new Socket(http as unknown as HttpClient, auth as unknown as Auth, {
    dispatch,
    onProblem,
    logger: overrides.logger,
    seenLimit: overrides.seenLimit,
    backoffBase: overrides.backoffBase ?? 0.01,
    backoffCap: overrides.backoffCap ?? 0.05,
    shortWaitRange: overrides.shortWaitRange ?? [0.02, 0.03],
    jitter: overrides.jitter ?? (() => 0.5),
    rotationJitterMs: overrides.rotationJitterMs,
    minRotationIntervalMs: overrides.minRotationIntervalMs,
  });
  return { socket, dispatched, problems };
}

async function runUntilStopped(socket: Socket, signal: AbortSignal): Promise<void> {
  try {
    await socket.run(signal);
  } catch {
    // most tests stop the socket by aborting; a stray rejection from that
    // path is not what these tests are checking
  }
}

// --------------------------------------------------------------------------
// Heartbeat: its own task, off the dispatch path
// --------------------------------------------------------------------------

describe('heartbeat', () => {
  it('keeps flowing while the handler is slow', async () => {
    let handlerStarted = false;
    const gateway = await startGateway(async (conn) => {
      sendHello(conn, 20);
      conn.send(commandInvokedEvent('evt_1'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth, {
        dispatch: async () => {
          handlerStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 150)); // much longer than the 20ms heartbeat
        },
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await waitUntil(() => handlerStarted);
        const ok = await waitUntil(() => gateway.state.heartbeatsFor(0) >= 3, 1000);
        expect(ok, `only ${gateway.state.heartbeatsFor(0)} heartbeats while handler slept`).toBe(
          true,
        );
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
// Ack timing: only after the handler returns
// --------------------------------------------------------------------------

describe('ack timing', () => {
  it('acks a command.invoked event only after the handler returns', async () => {
    const { promise: released, resolve: release } = deferred();
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEvent('evt_1'));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket, dispatched } = makeSocket(http, auth, {
        dispatch: async () => {
          await released;
        },
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await waitUntil(() => dispatched.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(gateway.state.acksFor(0)).toEqual([]);
        release();
        const ok = await waitUntil(() => {
          const acks = gateway.state.acksFor(0);
          return acks.length === 1 && acks[0] === 'evt_1';
        });
        expect(ok, 'never acked after the handler returned').toBe(true);
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
// Dedupe
// --------------------------------------------------------------------------

describe('dedupe', () => {
  it('runs the handler once for a redelivered completed id, and re-acks it', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEvent('evt_dup'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      conn.send(commandInvokedEvent('evt_dup')); // redelivered, already done
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket, dispatched } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(
          () => gateway.state.acksFor(0).filter((id) => id === 'evt_dup').length >= 2,
          1000,
        );
        expect(ok).toBe(true);
        expect(dispatched.length, `handler ran ${dispatched.length} times, want 1`).toBe(1);
        expect(gateway.state.acksFor(0).filter((id) => id === 'evt_dup').length).toBe(2);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('never dispatches an id whose handler is still in flight', async () => {
    let started = false;
    const { promise: released, resolve: release } = deferred();
    let runCount = 0;
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(commandInvokedEvent('evt_inflight'));
      for (let i = 0; i < 200 && !started; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      conn.send(commandInvokedEvent('evt_inflight')); // arrives while still in flight
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth, {
        dispatch: async () => {
          runCount += 1;
          started = true;
          await released;
        },
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await waitUntil(() => started);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runCount).toBe(1);
        release();
        const ok = await waitUntil(() => {
          const acks = gateway.state.acksFor(0);
          return acks.length === 1 && acks[0] === 'evt_inflight';
        });
        expect(ok).toBe(true);
        expect(runCount, 'the still-in-flight redelivery ran the handler again').toBe(1);
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
// Unknown op / unknown event type: ignored, never fatal — unknown type IS acked
// --------------------------------------------------------------------------

describe('unknown op and unknown event type', () => {
  it('are ignored, acks the unknown type, and the socket survives', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send({ op: 'something_new_from_the_future', d: {} });
      conn.send({
        op: 'event',
        d: {
          object: 'event',
          id: 'evt_future',
          type: 'reaction.added', // a type this SDK does not know
          created_at: '2026-01-01T00:00:00Z',
          sequence: 2,
          data: {},
        },
      });
      conn.send(commandInvokedEvent('evt_after'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket, dispatched } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_after'));
        expect(ok, 'socket did not survive the unknown op / unknown event type').toBe(true);
        expect(dispatched.length).toBe(1);
        expect(dispatched[0]?.id).toBe('evt_after');
        expect(gateway.state.acksFor(0)).toContain('evt_future');
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
// `problem`: WARN + hook, socket survives
// --------------------------------------------------------------------------

describe('problem frame', () => {
  it('reaches the hook, logs at warn, and the socket survives', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(problemFrame('ack_unknown_event'));
      conn.send(commandInvokedEvent('evt_after'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { logger, records } = makeCapturingLogger();
      const { socket, problems } = makeSocket(http, auth, { logger });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_after'));
        expect(ok, 'socket did not survive the problem frame').toBe(true);
      } finally {
        controller.abort();
        await task;
      }
      expect(problems.length).toBe(1);
      const problem = problems[0] as AurivalAPIError;
      expect(problem.code).toBe('ack_unknown_event');
      expect(records.some((r) => r.level === 'warn')).toBe(true);
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// backlog.overflowed: log + hook, never a handler, never acked
// --------------------------------------------------------------------------

describe('backlog.overflowed', () => {
  it('goes to the log and the hook, never a handler, and is never acked', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.send(backlogOverflowedEvent());
      conn.send(commandInvokedEvent('evt_after'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { logger, records } = makeCapturingLogger();
      const { socket, dispatched, problems } = makeSocket(http, auth, { logger });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.acksFor(0).includes('evt_after'));
        expect(ok).toBe(true);
      } finally {
        controller.abort();
        await task;
      }
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.id).toBe('evt_after');
      expect(problems.length).toBe(1);
      expect((problems[0] as Event).type).toBe('backlog.overflowed');
      expect(gateway.state.acksFor(0)).not.toContain('evt_bo');
      expect(records.some((r) => r.level === 'warn')).toBe(true);
    } finally {
      await gateway.close();
    }
  });
});

// --------------------------------------------------------------------------
// Across a reconnect: in-flight handlers finish, their ack is dropped,
// redelivery is re-acked without re-running.
// --------------------------------------------------------------------------

describe('reconnect', () => {
  it('drops a stale ack and re-acks the redelivery without rerunning the handler', async () => {
    let started = false;
    const { promise: released, resolve: release } = deferred();
    const { promise: redeliverPromise, resolve: redeliverNow } = deferred();
    let runCount = 0;

    const gateway = await startGateway(async (conn, idx) => {
      if (idx === 0) {
        sendHello(conn);
        conn.send(commandInvokedEvent('evt_x'));
        // Die while the handler is still in flight — no bye, a bare close.
        await new Promise((resolve) => setTimeout(resolve, 50));
        conn.close();
      } else {
        sendHello(conn);
        await redeliverPromise;
        conn.send(commandInvokedEvent('evt_x'));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth, {
        dispatch: async () => {
          runCount += 1;
          started = true;
          await released;
        },
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        await waitUntil(() => started);
        await waitUntil(() => gateway.state.connectCount >= 2);
        expect(runCount, 'the handler must not have been cancelled').toBe(1);
        release();
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the stale handler finish and drop its ack
        expect(gateway.state.acksFor(0), 'an ack was sent on the dead connection').toEqual([]);
        redeliverNow();
        const ok = await waitUntil(() => gateway.state.acksFor(1).includes('evt_x'), 2000);
        expect(ok, 'the redelivered event was never acked on the new connection').toBe(true);
        expect(runCount, 'the handler ran again instead of just re-acking').toBe(1);
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
// No `bye`: escalating backoff
// --------------------------------------------------------------------------

describe('close with no bye', () => {
  it('backs off and reconnects', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.close(); // bare close, no bye — a network fault by contract
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 2, 2000);
        expect(ok, 'never reconnected after a bare close').toBe(true);
      } finally {
        controller.abort();
        await task;
      }
    } finally {
      await gateway.close();
    }
  });

  it('escalates: successive reconnect gaps actually grow', async () => {
    // No `hello` here on purpose: a `hello` resets the backoff counter to 0
    // (we reached a live session), which would flatten every gap in this
    // test back to the base delay and defeat the point of it.
    const gateway = await startGateway(async (conn) => {
      conn.close();
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      // Fixed jitter, so the delay sequence is deterministic:
      // base=0.15, cap=3 -> 0.075, 0.15, 0.3 ... (halved by jitter=0.5), each
      // step comfortably clear of the ~10-15ms real-connection overhead a
      // tighter base would get lost in.
      const { socket } = makeSocket(http, auth, {
        backoffBase: 0.15,
        backoffCap: 3,
        jitter: () => 0.5,
      });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => gateway.state.connectCount >= 4, 5000);
        expect(ok).toBe(true);
        const gap1 = gateway.state.connectTimes[1]! - gateway.state.connectTimes[0]!;
        const gap2 = gateway.state.connectTimes[2]! - gateway.state.connectTimes[1]!;
        const gap3 = gateway.state.connectTimes[3]! - gateway.state.connectTimes[2]!;
        expect(gap2, `gaps were ${gap1}, ${gap2}, ${gap3} — not escalating`).toBeGreaterThan(
          gap1 * 1.3,
        );
        expect(gap3).toBeGreaterThan(gap2 * 1.3);
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
// `/v1/token` 5xx during a reconnect: keep backing off, never raise
// --------------------------------------------------------------------------

describe('token fetch failure', () => {
  it('keeps backing off during reconnect and never raises', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      conn.close();
    });
    try {
      const { InternalError } = await import('../src/errors.js');
      const auth = new FakeAuth();
      auth.failTokenNext(
        new InternalError({
          type: 'api_error',
          code: 'internal_error',
          message: 'x',
          doc_url: 'x',
        }),
      );
      auth.failTokenNext(
        new InternalError({
          type: 'api_error',
          code: 'internal_error',
          message: 'x',
          doc_url: 'x',
        }),
      );
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      let rejected = false;
      const task = socket.run(controller.signal).catch(() => {
        rejected = true;
      });
      try {
        const ok = await waitUntil(() => auth.tokenCalls >= 3, 2000);
        expect(ok, 'gave up asking for a token instead of backing off').toBe(true);
        expect(rejected, 'run() raised instead of backing off on a token 5xx').toBe(false);
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
// Seen-set bound
// --------------------------------------------------------------------------

describe('seen-set bound', () => {
  it('evicts oldest-first and stays bounded at seenLimit', async () => {
    const total = 25;
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      for (let i = 0; i < total; i += 1) {
        conn.send(commandInvokedEvent(`evt_${i}`, i));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Redeliver the very first id — it should have been evicted, so this
      // dispatches a SECOND time rather than being treated as already-seen.
      conn.send(commandInvokedEvent('evt_0', 0));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket, dispatched } = makeSocket(http, auth, { seenLimit: 10 });
      const controller = new AbortController();
      const task = runUntilStopped(socket, controller.signal);
      try {
        const ok = await waitUntil(() => dispatched.length >= total, 2000);
        expect(ok).toBe(true);
        await waitUntil(() => dispatched.filter((e) => e.id === 'evt_0').length >= 2, 1000);
        expect(dispatched.filter((e) => e.id === 'evt_0').length).toBe(2);
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
// Abort mid-connection: unwinds cleanly and promptly
// --------------------------------------------------------------------------

describe('abort', () => {
  it('unwinds cleanly and promptly mid-connection', async () => {
    const gateway = await startGateway(async (conn) => {
      sendHello(conn);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
    try {
      const auth = new FakeAuth();
      const http = new FakeHttpClient(gateway.url);
      const { socket } = makeSocket(http, auth);
      const controller = new AbortController();
      const task = socket.run(controller.signal);
      await waitUntil(() => gateway.state.connectCount >= 1);
      const start = performance.now();
      controller.abort();
      await task;
      const elapsed = performance.now() - start;
      expect(elapsed, `abort took ${elapsed}ms to unwind`).toBeLessThan(500);
    } finally {
      await gateway.close();
    }
  });
});
