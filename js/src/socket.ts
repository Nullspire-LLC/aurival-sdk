/**
 * The live connection: `hello`, heartbeat, dispatch, acks, `problem`/`bye`
 * handling, reconnect (SOCKET-V1, DECISIONS SDK-23..28, SDK-39).
 *
 * There are no WebSocket close codes in this API — every close is 1000, and a
 * close with no `bye` is a network fault, never a designed signal. The `bye`
 * payload is the only error channel; never branch on a close code.
 */

import {
  AuthenticationError,
  AurivalAPIError,
  ProtocolError,
  TransportError,
  fromEnvelope,
} from './errors.js';
import { Event } from './events.js';
import type { Auth } from './auth.js';
import { defaultLogger } from './http.js';
import type { HttpClient, Logger } from './http.js';
import * as status from './status.js';

export const EVENT_COMMAND_INVOKED = 'command.invoked';
export const EVENT_BACKLOG_OVERFLOWED = 'backlog.overflowed';

/**
 * A plain frozen object rather than a TS `enum`: `enum` would change the
 * runtime shape of a name the package exports (SDK-7).
 */
export const ByeAction = {
  /** re-exchange, reconnect NOW, no backoff */
  REAUTH_RECONNECT: 'reauth_reconnect',
  /** ONE jittered wait, 1-5s, not escalating */
  SHORT_WAIT_RECONNECT: 'short_wait',
  /** stop; this is a bug, not a blip */
  RAISE: 'raise',
} as const;

export type ByeAction = (typeof ByeAction)[keyof typeof ByeAction];

/**
 * The table, exactly (SOCKET-V1 §4, PLAN.md "The socket, exactly", SDK-39).
 * `frame_invalid`/`unknown_operation`/`ack_unknown_event` are here because they
 * arrive as a `bye` on the fiftieth `problem` (gateway.go's
 * MaxSocketProblemsBeforeBye) — not because a `problem` frame is fatal; a
 * `problem` never is.
 */
export const BYE_ACTIONS: Readonly<Record<string, ByeAction>> = {
  access_token_expired: ByeAction.REAUTH_RECONNECT,
  key_revoked: ByeAction.RAISE,
  key_already_paired: ByeAction.RAISE,
  access_token_invalid: ByeAction.RAISE,
  session_superseded: ByeAction.RAISE,
  frame_too_large: ByeAction.RAISE,
  frame_invalid: ByeAction.RAISE,
  unknown_operation: ByeAction.RAISE,
  ack_unknown_event: ByeAction.RAISE,
  too_many_problems: ByeAction.RAISE,
  bot_suspended: ByeAction.RAISE,
  server_restarting: ByeAction.SHORT_WAIT_RECONNECT,
  idle_timeout: ByeAction.SHORT_WAIT_RECONNECT,
};

/**
 * Unknown code falls back on the ERRORS-V1 `type` (SDK-11 / BA-R24):
 * `api_error` reconnects (a short wait, matching `server_restarting` and
 * `idle_timeout`, its only other members), everything else raises.
 */
export function actionForBye(code: string, errorType: string): ByeAction {
  const action = BYE_ACTIONS[code];
  if (action !== undefined) return action;
  return errorType === 'api_error' ? ByeAction.SHORT_WAIT_RECONNECT : ByeAction.RAISE;
}

export interface SocketOptions {
  dispatch: (event: Event) => Promise<void>;
  onProblem: (problem: AurivalAPIError | Event) => void;
  logger?: Logger | undefined;
  seenLimit?: number | undefined;
  backoffBase?: number | undefined;
  backoffCap?: number | undefined;
  shortWaitRange?: readonly [number, number] | undefined;
  jitter?: (() => number) | undefined;
  /** Snapshot at construction time — printed once, on the first `hello` (SDK status banners). */
  botName?: string | undefined;
  commandCount?: number | undefined;
  quiet?: boolean | undefined;
}

const DEFAULT_HEARTBEAT_MS = 30_000;

/** A frame the read loop can wait on without sitting behind a raw callback. */
type ConnEvent = { kind: 'message'; data: string | null } | { kind: 'close' } | { kind: 'error' };

/** Bridges `ws.onmessage`/`onclose`/`onerror` callbacks into an awaitable queue. */
class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

/** Resolves `'aborted'` the instant `signal` fires, without waiting on `promise`. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve('aborted');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/** `true` if `signal` fired during the wait — a SIGINT must never sit behind a sleep. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve(true);
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One bot's live connection. `run(signal)` owns reconnect forever, until the
 * signal aborts or a `bye` says the credential itself is dead.
 */
export class Socket {
  readonly #http: HttpClient;
  readonly #auth: Auth;
  readonly #dispatch: (event: Event) => Promise<void>;
  readonly #onProblem: (problem: AurivalAPIError | Event) => void;
  readonly #logger: Logger;
  readonly #seenLimit: number;
  readonly #backoffBase: number;
  readonly #backoffCap: number;
  readonly #shortWaitRange: readonly [number, number];
  readonly #jitter: () => number;
  readonly #botName: string;
  readonly #commandCount: number;
  readonly #quiet: boolean;

  readonly #seen = new Map<string, undefined>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #generation = 0;
  #backoffN = 0;
  /** Set the instant a connection ends, cleared on the `hello` that follows — the span is what `reconnected after <duration>` reports. */
  #droppedAt: number | null = null;
  /** First `hello` this run ever saw — distinguishes `connected` from `reconnected`, and anchors `disconnected after <uptime>`. */
  #firstConnectedAt: number | null = null;

  constructor(http: HttpClient, auth: Auth, options: SocketOptions) {
    this.#http = http;
    this.#auth = auth;
    this.#dispatch = options.dispatch;
    this.#onProblem = options.onProblem;
    this.#logger = options.logger ?? defaultLogger();
    this.#seenLimit = options.seenLimit ?? 10_000;
    this.#backoffBase = options.backoffBase ?? 1;
    this.#backoffCap = options.backoffCap ?? 60;
    this.#shortWaitRange = options.shortWaitRange ?? [1, 5];
    this.#jitter = options.jitter ?? Math.random;
    this.#botName = options.botName ?? '';
    this.#commandCount = options.commandCount ?? 0;
    this.#quiet = status.isQuiet(options.quiet);
  }

  async run(signal: AbortSignal): Promise<void> {
    const runStartedAt = Date.now();
    try {
      await this.#runLoop(signal);
    } finally {
      // Only a clean stop (SIGINT/SIGTERM) reports `disconnected` — a `raise`
      // throws through this same `finally` with the signal still live, so
      // the guard keeps the two banners from ever overlapping.
      if (signal.aborted) {
        status.disconnected(Date.now() - (this.#firstConnectedAt ?? runStartedAt), this.#quiet);
      }
    }
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let token: string;
      try {
        token = await this.#auth.token();
      } catch (err) {
        if (err instanceof AuthenticationError) throw err;
        if (
          err instanceof AurivalAPIError ||
          err instanceof TransportError ||
          err instanceof ProtocolError
        ) {
          if (await this.#sleepBackoff(signal, 'network error')) return;
          continue;
        }
        throw err;
      }

      let bye: AurivalAPIError | null;
      try {
        const ws = await this.#connect(this.#http.gatewayUrl(), token, signal);
        bye = await this.#runConnection(ws, signal);
      } catch {
        bye = null;
        if (signal.aborted) return;
        if (await this.#sleepBackoff(signal, 'network error')) return;
        continue;
      }

      if (signal.aborted) return;

      if (bye === null) {
        // A close with no `bye`: a network fault, never a designed signal
        // (SOCKET-V1 §1). Escalating backoff, unbounded.
        if (await this.#sleepBackoff(signal, 'network error')) return;
        continue;
      }

      const action = actionForBye(bye.code, bye.type);
      if (action === ByeAction.RAISE) {
        status.stopped(bye.code, bye.message, this.#quiet);
        throw bye;
      }
      if (action === ByeAction.REAUTH_RECONNECT) {
        this.#markDropped();
        try {
          await this.#auth.refresh();
        } catch (err) {
          if (err instanceof AuthenticationError) throw err;
          // The exchange itself is unwell (e.g. `/v1/token` 5xx): keep
          // backing off, never raise (SDK-26).
          if (await this.#sleepBackoff(signal, 'network error')) return;
        }
        continue; // reconnect NOW — no backoff, "once" per connection
      }
      if (action === ByeAction.SHORT_WAIT_RECONNECT) {
        if (await this.#shortWait(signal, bye.code)) return;
        continue;
      }
    }
  }

  #connect(url: string, token: string, signal: AbortSignal): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      let settled = false;
      const cleanup = (): void => {
        ws.onopen = null;
        ws.onerror = null;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // ignore — we're abandoning this connection anyway
        }
        reject(new Error('aborted'));
      };
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ws);
      };
      // Never log or attach the event here (SDK-33): a refused handshake is
      // ordinary (a token that aged out during a reconnect does it), and this
      // request carries an Authorization header.
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('websocket connect failed'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Reads frames until the socket closes. Returns the `bye` error if one
   * arrived, else `null` — a network-fault close, per SOCKET-V1 §1.
   */
  async #runConnection(ws: WebSocket, signal: AbortSignal): Promise<AurivalAPIError | null> {
    this.#generation += 1;
    const generation = this.#generation;
    const queue = new AsyncQueue<ConnEvent>();
    ws.onmessage = (ev) => {
      const data: unknown = ev.data;
      queue.push({ kind: 'message', data: typeof data === 'string' ? data : null });
    };
    ws.onclose = () => queue.push({ kind: 'close' });
    ws.onerror = () => queue.push({ kind: 'error' });

    let stopHeartbeat: (() => void) | null = null;
    try {
      for (;;) {
        const item = await raceAbort(queue.next(), signal);
        if (item === 'aborted') {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return null;
        }
        if (item.kind === 'close' || item.kind === 'error') return null;
        if (item.data === null) continue; // not a text frame; ignored, never fatal

        let raw: unknown;
        try {
          raw = JSON.parse(item.data);
        } catch {
          continue;
        }
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const frame = raw as Record<string, unknown>;
        const op = frame['op'];
        const dRaw = frame['d'];
        const d =
          typeof dRaw === 'object' && dRaw !== null && !Array.isArray(dRaw)
            ? (dRaw as Record<string, unknown>)
            : {};

        if (op === 'hello') {
          const intervalMs = d['heartbeat_interval_ms'];
          const heartbeatMs =
            typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_MS;
          // We reached a live session: the next fault is a fresh problem, not
          // a continuation of the last one.
          this.#backoffN = 0;
          stopHeartbeat?.();
          stopHeartbeat = this.#startHeartbeat(ws, heartbeatMs);

          const sessionId = typeof d['session_id'] === 'string' ? d['session_id'] : '';
          if (this.#firstConnectedAt === null) {
            this.#firstConnectedAt = Date.now();
            status.connected(this.#botName, sessionId, this.#commandCount, this.#quiet);
          } else {
            const droppedAt = this.#droppedAt;
            this.#droppedAt = null;
            if (droppedAt !== null) status.reconnected(Date.now() - droppedAt, this.#quiet);
          }
        } else if (op === 'heartbeat_ack') {
          // ignore
        } else if (op === 'event') {
          await this.#handleEvent(ws, d, generation);
        } else if (op === 'problem') {
          const exc = fromEnvelope(d);
          this.#logger.warn(`bot-api problem: ${exc.code}: ${exc.message}`);
          this.#onProblem(exc);
        } else if (op === 'bye') {
          const exc = fromEnvelope(d);
          this.#logger.warn(`bot-api bye: ${exc.code}: ${exc.message}`);
          return exc;
        }
        // else: unknown op. Ignored, never fatal (CONTRACT-V1 §3, §9).
      }
    } finally {
      stopHeartbeat?.();
    }
  }

  /** Its own timer, never on the dispatch path — a slow handler must not starve it. */
  #startHeartbeat(ws: WebSocket, intervalMs: number): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      if (stopped) return;
      if (ws.readyState !== WebSocket.OPEN) return; // the read loop will notice
      try {
        ws.send(JSON.stringify({ op: 'heartbeat', d: {} }));
      } catch {
        return; // connection is gone
      }
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }

  async #handleEvent(ws: WebSocket, d: Record<string, unknown>, generation: number): Promise<void> {
    const event = Event.fromFrame(d);
    if (!event.id) return;
    if (this.#inFlight.has(event.id)) return; // never dispatch an id whose handler is in flight
    if (this.#seen.has(event.id)) {
      // Already ran to completion — possibly on a prior connection whose ack
      // got dropped when it died mid-flight, and this is that same event
      // redelivered. Don't run the handler again; a duplicate ack of a real
      // event is harmless, and skipping it here would leave the server
      // redelivering forever.
      await this.#ack(ws, event.id, generation);
      return;
    }

    if (event.type === EVENT_BACKLOG_OVERFLOWED) {
      // An event, not a problem — it goes to the log and the hook, never to a
      // handler (SDK-28). NOT acked: it has no durable row, so acking it
      // would earn `ack_unknown_event` right back.
      this.#logger.warn(
        `backlog overflowed: dropped=${String(event.data['dropped_count'])} resume_sequence=${String(event.data['resume_sequence'])}`,
      );
      this.#onProblem(event);
      this.#markSeen(event.id);
      return;
    }

    if (event.type !== EVENT_COMMAND_INVOKED) {
      // Unknown event type: ignored, never fatal — the first additive type
      // must not break the fleet. Unlike `backlog.overflowed` this is
      // presumed durable, so it is acked to keep the stream moving rather
      // than redelivered forever (SDK-40).
      this.#logger.debug(`ignoring unknown event type ${event.type}`);
      this.#markSeen(event.id);
      await this.#ack(ws, event.id, generation);
      return;
    }

    const handled = this.#runHandler(ws, event, generation);
    this.#inFlight.set(event.id, handled);
    handled.catch(() => {
      // The handler is expected not to throw (bot.ts wraps handler calls);
      // if it does anyway, the ack above already ran in the `finally`.
    });
  }

  async #runHandler(ws: WebSocket, event: Event, generation: number): Promise<void> {
    try {
      await this.#dispatch(event);
    } finally {
      this.#inFlight.delete(event.id);
      this.#markSeen(event.id);
      // Across a reconnect the handler still finishes, but its ack is
      // dropped — redelivery on the new connection covers it (SDK-27).
      if (generation === this.#generation) {
        await this.#ack(ws, event.id, generation);
      }
    }
  }

  async #ack(ws: WebSocket, eventId: string, generation: number): Promise<void> {
    if (generation !== this.#generation || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ op: 'ack', d: { event_id: eventId } }));
    } catch {
      // the connection died under us; redelivery covers it
    }
  }

  #markSeen(eventId: string): void {
    this.#seen.set(eventId, undefined);
    if (this.#seen.size > this.#seenLimit) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }

  async #sleepBackoff(signal: AbortSignal, reason: string): Promise<boolean> {
    const base = Math.min(this.#backoffCap, this.#backoffBase * 2 ** this.#backoffN);
    this.#backoffN += 1;
    const actualSeconds = this.#jitter() * base;
    this.#markDropped();
    status.reconnecting(reason, actualSeconds, this.#quiet);
    return interruptibleSleep(actualSeconds * 1000, signal);
  }

  async #shortWait(signal: AbortSignal, reason: string): Promise<boolean> {
    const [lo, hi] = this.#shortWaitRange;
    const delaySeconds = lo + this.#jitter() * (hi - lo);
    this.#markDropped();
    status.reconnecting(reason, delaySeconds, this.#quiet);
    return interruptibleSleep(delaySeconds * 1000, signal);
  }

  /** First fault of an outage sets the clock; later retries in the same outage must not reset it. */
  #markDropped(): void {
    if (this.#droppedAt === null) this.#droppedAt = Date.now();
  }
}
