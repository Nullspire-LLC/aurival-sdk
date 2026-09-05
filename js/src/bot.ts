/** The developer-facing surface: declare commands, call run(), we hold the socket. */

import { Auth, KeyFile, machineLabel, pair, resolveHost } from './auth.js';
import type { Machine, MachineKey } from './auth.js';
import { AurivalError, RateLimitError } from './errors.js';
import { Context, Event } from './events.js';
import { DEFAULT_HOST, HttpClient, defaultLogger } from './http.js';
import type { Command } from './events.js';
import type { Logger } from './http.js';
import { Socket } from './socket.js';
import * as status from './status.js';

export type Handler = (ctx: Context) => Promise<void> | void;

/**
 * The hook also receives a `backlog.overflowed` Event, which is operational
 * rather than an error — it never reaches a handler (SDK-28).
 */
export type Reportable = unknown | Event;
export type ErrorHook = (error: Reportable, ctx: Context | null) => Promise<void> | void;

/** How long a clean shutdown waits for handlers that are still running (SDK-32). */
export const SHUTDOWN_GRACE_MS = 10_000;

export interface BotOptions {
  host?: string | undefined;
  keyPath?: string | undefined;
  logger?: Logger | undefined;
  /** Silences the `aurival: …` status banners on stderr. `AURIVAL_QUIET=1` does the same. */
  quiet?: boolean | undefined;
}

interface Registered {
  command: Command;
  handler: Handler;
}

// Mirrors the server's own normalisation (commands.go) so `Ping` finds the
// handler for the `ping` that comes back on the wire. Not validation.
function lookupKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Load the key file, or pair this machine and save one.
 *
 * `Bot.start` and `aurival init` both come through here, so the code and the
 * fingerprint print identically either way (SDK-43) — the printout is the thing
 * a developer compares in the app, and two spellings of it would drift.
 */
export async function ensurePaired(
  http: HttpClient,
  keyFile: KeyFile,
  host: string,
  log: Logger,
  signal: AbortSignal,
): Promise<{ key: MachineKey; machine: Machine; paired: boolean }> {
  const loaded = await keyFile.load();
  if (loaded !== null) return { ...loaded, paired: false };
  const { key, machine } = await pair(http, {
    machineLabel: machineLabel(),
    host,
    out: (line) => process.stdout.write(line + '\n'),
    logger: log,
    signal,
  });
  await keyFile.save(key, machine);
  return { key, machine, paired: true };
}

/**
 * The one door to command sync, so the lane that syncs is always the lane that
 * reports. Both `Bot` call sites go through here.
 *
 * Exported for the tests, not from `index.ts` — the package's export list
 * mirrors Python's `__all__` (SDK-7) and this is not on it.
 */
export async function syncCommandsAndReport(
  http: HttpClient,
  bot: string,
  payload: Array<{ name: string; description: string }>,
  log: Logger,
): Promise<void> {
  reportConflicts(await http.syncCommands(bot, payload), log);
}

/**
 * One warning line per shadowed chat (S11). Silently dropping `conflicts` is
 * the silence the field exists to end: the developer whose command never fires.
 *
 * The wire carries chat references and deliberately not the other bot
 * (server.go's handleReplaceCommands), so the chat id is all a line can name.
 */
export function reportConflicts(response: Record<string, unknown>, log: Logger): void {
  const rows = response['data'];
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const conflicts = record['conflicts'];
    if (!Array.isArray(conflicts)) continue;
    for (const chat of conflicts) {
      if (typeof chat !== 'string' || chat === '') continue;
      log.warn(`/${name} is shadowed by another bot in ${chat}, so it will not reach you there`);
    }
  }
}

/**
 * A bot. Register commands, then `run()`.
 *
 * First run pairs this machine: it prints a code, you approve it in the app, and
 * the key lands in ./.aurival/. Every later run just starts.
 */
export class Bot {
  readonly #registered = new Map<string, Registered>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #log: Logger;
  readonly #host: string | undefined;
  readonly #keyPath: string | undefined;
  #errorHook: ErrorHook | null = null;
  #http: HttpClient | null = null;
  readonly #quiet: boolean;

  constructor(options: BotOptions = {}) {
    this.#log = options.logger ?? defaultLogger();
    this.#host = options.host;
    this.#keyPath = options.keyPath;
    this.#quiet = status.isQuiet(options.quiet);
  }

  // -- registration ------------------------------------------------------

  /**
   * Declare a command. The name is sent as written — the server is the
   * validator (SDK-29), and it lowercases and trims before it checks.
   */
  command(name: string, handler: Handler): void;
  command(name: string, description: string, handler: Handler): void;
  command(name: string, second: string | Handler, third?: Handler): void {
    const description = typeof second === 'string' ? second : '';
    const handler = typeof second === 'string' ? third : second;
    if (handler === undefined) throw new AurivalError(`command(${name}) needs a handler`);
    this.#registered.set(lookupKey(name), { command: { name, description }, handler });
  }

  /**
   * Called with (error, context | null) for anything the SDK caught for you: a
   * handler that threw, a `problem` frame, a backlog overflow.
   */
  onError(fn: ErrorHook): void {
    this.#errorHook = fn;
  }

  // -- running -----------------------------------------------------------

  /** Installs signal handlers and runs until SIGINT/SIGTERM or something fatal. */
  async run(): Promise<void> {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await this.start(controller.signal);
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    const host = this.#host ?? resolveHost();
    if (host !== DEFAULT_HOST) {
      // Printed, not logged: a redirected host is the first thing to check when
      // nothing works, and a logger set to WARNING would hide it.
      process.stdout.write(`aurival: using ${host}\n`);
    }

    const abort = signal ?? new AbortController().signal;
    const unauth = new HttpClient(host, null, this.#log);
    const keyFile = new KeyFile(this.#keyPath ?? null);
    const { key, machine } = await ensurePaired(unauth, keyFile, host, this.#log, abort);

    // The key file's own path, so a `key_revoked` says which file to remove
    // (S7) — including when AURIVAL_KEY_PATH put it somewhere unexpected.
    const auth = new Auth(unauth, key, machine, this.#log, keyFile.path);
    const http = new HttpClient(host, auth, this.#log);
    this.#http = http;

    const syncRetry = await this.#syncCommands(http, machine.bot, abort);

    status.connecting(machine.bot, this.#quiet);
    const socket = new Socket(http, auth, {
      dispatch: (event) => this.#dispatch(event),
      onProblem: (problem) => {
        void this.#callErrorHook(problem, null);
      },
      logger: this.#log,
      botName: machine.bot,
      commandCount: this.#registered.size,
      quiet: this.#quiet,
    });
    try {
      await socket.run(abort);
    } finally {
      syncRetry?.cancel();
      await this.#drainHandlers();
    }
  }

  /** A bounded wait, then go anyway. A clean close earns no `bye`, correctly. */
  async #drainHandlers(): Promise<void> {
    if (this.#inflight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.#inflight]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
  }

  // -- command sync ------------------------------------------------------

  /**
   * Sync on every run. A rate limit does NOT take the bot offline (SDK-35):
   * command rows are durable, so we connect with whatever the server already has
   * and land the sync in the background.
   */
  async #syncCommands(
    http: HttpClient,
    bot: string,
    signal: AbortSignal,
  ): Promise<{ cancel: () => void } | null> {
    const payload = [...this.#registered.values()].map((r) => ({
      name: r.command.name,
      description: r.command.description,
    }));
    try {
      await syncCommandsAndReport(http, bot, payload, this.#log);
      return null;
    } catch (exc) {
      if (!(exc instanceof RateLimitError)) throw exc;
      this.#log.warn(
        `command sync is rate limited (${exc.code}); connecting with the server's ` +
          `current set and retrying in the background`,
      );
      const controller = new AbortController();
      void this.#retrySync(http, bot, payload, exc, controller.signal, signal);
      return { cancel: () => controller.abort() };
    }
  }

  async #retrySync(
    http: HttpClient,
    bot: string,
    payload: Array<{ name: string; description: string }>,
    first: RateLimitError,
    cancelled: AbortSignal,
    stopping: AbortSignal,
  ): Promise<void> {
    let delayMs = (first.retry_after ?? 60) * 1000;
    for (;;) {
      if (await sleepUntilAborted(delayMs, cancelled, stopping)) return;
      try {
        // The background lane reports conflicts too: a bot whose first sync was
        // rate limited must not be the one bot that never hears about them.
        await syncCommandsAndReport(http, bot, payload, this.#log);
      } catch (exc) {
        if (exc instanceof RateLimitError) {
          delayMs = (exc.retry_after ?? 60) * 1000;
          continue;
        }
        if (exc instanceof AurivalError) {
          this.#log.error(`command sync failed: ${exc.message}`);
          return;
        }
        throw exc;
      }
      process.stdout.write('aurival: command sync landed\n');
      return;
    }
  }

  // -- dispatch ----------------------------------------------------------

  async #dispatch(event: Event): Promise<void> {
    const work = this.#handle(event);
    this.#inflight.add(work);
    try {
      await work;
    } finally {
      this.#inflight.delete(work);
    }
  }

  /**
   * One event. Runs the handler, never lets it take the bot down (SDK-16).
   *
   * Note what is NOT in this frame: no key, no seed, no token.
   */
  async #handle(event: Event): Promise<void> {
    if (event.type !== 'command.invoked') return;
    const name = typeof event.data['command'] === 'string' ? event.data['command'] : '';
    const registered = this.#registered.get(lookupKey(name));
    if (registered === undefined) {
      // The server routes by its own declared set, so this is a stale sync or a
      // name we just removed. Not an error.
      this.#log.debug(`no handler for command ${JSON.stringify(name)}`);
      return;
    }
    if (this.#http === null) return;
    const ctx = Context.fromEvent(event, this.#http);
    try {
      await registered.handler(ctx);
    } catch (exc) {
      // One bad command must not take the bot offline (SDK-16).
      this.#log.error(
        `handler for ${JSON.stringify(name)} threw: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
      );
      await this.#callErrorHook(exc, ctx);
    }
  }

  async #callErrorHook(error: Reportable, ctx: Context | null): Promise<void> {
    if (this.#errorHook === null) return;
    try {
      await this.#errorHook(error, ctx);
    } catch (exc) {
      // An error hook that throws is not an outage either.
      this.#log.error(`error hook threw: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }
}

/** Resolves true if either signal fired first — a wait must never outlive a SIGINT. */
function sleepUntilAborted(ms: number, a: AbortSignal, b: AbortSignal): Promise<boolean> {
  if (a.aborted || b.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean): void => {
      clearTimeout(timer);
      a.removeEventListener('abort', onAbort);
      b.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => done(true);
    const timer = setTimeout(() => done(false), ms);
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  });
}
