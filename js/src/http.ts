/**
 * The REST lane. One retry policy lives here (SDK-26/SDK-35/SDK-37) so every
 * caller — `bot.ts`, `Context.reply`, pairing — gets it for free. Nothing from
 * `fetch` escapes: every failure becomes one of `./errors.js`'s errors.
 */

import { randomUUID } from 'node:crypto';
import * as errors from './errors.js';
import type { Auth } from './auth.js';

export const DEFAULT_HOST = 'https://bots.aurival.com';

// Both the rate-limit lane and the api_error/transport lane are bounded here
// (SDK-26): this many tries total, first attempt included.
const MAX_ATTEMPTS = 5;
// A `retry_after` longer than this is not a transient the request should wait
// out (SDK-40). The generic rate limit is retried INSIDE whatever awaited the
// request, which for a reply is the command handler, and the handler holds the
// event's ack open for as long as it runs. A server once answered 600 s; the
// bot then slept ten minutes per command, every unacked event was redelivered
// every 30 s behind it, and the whole chat looked dead. Past this bound the
// error is thrown at once and the handler decides.
const MAX_RETRY_AFTER_MS = 15_000;
const DEFAULT_RETRY_AFTER_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Node has no stdlib logger, so this is the seam Python's `logging.Logger`
 * occupies. `defaultLogger` mirrors an unconfigured `logging.getLogger`:
 * warnings and errors reach stderr, debug and info are dropped unless
 * `AURIVAL_DEBUG` is set.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function emit(level: string, message: string, args: unknown[]): void {
  process.stderr.write(`aurival ${level}: ${message}${args.length ? ' ' + args.join(' ') : ''}\n`);
}

export function defaultLogger(): Logger {
  const verbose = Boolean(process.env['AURIVAL_DEBUG']);
  return {
    debug: (m, ...a) => {
      if (verbose) emit('debug', m, a);
    },
    info: (m, ...a) => {
      if (verbose) emit('info', m, a);
    },
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
  };
}

export interface RequestOptions {
  body?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  authenticated?: boolean | undefined;
  idempotencyKey?: string | undefined;
  retryAuth?: boolean | undefined;
}

/** A non-JSON body, or JSON that is not an object, is a `ProtocolError`. */
function decodeObject(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (exc) {
    const detail = exc instanceof Error ? exc.message : String(exc);
    throw new errors.ProtocolError(`response body was not valid JSON: ${detail}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new errors.ProtocolError('response body was not a JSON object');
  }
  return data as Record<string, unknown>;
}

function envelopeBody(envelope: Record<string, unknown>): Record<string, unknown> {
  const inner = envelope['error'];
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : envelope;
}

function retryAfterMs(header: string | null, envelope: Record<string, unknown>): number {
  if (header !== null) {
    const parsed = Number(header);
    if (Number.isFinite(parsed)) return Math.max(0, parsed * 1000);
  }
  const value = envelopeBody(envelope)['retry_after'];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000);
  return DEFAULT_RETRY_AFTER_MS;
}

// attempt is 1-based. Plain exponential, capped — the shape doesn't matter much
// here since every test injects the sleep; being bounded does.
function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

export class HttpClient {
  readonly #host: string;
  readonly #auth: Auth | null;
  readonly #logger: Logger;
  /** Injectable so a retry/backoff test never actually waits. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  constructor(host: string, auth: Auth | null = null, logger?: Logger) {
    this.#host = host.replace(/\/+$/, '');
    this.#auth = auth;
    this.#logger = logger ?? defaultLogger();
  }

  /** Returns the decoded JSON body. Throws only SDK errors. */
  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const baseHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.idempotencyKey !== undefined) {
      // Generated once by the caller and reused verbatim across every retry of
      // this call (SDK-30) — never regenerated per attempt.
      baseHeaders['Idempotency-Key'] = options.idempotencyKey;
    }
    const authenticated = options.authenticated ?? true;
    const retryAuth = options.retryAuth ?? true;

    const url = this.#host + path;
    let authRetried = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const headers: Record<string, string> = { ...baseHeaders };
      if (authenticated) {
        if (this.#auth === null) {
          throw new errors.AurivalError('request() needs an authenticated Auth but none was given');
        }
        headers['Authorization'] = `Bearer ${await this.#auth.token()}`;
      }

      let status: number;
      let raw: string;
      let retryAfterHeader: string | null;
      try {
        const init: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        };
        if (options.body !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(options.body);
        }
        const resp = await fetch(url, init);
        status = resp.status;
        raw = await resp.text();
        retryAfterHeader = resp.headers.get('Retry-After');
      } catch (exc) {
        // NOTHING about `exc` is logged or attached (SDK-33): a fetch failure
        // carries a `cause` chain that can reach back to the request, and this
        // request has an Authorization header on it. Only the bare message.
        const detail = exc instanceof Error ? exc.message : String(exc);
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(backoffDelayMs(attempt));
          continue;
        }
        throw new errors.TransportError(detail);
      }

      // 204 + an empty body decodes to `{}` — several new mutating routes
      // (typing, reactions, delete) answer this way. A 204 that (against
      // spec) carries a JSON body decodes it rather than silently dropping
      // it, gating on the body being empty rather than on status alone —
      // mirrors http.py's identical rule (merge-gate senior review). In
      // practice `raw` is ALWAYS '' here: the WHATWG fetch spec forces a
      // null body for every 204/205/304 response, so `resp.text()` above
      // already discarded whatever bytes the server actually sent before
      // this line runs (verified against Node's own `fetch`). This branch
      // stays correct for whatever `raw` it is given regardless — python's
      // http.py reads raw socket bytes and is not subject to this
      // fetch-specific stripping, so the decode path is live there. An empty
      // 200 (or any other non-204 success) is still a ProtocolError: every
      // other status decodes unconditionally, so an empty body only becomes
      // {} through the 204 branch, exactly as before this change.
      if (status === 204) return raw === '' ? {} : decodeObject(raw);
      if (status < 400) return decodeObject(raw);

      const envelope = decodeObject(raw);
      const retryAfter = retryAfterMs(retryAfterHeader, envelope);
      const exc = errors.fromEnvelope(envelope, { status, retryAfter: retryAfter / 1000 });

      if (exc instanceof errors.AuthenticationError) {
        const expiredOrInvalid =
          exc.code === 'access_token_expired' || exc.code === 'access_token_invalid';
        if (authenticated && expiredOrInvalid && retryAuth && !authRetried && this.#auth !== null) {
          authRetried = true;
          await this.#auth.refresh();
          continue;
        }
        throw exc;
      }

      if (exc instanceof errors.RateLimitError) {
        // Only the generic `rate_limited` retries here. `pair_rate_limited` and
        // `sync_rate_limited` are owned by their callers (auth.pair, bot.ts's
        // background sync per SDK-35) — retrying them here would make
        // syncCommands swallow SyncRateLimited, which it must not.
        if (exc.constructor === errors.RateLimited && attempt < MAX_ATTEMPTS) {
          if (retryAfter > MAX_RETRY_AFTER_MS) {
            this.#logger.warn(
              `rate limited for ${(retryAfter / 1000).toFixed(0)}s, longer than the ${(MAX_RETRY_AFTER_MS / 1000).toFixed(0)}s this client will wait; throwing`,
            );
            throw exc;
          }
          this.#logger.warn(`rate limited, retrying after ${(retryAfter / 1000).toFixed(1)}s`);
          await this.sleep(retryAfter);
          continue;
        }
        throw exc;
      }

      if (exc instanceof errors.APIError) {
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(backoffDelayMs(attempt));
          continue;
        }
        throw exc;
      }

      // invalid_request_error, permission_error: never retried.
      throw exc;
    }
  }

  /**
   * `replyTo` is a `msg_` reference and is OMITTED when absent — the field is
   * optional on the wire (CONTRACT-V1 §5.0) and a `null` there is a
   * `parameter_invalid` waiting to happen.
   */
  async sendMessage(
    chat: string,
    text: string,
    idempotencyKey: string,
    replyTo?: string | null,
    mentions?: Array<{ user: string }>,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { chat, text };
    if (replyTo != null && replyTo !== '') body['reply_to'] = replyTo;
    if (mentions !== undefined && mentions.length > 0) body['mentions'] = mentions;
    return this.request('POST', '/v1/messages', { body, idempotencyKey });
  }

  /** `POST .../typing` body is `{"is_typing": true|false}` — never `state`. */
  async setTyping(chat: string, isTyping: boolean): Promise<void> {
    await this.request('POST', `/v1/chats/${chat}/typing`, {
      body: { is_typing: isTyping },
      idempotencyKey: randomUUID(),
    });
  }

  async editMessage(message: string, text: string): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/messages/${message}`, {
      body: { text },
      idempotencyKey: randomUUID(),
    });
  }

  async deleteMessage(message: string): Promise<void> {
    await this.request('DELETE', `/v1/messages/${message}`, { idempotencyKey: randomUUID() });
  }

  /** The emoji is percent-encoded — it travels in the path, not the body. */
  async setReaction(message: string, emoji: string): Promise<void> {
    await this.request('PUT', `/v1/messages/${message}/reactions/${encodeURIComponent(emoji)}`, {
      idempotencyKey: randomUUID(),
    });
  }

  async unsetReaction(message: string, emoji: string): Promise<void> {
    await this.request('DELETE', `/v1/messages/${message}/reactions/${encodeURIComponent(emoji)}`, {
      idempotencyKey: randomUUID(),
    });
  }

  /** GET, so no idempotency key — reads are never retried-as-a-write. */
  async listMembers(chat: string, cursor?: string): Promise<Record<string, unknown>> {
    const query =
      cursor !== undefined && cursor !== '' ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request('GET', `/v1/chats/${chat}/members${query}`);
  }

  async syncCommands(
    bot: string,
    commands: Array<{ name: string; description: string }>,
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/v1/bots/${bot}/commands`, {
      body: { commands },
      idempotencyKey: randomUUID(),
    });
  }

  async listCommands(bot: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/bots/${bot}/commands`);
  }

  gatewayUrl(): string {
    let base: string;
    if (this.#host.startsWith('https://')) base = 'wss://' + this.#host.slice('https://'.length);
    else if (this.#host.startsWith('http://')) base = 'ws://' + this.#host.slice('http://'.length);
    else base = this.#host;
    return base + '/v1/gateway';
  }
}
