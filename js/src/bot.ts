/** The developer-facing surface: declare commands, call run(), we hold the socket. */

import { Auth, KeyFile, machineLabel, pair, resolveHost } from './auth.js';
import type { Machine, MachineKey } from './auth.js';
import { AurivalError, BotSuspended, ButtonAlreadyUsed, NotFound, RateLimitError, SessionSuperseded } from './errors.js';
import { Context, Event, contextFor } from './events.js';
import { DEFAULT_HOST, HttpClient, defaultLogger } from './http.js';
import type {
  AnyContext,
  BotContext,
  BotEventType,
  ButtonContext,
  ButtonEventType,
  Command,
  EventContext,
  MemberContext,
  MemberEventType,
  ReactionContext,
  ReactionEventType,
} from './events.js';
import type { Logger } from './http.js';
import { CAP_TOO_MANY_ALIASES, MAX_ALIASES_PER_COMMAND, commandCooldownNotice } from './caps.js';
import {
  Cooldown,
  buttonBucketKey,
  normalizeCooldownOption,
  resolveButtonCooldown,
  retryAfterMs,
  roundSeconds,
  subjectKey,
} from './cooldown.js';
import type { CooldownLike, CooldownOption } from './cooldown.js';
import { EVENT_BACKLOG_OVERFLOWED, EVENT_COMMAND_INVOKED, Socket } from './socket.js';
import * as status from './status.js';

/** Types `on()` refuses, and why — each is a STRUCTURAL case where a
 * registered handler truly cannot ever run, which is exactly the silent
 * footgun `on()` throwing here saves a developer from. `reaction.removed`
 * used to be refused here too, but it is merely not-a-thing-today rather
 * than structurally undispatchable — refusing it was a forward-compatibility
 * trap (merge-gate senior review; python makes the identical change), so
 * `on('reaction.removed', ...)` now registers like any other unrecognized
 * type: it just never fires until/unless the wire ever adds that event. */
const NEVER_DISPATCHED_TO_ON: ReadonlyMap<string, string> = new Map([
  [EVENT_COMMAND_INVOKED, 'routed through bot.command(), not bot.on()'],
  [EVENT_BACKLOG_OVERFLOWED, 'operational only — never reaches a handler (SDK-28)'],
]);

/** A `bot.command()` handler. */
export type Handler = (ctx: Context) => Promise<void> | void;
/**
 * A per-command or bot-level cooldown hook (AMENDMENT-08 §4). `retryAfter`
 * is the raw, unrounded seconds `Cooldown.check()` returned — round it
 * yourself (`Math.max(1, Math.ceil(retryAfter))`, §5's rule) to reproduce
 * the built-in sentence's `{n}`. Replaces the built-in "Slow down…" notice
 * entirely: a hook that does nothing suppresses the notice, a hook that
 * replies sends whatever it wants instead. Gated by the same once-per-window
 * ledger as the built-in notice — a hook runs once per bucket per window,
 * not on every refused call.
 */
export type OnCooldownHook = (ctx: Context, retryAfter: number) => Promise<void> | void;
/** A `member.joined` / `member.left` handler. */
export type MemberHandler = (ctx: MemberContext) => Promise<void> | void;
/** A `bot.added` / `bot.removed` handler. */
export type BotHandler = (ctx: BotContext) => Promise<void> | void;
/** A `reaction.added` handler. */
export type ReactionHandler = (ctx: ReactionContext) => Promise<void> | void;
/** A `button.pressed` handler. */
export type ButtonHandler = (ctx: ButtonContext) => Promise<void> | void;
/** A handler for an event type this SDK does not name — every field optional. */
export type EventHandler = (ctx: EventContext) => Promise<void> | void;
type AnyHandler = (ctx: never) => Promise<void> | void;

/**
 * The hook also receives a `backlog.overflowed` Event, which is operational
 * rather than an error — it never reaches a handler (SDK-28).
 */
export type Reportable = unknown | Event;
export type ErrorHook = (error: Reportable, ctx: AnyContext | null) => Promise<void> | void;

/** How long a clean shutdown waits for handlers that are still running (SDK-32). */
export const SHUTDOWN_GRACE_MS = 10_000;

// ERRORS-V1 has nothing to do with this cap — it never reaches the server. A
// sync past this size is refused server-side too (SyncCommands, backend-go),
// but catching it here means a bot author sees this line instead of a 400
// deep inside a sync call, and before we have made any network call at all.
export const MAX_COMMANDS = 50;

export interface BotOptions {
  host?: string | undefined;
  keyPath?: string | undefined;
  logger?: Logger | undefined;
  /** Silences the `aurival: …` status banners on stderr. `AURIVAL_QUIET=1` does the same. */
  quiet?: boolean | undefined;
  /**
   * Auto-typing (SDK-41). A command handler still running after
   * {@link AUTO_TYPING_DELAY_MS} shows the chat "is thinking", and the
   * indicator is cleared when the handler returns. A handler that replies
   * inside the delay sends nothing, so a fast bot never flickers. `false`
   * keeps typing entirely in your hands (`ctx.withTyping()`). Default `true`.
   */
  autoTyping?: boolean | undefined;
  /**
   * The default cooldown a button press checks when neither its card nor
   * the button itself carries one (AMENDMENT-08 §3). Defaults to `new
   * Cooldown(1, 2.0, 'user')` — one press per user per two seconds — when
   * omitted; pass `null` to disable it bot-wide, leaving only card/button
   * cooldowns (if any) in effect. Bound by the same 60s cap as every other
   * button-family cooldown, checked at construction. **Its bucket lives in
   * process memory: it resets on every restart, and it is never shared
   * across instances or processes** — a bot running two workers has two
   * independent buckets (see {@link Cooldown}'s own doc comment for why).
   */
  buttonCooldown?: CooldownOption | undefined;
}

/**
 * A command's third form: `bot.command(name, { cooldown, onCooldown,
 * description }, handler)`. `description` here is equivalent to the
 * two-argument string overload's — the options object is a third spelling
 * of the same call, not a different feature (R-9's two string overloads are
 * unchanged; this is additive). `cooldown` accepts a `Cooldown` instance or
 * a plain `{ rate, per, bucket? }` literal, normalized at registration.
 * Command cooldowns have no 60s cap (D13) — they never reach the wire.
 */
export interface CommandOptions {
  description?: string | undefined;
  cooldown?: CooldownLike | undefined;
  onCooldown?: OnCooldownHook | undefined;
  /**
   * AMENDMENT-09 §2.1: alternate spellings that fire this same handler —
   * `/r` and `/dice` for a command registered as `roll`, say. At most
   * {@link MAX_ALIASES_PER_COMMAND}, checked locally at registration; every
   * other rule an alias obeys (the name pattern, the reserved list,
   * uniqueness) is the server's alone (§2.1) — this SDK reuses
   * `invalid_command_name` for those exactly as the server does, by simply
   * not re-validating them here and letting the sync refusal surface.
   * Dispatch, the cooldown bucket and `onCooldown` all stay keyed on the
   * canonical name; an alias only ever changes which typed token reaches
   * that same handler (`ctx.invokedAs`, `Context`).
   */
  aliases?: readonly string[] | undefined;
}

/**
 * How long a command handler runs before the chat is told the bot is thinking
 * (SDK-41). Long enough that an ordinary reply never trips it, short enough
 * that a slow one reads as work in progress rather than silence.
 */
export const AUTO_TYPING_DELAY_MS = 300;

/** The per-dispatch auto-typing timer; `stop()` is always awaited by the dispatcher. */
interface AutoTyping {
  stop(): Promise<void>;
}

const noAutoTyping: AutoTyping = { stop: async () => undefined };

interface Registered {
  command: Command;
  handler: Handler;
  /** Unbounded per §5/D13 — never attachment-time-capped like a button cooldown. */
  cooldown?: Cooldown;
  onCooldown?: OnCooldownHook;
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
 * One `PUT /v1/bots/{bot}/commands` row. `aliases` is optional and, when
 * present, always non-empty — the caller omits the key entirely for a
 * command with no aliases (AMENDMENT-09 §2.1: absent and `[]` mean the same
 * thing, so there is no reason to send the empty spelling).
 */
export interface SyncPayloadEntry {
  name: string;
  description: string;
  aliases?: string[];
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
  payload: SyncPayloadEntry[],
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
  /**
   * `bot.on(type, fn)` — a generic string-keyed registry beside the command
   * registry (R1). `command.invoked` never lands here; it stays on
   * `#registered` and its dispatch is unchanged. Many handlers per type,
   * kept in registration order (matches python's `on()` — a divergence
   * caught in review; js used to be one-handler-per-type and silently
   * replace, python already ran all of them).
   */
  readonly #onHandlers = new Map<string, AnyHandler[]>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #log: Logger;
  readonly #host: string | undefined;
  readonly #keyPath: string | undefined;
  #errorHook: ErrorHook | null = null;
  #http: HttpClient | null = null;
  readonly #quiet: boolean;
  readonly #autoTyping: boolean;
  readonly #buttonCooldown: Cooldown | null;
  #cooldownHook: OnCooldownHook | null = null;

  constructor(options: BotOptions = {}) {
    this.#log = options.logger ?? defaultLogger();
    this.#host = options.host;
    this.#keyPath = options.keyPath;
    this.#quiet = status.isQuiet(options.quiet);
    this.#autoTyping = options.autoTyping ?? true;
    const resolvedButtonCooldown = normalizeCooldownOption(options.buttonCooldown, {
      boundToButton: true,
    });
    this.#buttonCooldown =
      resolvedButtonCooldown === undefined ? new Cooldown(1, 2.0, 'user') : resolvedButtonCooldown;
  }

  // -- registration ------------------------------------------------------

  /**
   * Declare a command. The name is sent as written — the server is the
   * validator (SDK-29), and it lowercases and trims before it checks.
   */
  command(name: string, handler: Handler): void;
  command(name: string, description: string, handler: Handler): void;
  /**
   * The options form (AMENDMENT-08 §4/seat ruling): a per-command cooldown
   * is an option here, not a decorator. `{ cooldown, onCooldown }` beats
   * `bot.onCooldown()` for this command alone — only one hook ever runs for
   * a given refusal.
   */
  command(name: string, options: CommandOptions, handler: Handler): void;
  command(
    name: string,
    second: string | Handler | CommandOptions,
    third?: Handler,
  ): void {
    let description = '';
    let handler: Handler | undefined;
    let cooldownLike: CooldownLike | undefined;
    let onCooldownHook: OnCooldownHook | undefined;
    let aliasesLike: readonly string[] | undefined;
    if (typeof second === 'string') {
      description = second;
      handler = third;
    } else if (typeof second === 'function') {
      handler = second;
    } else {
      description = second.description ?? '';
      cooldownLike = second.cooldown;
      onCooldownHook = second.onCooldown;
      aliasesLike = second.aliases;
      handler = third;
    }
    if (handler === undefined) throw new AurivalError(`command(${name}) needs a handler`);
    // AMENDMENT-09 §2.1: `[]` in every state but never `undefined` — a
    // `Command` this SDK constructs always carries the list, even empty.
    const aliases = aliasesLike !== undefined ? [...aliasesLike] : [];
    if (aliases.length > MAX_ALIASES_PER_COMMAND) {
      throw new AurivalError(CAP_TOO_MANY_ALIASES);
    }
    const key = lookupKey(name);
    if (this.#registered.has(key)) status.duplicateCommand(name, this.#quiet);
    const registered: Registered = { command: { name, description, aliases }, handler };
    if (cooldownLike !== undefined) registered.cooldown = Cooldown.from(cooldownLike);
    if (onCooldownHook !== undefined) registered.onCooldown = onCooldownHook;
    this.#registered.set(key, registered);
  }

  /**
   * Register a handler for an event. Which context the handler gets follows
   * from the type, and your editor knows it (BA-R68):
   *
   *   - `member.joined` / `member.left` → `MemberContext` (`ctx.user`)
   *   - `bot.added` / `bot.removed` → `BotContext` (`ctx.actor`)
   *   - `reaction.added` → `ReactionContext` (`ctx.sender`, `ctx.message`, `ctx.emoji`)
   *   - any other string → `EventContext` (everything optional)
   *
   * `command.invoked` goes through `command()`. Many handlers may share one
   * type; each runs in the order it was registered (matches python), and
   * the event is acked once, after every handler for it has settled.
   *
   * Throws immediately, before any registration, for the two types that are
   * STRUCTURALLY undispatchable through `on()`: `command.invoked` (never
   * dispatched here — use `command()`) and `backlog.overflowed` (never
   * dispatched to any handler, by contract). A handler that truly can never
   * run is exactly the silent footgun this check exists to catch at
   * registration time. `reaction.removed` is NOT refused: it does not exist
   * on the wire today (AMENDMENT-04 A-2.1, un-reacting is silent), but that
   * is a today-fact, not a structural one, and refusing a type merely
   * because the wire hasn't sent it yet would be a forward-compatibility
   * trap — the handler just never fires until/unless that changes.
   */
  on(type: MemberEventType, handler: MemberHandler): void;
  on(type: BotEventType, handler: BotHandler): void;
  on(type: ReactionEventType, handler: ReactionHandler): void;
  on(type: ButtonEventType, handler: ButtonHandler): void;
  // `string & {}` keeps the literals above in autocomplete while still
  // accepting a type this SDK has not named yet.
  on(type: string & {}, handler: EventHandler): void;
  on(type: string, handler: AnyHandler): void {
    const reason = NEVER_DISPATCHED_TO_ON.get(type);
    if (reason !== undefined) {
      throw new AurivalError(`bot.on(${JSON.stringify(type)}, ...) can never run: ${reason}`);
    }
    const handlers = this.#onHandlers.get(type);
    if (handlers === undefined) this.#onHandlers.set(type, [handler]);
    else handlers.push(handler);
  }

  /**
   * Called with (error, context | null) for anything the SDK caught for you: a
   * handler that threw, a `problem` frame, a backlog overflow.
   */
  onError(fn: ErrorHook): void {
    this.#errorHook = fn;
  }

  /**
   * The bot-level cooldown hook (AMENDMENT-08 §4) — runs for any refused
   * command that does not carry its own `onCooldown` option. A per-command
   * hook always wins; only one hook ever runs for a given refusal.
   */
  onCooldown(fn: OnCooldownHook): void {
    this.#cooldownHook = fn;
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
    } catch (err) {
      // The default usage in the README is fire-and-forget `bot.run();` —
      // for these two, the friendly `status.stopped` line already explained
      // what happened, so rethrowing here would turn it into an unhandled
      // rejection traceback on the default path (and `process.exit()` would
      // cut off pending I/O for a caller who DID await this). Every other
      // fatal bye still rethrows exactly as before.
      if (err instanceof SessionSuperseded || err instanceof BotSuspended) {
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#registered.size > MAX_COMMANDS) {
      throw new AurivalError(
        `${this.#registered.size} commands registered, but the cap is ${MAX_COMMANDS} per bot`,
      );
    }
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

    if (this.#registered.size === 0) status.noCommands(this.#quiet);
    status.connecting(machine.bot, this.#quiet);
    const socket = new Socket(http, auth, {
      dispatch: (event) => this.#dispatch(event),
      onProblem: (problem) => {
        void this.#callErrorHook(problem, null);
      },
      // `button.pressed` always claims a handler exists, whether or not a
      // developer ever called `on('button.pressed', ...)` — a press must
      // reach `#handleButtonPress` so the cooldown check (and its ack on
      // refusal) always runs, even for a bot that only sends cards and
      // handles presses nowhere, or not yet (AMENDMENT-08 §1/§5: the button
      // default applies to every bot with no line of code, and the presser
      // must never be left staring at pending ink). A press that passes
      // with no registered handler simply falls through `#handleGeneric`
      // with nothing to call; the socket-level ack still fires either way.
      hasHandler: (type) => type === 'button.pressed' || this.#onHandlers.has(type),
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
    const payload: SyncPayloadEntry[] = [...this.#registered.values()].map((r) => {
      const entry: SyncPayloadEntry = { name: r.command.name, description: r.command.description };
      // AMENDMENT-09 §2.1: the key is present only when the list is
      // non-empty — absent and `[]` mean the same thing on this wire, so
      // there is nothing to gain from sending the empty spelling.
      if (r.command.aliases !== undefined && r.command.aliases.length > 0) {
        entry.aliases = [...r.command.aliases];
      }
      return entry;
    });
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
    payload: SyncPayloadEntry[],
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
    if (event.type === 'command.invoked') {
      await this.#handleCommand(event);
      return;
    }
    if (event.type === 'button.pressed') {
      await this.#handleButtonPress(event);
      return;
    }
    await this.#handleGeneric(event);
  }

  async #handleCommand(event: Event): Promise<void> {
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
    // AMENDMENT-08: the cooldown check runs before auto-typing and before the
    // handler — a refused invocation never reaches either.
    if (registered.cooldown !== undefined) {
      const refused = await this.#handleCommandCooldown(ctx, registered);
      if (refused) return;
    }
    const typing = this.#startAutoTyping(ctx);
    try {
      await registered.handler(ctx);
    } catch (exc) {
      // One bad command must not take the bot offline (SDK-16).
      this.#log.error(
        `handler for ${JSON.stringify(name)} threw: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
      );
      await this.#callErrorHook(exc, ctx);
    } finally {
      await typing.stop();
    }
  }

  /**
   * A registered command's own cooldown (AMENDMENT-08 §4). Returns `true`
   * when the invocation was refused (dispatch stops here). Its bucket key
   * carries no message/button scope (`attachmentScope = ()`) — each
   * command's `Cooldown` is its own instance, so nothing else could collide
   * with it anyway.
   *
   * Once per bucket per window: either the per-command hook, the bot-level
   * one, or — with neither registered — the fixed reply. A hook does not
   * run on every refused call; it shares the same `noticeOnce` gate the
   * built-in notice uses, so mashing a refused command inside one window
   * produces one hook call (or one reply), not a flood of them.
   */
  async #handleCommandCooldown(ctx: Context, registered: Registered): Promise<boolean> {
    const cooldown = registered.cooldown;
    if (cooldown === undefined) return false;
    const key = subjectKey(cooldown.bucket, ctx.sender.id, ctx.chat.id);
    const refusedAfterSeconds = cooldown.check(key);
    if (refusedAfterSeconds === null) return false;
    if (!cooldown.noticeOnce(key)) return true;
    // Per-command beats bot-level; only one hook ever runs.
    const hook = registered.onCooldown ?? this.#cooldownHook;
    if (hook !== null && hook !== undefined) {
      try {
        await hook(ctx, refusedAfterSeconds);
      } catch (exc) {
        this.#log.error(
          `cooldown hook for ${JSON.stringify(ctx.command)} threw: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
        );
        await this.#callErrorHook(exc, ctx);
      }
      return true;
    }
    const n = roundSeconds(refusedAfterSeconds);
    try {
      // AMENDMENT-09 §13.1: names the token the human actually typed, not
      // the canonical spelling — the bucket is still the canonical
      // command's (one bucket, all spellings); only the rendered sentence
      // changes.
      await ctx.reply(commandCooldownNotice(ctx.invokedAs, n));
    } catch (exc) {
      this.#log.error(
        `cooldown notice for ${JSON.stringify(ctx.command)} failed: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
      );
      await this.#callErrorHook(exc, ctx);
    }
    return true;
  }

  /**
   * AMENDMENT-08 §3: resolve the pressed button's cooldown (button > card >
   * bot default), check it, and — on refusal — send the cooldown ack
   * instead of dispatching to any `on('button.pressed', ...)` handler. The
   * socket still acks the underlying event exactly as it does for any other
   * dispatch; only the handler is skipped.
   */
  async #handleButtonPress(event: Event): Promise<void> {
    if (this.#http === null) return;
    const ctx = contextFor(event, this.#http) as ButtonContext;
    const card = this.#http.cardCooldowns.lookup(ctx.message.id);
    const resolved = resolveButtonCooldown(this.#buttonCooldown, card, ctx.button);
    if (resolved.cooldown !== null) {
      const scope = resolved.scoped ? { messageId: ctx.message.id, buttonId: ctx.button } : null;
      const key = buttonBucketKey(resolved.cooldown, scope, ctx.user.id, ctx.chat.id);
      const refusedAfterSeconds = resolved.cooldown.check(key);
      if (refusedAfterSeconds !== null) {
        await this.#ackButtonCooldown(ctx, retryAfterMs(refusedAfterSeconds));
        return;
      }
    }
    await this.#handleGeneric(event);
  }

  /**
   * The SDK's own automatic answer to a refused press (§5.1). Swallows
   * `ButtonAlreadyUsed`/`NotFound` silently — a debug line, never `onError`,
   * never thrown — because the press already resolved some other way (a
   * double-tap, an expired row) and the cooldown refusal is moot. Every
   * other status still goes through the normal error path.
   */
  async #ackButtonCooldown(ctx: ButtonContext, ms: number): Promise<void> {
    if (this.#http === null) return;
    try {
      await this.#http.ackCooldown(ctx.interaction, ms);
      // The ack landed. Without this line a button cooldown is invisible to
      // the bot author: the SDK answers the press itself, the handler never
      // runs, and nothing is written anywhere — so a cooldown firing and a
      // press vanishing look identical from the outside. `info`, not
      // `debug`, because the swallowed-refusal lines below are the ones a
      // reader can ignore; this one is the cooldown working. Byte-mirrors
      // `sdk/python/aurival/bot.py`'s sentence (SDK-7).
      this.#log.info(
        `cooldown: acked press on ${ctx.message.id}/${ctx.button} for ${ctx.user.id}, retry_after_ms=${ms}`,
      );
    } catch (exc) {
      if (exc instanceof ButtonAlreadyUsed || exc instanceof NotFound) {
        this.#log.debug(
          `cooldown ack for ${JSON.stringify(ctx.interaction)} found the press already resolved: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
        return;
      }
      this.#log.error(
        `cooldown ack for ${JSON.stringify(ctx.interaction)} failed: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
      );
      await this.#callErrorHook(exc, ctx);
    }
  }

  // -- auto-typing (SDK-41) ------------------------------------------------

  #startAutoTyping(ctx: Context): AutoTyping {
    if (!this.#autoTyping || ctx.chat.id === '') return noAutoTyping;
    // Once the timer fires the start request is in flight and may already be
    // applied server-side, so stop() awaits it and clears, rather than
    // abandoning a request it cannot take back. Typing is best-effort: a
    // failure is a debug line, never the reply's problem.
    let sent: Promise<boolean> | null = null;
    const timer = setTimeout(() => {
      sent = ctx.typing(true).then(
        () => true,
        (exc: unknown) => {
          this.#log.debug(
            `auto typing start failed: ${exc instanceof Error ? exc.message : String(exc)}`,
          );
          return false;
        },
      );
    }, AUTO_TYPING_DELAY_MS);
    return {
      stop: async () => {
        clearTimeout(timer);
        if (sent === null) return;
        if (!(await sent)) return;
        await ctx.typing(false).catch((exc: unknown) => {
          this.#log.debug(
            `auto typing stop failed: ${exc instanceof Error ? exc.message : String(exc)}`,
          );
        });
      },
    };
  }

  /**
   * `member.joined`/`left`, `bot.added`/`removed`, `reaction.added`, or any
   * other type this bot registered via `on()`. `Socket` only dispatches
   * here for a type `#hasHandler` said yes to, but this stays defensive.
   *
   * Every handler registered for this type runs, in registration order
   * (R1/python parity) — one throwing does not skip the rest. `Socket` acks
   * the event exactly once, after this whole method returns, regardless of
   * how many handlers ran or how many of them threw: a crash never
   * redelivers a deterministic failure into a loop (SDK-16 extended to the
   * multi-handler case).
   */
  async #handleGeneric(event: Event): Promise<void> {
    const handlers = this.#onHandlers.get(event.type);
    if (handlers === undefined || handlers.length === 0) {
      this.#log.debug(`no handler for event type ${JSON.stringify(event.type)}`);
      return;
    }
    if (this.#http === null) return;
    const ctx = contextFor(event, this.#http);
    for (const handler of handlers) {
      try {
        await handler(ctx as never);
      } catch (exc) {
        // One bad handler must not take the bot offline (SDK-16), same as a
        // command, and must not stop the other handlers for this event.
        this.#log.error(
          `handler for ${JSON.stringify(event.type)} threw: ${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}`,
        );
        await this.#callErrorHook(exc, ctx);
      }
    }
  }

  async #callErrorHook(error: Reportable, ctx: AnyContext | null): Promise<void> {
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
