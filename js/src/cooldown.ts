/**
 * `Cooldown` — the SDK-side rate-limit primitive (AMENDMENT-08 §2).
 *
 * SDK-side state only: the wire never carries a cooldown configuration, and
 * the server never learns one exists (the one exception is the *button*
 * cooldown ACK, whose `retry_after_ms` is computed FROM this primitive by
 * `bot.ts` — `http.ts::ackCooldown` — never the other way around).
 *
 * **Buckets are process memory. They reset on restart, and they are never
 * shared across instances or processes.** A bot running two workers behind
 * a supervisor has two independent buckets, and a deploy clears every
 * bucket it had. This is stated here, not buried, because a developer who
 * assumes otherwise builds a quota on it — the server floor
 * (`press.go`'s `ButtonPressRateLimit`) is what actually bounds abuse.
 *
 * This module is a leaf: it imports nothing from `embeds.ts`, `events.ts`,
 * `http.ts` or `bot.ts`, so `Cooldown` itself never depends on the wire
 * shapes that use it.
 *
 * Mirrors `sdk/python/aurival/cooldown.py` — the bucket algorithm, the key
 * scheme, and the four cap sentences below are byte/logic-identical between
 * the two SDKs (AMENDMENT-08's shared algorithm block). The command notice
 * template and the two ack-refusal sentences that DO have a server twin live
 * in `caps.ts`, not here — this file's header pins it to sentences with no
 * server twin, exactly as `caps.ts`'s header pins it to sentences that do.
 */

/** Who a bucket is scoped to. `user` (default) is one bucket per presser/invoker; `chat` is one per conversation; `global` is one bucket for the whole attachment. */
export type CooldownBucket = 'user' | 'chat' | 'global';

/** A plain `{ rate, per, bucket? }` literal — accepted everywhere a `Cooldown` is, and normalized into one at attachment (R-2, R-7). */
export interface CooldownLiteral {
  rate: number;
  /** seconds */
  per: number;
  bucket?: CooldownBucket | undefined;
}

/** A `Cooldown` instance, or a literal that normalizes into one. */
export type CooldownLike = Cooldown | CooldownLiteral;

/**
 * The tri-state a cooldown option carries at every one of the three
 * attachment points (`Bot(buttonCooldown)`, card-level `send(...,
 * buttonCooldown)`, `Button(cooldown)`), and at a command's own `cooldown`
 * option: `undefined` — inherit from the level above (or "none", for a
 * command); `null` — explicitly disabled; a `CooldownLike` — use it.
 */
export type CooldownOption = CooldownLike | null;

export const CAP_BUTTON_COOLDOWN_TOO_LONG = 'a button cooldown is at most 60 seconds';
export const CAP_COOLDOWN_RATE_TOO_LOW = 'a cooldown rate is at least 1';
export const CAP_COOLDOWN_PERIOD_NOT_POSITIVE = 'a cooldown period is greater than zero';
export const CAP_LINK_BUTTON_COOLDOWN = 'a link button cannot carry a cooldown';

/** §5.1: a button cooldown's `per` is bounded so the ack's `retry_after_ms` never exceeds the wire's 60000ms cap. Command cooldowns are unbounded (D13) — they never reach the wire. */
export const MAX_BUTTON_COOLDOWN_PER_SECONDS = 60;

interface BucketState {
  windowStart: number;
  tokens: number;
}

/** Seconds, monotonic. `performance.now()` never goes backwards and needs no epoch. */
function defaultClock(): number {
  return performance.now() / 1000;
}

/** One key's scope + subject, joined with a separator no id in this SDK can contain (`msg_…`/`btn ids`/`usr_…`/`chat_…` are all `[a-zA-Z0-9_-]`). */
const KEY_SEP = ' ';

/**
 * SDK-side rate limit primitive (AMENDMENT-08 §2). One `Cooldown` instance
 * owns its own bucket map; instances are never shared between attachments —
 * a command's `Cooldown` is private to that command, a per-button
 * `Cooldown` private to that button, and so on.
 *
 * Fixed window anchored at first use, per bucket key. Buckets and the
 * once-per-window notice ledger both live for the process lifetime — the
 * shared algorithm block names no eviction, so none is added here; a bot
 * that runs for a very long time against a huge number of distinct keys
 * accumulates entries for as long as it runs (unlike the bounded card
 * lookup table in `bot.ts`, which is namespaced to message ids and capped).
 */
export class Cooldown {
  readonly rate: number;
  /** seconds */
  readonly per: number;
  readonly bucket: CooldownBucket;
  readonly #now: () => number;
  readonly #buckets = new Map<string, BucketState>();
  readonly #notified = new Map<string, number>();

  /**
   * `now` is an injectable monotonic clock (seconds), for tests only — it is
   * deliberately not part of the documented public signature (`new
   * Cooldown(rate, per, bucket)`, matching §2's examples byte for byte).
   */
  constructor(
    rate: number,
    per: number,
    bucket: CooldownBucket = 'user',
    now: () => number = defaultClock,
  ) {
    if (rate < 1) throw new Error(CAP_COOLDOWN_RATE_TOO_LOW);
    if (!(per > 0)) throw new Error(CAP_COOLDOWN_PERIOD_NOT_POSITIVE);
    this.rate = rate;
    this.per = per;
    this.bucket = bucket;
    this.#now = now;
  }

  /** An existing `Cooldown` passes through unchanged; a plain literal is validated and wrapped. */
  static from(value: CooldownLike, now?: () => number): Cooldown {
    if (value instanceof Cooldown) return value;
    return now === undefined
      ? new Cooldown(value.rate, value.per, value.bucket ?? 'user')
      : new Cooldown(value.rate, value.per, value.bucket ?? 'user', now);
  }

  /**
   * One synchronous check-and-consume. `null` on a pass (a token was
   * spent); the seconds remaining on a refusal. **A refusal never consumes
   * and never touches the window** — mashing a refused key does not push
   * the window further out.
   */
  check(key: string): number | null {
    const now = this.#now();
    let state = this.#buckets.get(key);
    if (state === undefined || now - state.windowStart >= this.per) {
      state = { windowStart: now, tokens: this.rate };
      this.#buckets.set(key, state);
    }
    if (state.tokens === 0) {
      return this.per - (now - state.windowStart);
    }
    state.tokens -= 1;
    return null;
  }

  /**
   * The once-per-window gate for the command notice (§4): `true` only the
   * first time it is called for this key's CURRENT window, `false` for
   * every call after that until the window rolls over. Call this only
   * right after a `check()` refusal on the same key — it reads the window
   * `check()` just refused against (a refusal leaves `windowStart`
   * untouched, so this is safe).
   */
  noticeOnce(key: string): boolean {
    const windowStart = this.#buckets.get(key)?.windowStart ?? this.#now();
    if (this.#notified.get(key) === windowStart) return false;
    this.#notified.set(key, windowStart);
    return true;
  }
}

/** §5's rounding rule, shared by the command sentence's `{n}` and the button ack's `retry_after_ms`: a fractional remainder always rounds UP, and never to zero — a toast or reply that says "0 s" tells the presser to retry immediately, and they would be refused again. */
export function roundSeconds(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds));
}

/** `retryAfterSeconds` -> the wire's `retry_after_ms`, whole milliseconds, never zero. */
export function retryAfterMs(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds * 1000));
}

/** Refused at ATTACHMENT time (§5): a button cooldown's `per` may not exceed the wire's `retry_after_ms` cap. Command cooldowns never call this — they are unbounded (D13). */
export function requireButtonCooldownBounds(cooldown: Cooldown): void {
  if (cooldown.per > MAX_BUTTON_COOLDOWN_PER_SECONDS) throw new Error(CAP_BUTTON_COOLDOWN_TOO_LONG);
}

/**
 * Normalizes a tri-state `CooldownOption` at one attachment point:
 * `undefined` stays `undefined` (inherit), `null` stays `null` (disabled), a
 * `CooldownLike` is validated and turned into a `Cooldown`. `boundToButton`
 * runs the 60s cap — pass it for every button-family attachment
 * (`Bot(buttonCooldown)`, card-level, per-button) and leave it off for a
 * command's `cooldown`, which §5 leaves unbounded.
 */
export function normalizeCooldownOption(
  value: CooldownOption | undefined,
  options: { boundToButton: boolean },
): Cooldown | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const cooldown = Cooldown.from(value);
  if (options.boundToButton) requireButtonCooldownBounds(cooldown);
  return cooldown;
}

/** `bucket` + the invoking/pressing user id and the chat id -> the subject half of a key (§2's three-bucket table). */
export function subjectKey(bucket: CooldownBucket, userId: string, chatId: string): string {
  if (bucket === 'user') return `user${KEY_SEP}${userId}`;
  if (bucket === 'chat') return `chat${KEY_SEP}${chatId}`;
  return 'global';
}

/**
 * A button press's full bucket key (§3): the bot-level default has
 * `attachmentScope = ()` — one bucket per user (or chat/global) per bot,
 * regardless of which message or button was pressed — while a card-level or
 * per-button `Cooldown` scopes to `(messageId, buttonId)` too, because
 * button ids are unique only WITHIN a message
 * (`duplicate_button_id`, ERRORS-V1 §3): two cards reusing the same button
 * id must not share a bucket.
 */
export function buttonBucketKey(
  cooldown: Cooldown,
  scope: { messageId: string; buttonId: string } | null,
  userId: string,
  chatId: string,
): string {
  const subject = subjectKey(cooldown.bucket, userId, chatId);
  return scope === null
    ? subject
    : `${scope.messageId}${KEY_SEP}${scope.buttonId}${KEY_SEP}${subject}`;
}

/** One outgoing card's recorded cooldown configuration (§3's "card lookup on press"). `undefined` in either slot means "inherits from the level above" — the bot default for `cardCooldown`, the card's own resolved cooldown for an entry missing from `byButtonId`. */
export interface CardCooldownRecord {
  cardCooldown: Cooldown | null | undefined;
  byButtonId: ReadonlyMap<string, Cooldown | null>;
}

/** §3: "bound the table (LRU cap ~1024 messages) so a long-lived bot does not grow without limit." */
const CARD_TABLE_CAP = 1024;

/**
 * Records, per outgoing message id, the card-level cooldown and any
 * per-button overrides a `send()`/`reply()`/`ack()`/`edit()` call attached —
 * because a `button.pressed` event carries only ids, never the `Button`
 * objects that were sent, so precedence has to be resolved from somewhere
 * that remembers them. Bounded LRU-ish (insertion order; `record` moves an
 * existing key to the back) so a bot running for a long time does not grow
 * this table without limit.
 */
export class CardCooldownTable {
  readonly #entries = new Map<string, CardCooldownRecord>();

  /**
   * `undefined` `cardCooldown` and an empty `byButtonId` together mean
   * "nothing overrides anything on this card" — recording that is a no-op
   * (equivalent to no entry at all, since a lookup miss already falls
   * through to the bot default), and an existing entry for this id is
   * cleared rather than left stale (a card edited to drop its per-button
   * overrides must not keep the old ones).
   */
  record(messageId: string, entry: CardCooldownRecord): void {
    if (messageId === '') return;
    this.#entries.delete(messageId);
    if (entry.cardCooldown === undefined && entry.byButtonId.size === 0) return;
    this.#entries.set(messageId, entry);
    while (this.#entries.size > CARD_TABLE_CAP) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** `undefined` when the message is absent from the table — restarted process, or sent by another one (§3: "fall through to the bot default"). */
  lookup(messageId: string): CardCooldownRecord | undefined {
    return this.#entries.get(messageId);
  }
}

/** What a press resolved to, and whether it is scoped to `(messageId, buttonId)` when building the bucket key. */
export interface ResolvedButtonCooldown {
  cooldown: Cooldown | null;
  /** `false` only when the bot-level default is what resolved — `attachmentScope = ()` (§3). */
  scoped: boolean;
}

/** Precedence: button > card > bot default (§3), read off the recorded card entry (or its absence). */
export function resolveButtonCooldown(
  botDefault: Cooldown | null,
  card: CardCooldownRecord | undefined,
  buttonId: string,
): ResolvedButtonCooldown {
  const buttonOverride = card?.byButtonId.get(buttonId);
  if (buttonOverride !== undefined) return { cooldown: buttonOverride, scoped: true };
  if (card?.cardCooldown !== undefined) return { cooldown: card.cardCooldown, scoped: true };
  return { cooldown: botDefault, scoped: false };
}
