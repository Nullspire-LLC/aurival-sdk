/**
 * Plain data a handler receives (CONTRACT-V1 §3, §3.1).
 *
 * `Event` is the raw wire frame; a context is what `bot.ts` hands to a
 * handler, built from one. There is one context class per event family
 * (BA-R68): `Context` for commands, `MemberContext`, `BotContext`,
 * `ReactionContext`, and `EventContext` for a type this SDK does not name.
 * Each carries only the fields its family delivers, so an editor can tell a
 * developer what `ctx` holds without them opening the docs. Every context
 * holds an `HttpClient` for its actions and nothing else network-shaped —
 * never the seed, a token, or the `Auth` object (SDK-33).
 */

import { randomUUID } from 'node:crypto';
import { EMPTY_MESSAGE as NOTHING_TO_SAY, NOTHING_TO_EDIT } from './caps.js';
import { AurivalError } from './errors.js';
import {
  buttonUsedFromWire,
  buttonsFromWire,
  embedsFromWire,
  serialiseButtonsWithCooldowns,
  serialiseEmbeds,
} from './embeds.js';
import type { Button, ButtonLike, ButtonUsed, Embed, EmbedLike } from './embeds.js';
import type { CardParts, HttpClient } from './http.js';
import { normalizeCooldownOption } from './cooldown.js';
import type { Cooldown, CooldownOption } from './cooldown.js';

export interface User {
  id: string;
  handle: string;
  name: string;
}

export interface Chat {
  id: string;
  type: string;
  name: string | null;
  /**
   * Live participants, bots included. `null` when the wire frame omits
   * `member_count` — never defaulted to 0 (a real empty chat is still a
   * number, `null` means "the frame didn't say"). Kept snake_case, matching
   * this file's existing wire field convention (`sent_at`, `reply_to`), and
   * `null` (not `undefined`) to match how every other absent field in this
   * file is represented.
   */
  member_count: number | null;
}

export interface Command {
  name: string;
  description: string;
}

/**
 * A message. Events carry one under `invoking_message` (with `sent_at` and a
 * full `sender`); the REST side returns the stored entity (with `created_at`
 * and `sender` as a bare `usr_…` id) — `reply()`, `send()` and `edit()` all
 * decode that into this same shape, so `sent.id` is what you hand back to
 * `edit()`, `delete()` and `react()`. A `sender` known only by id has empty
 * `handle` and `name`.
 */
export interface Message {
  id: string;
  text: string;
  sent_at: string;
  sender: User | null;
  reply_to: string | null;
  /** `[]` when the wire omits the key or sends `null` (AMENDMENT-05 §3) — never `null`/`undefined`. */
  embeds: Embed[];
  /** `[]` when the wire omits the key or sends `null` — never `null`/`undefined`. */
  buttons: Button[];
  /** `null` when the wire omits the key, sends `null`, or the message never carried a button. */
  button_used: ButtonUsed | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export interface EventInit {
  id: string;
  type: string;
  created_at: string;
  sequence: number;
  data: Record<string, unknown>;
}

export class Event {
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
  readonly sequence: number;
  readonly data: Record<string, unknown>;

  constructor(init: EventInit) {
    this.id = init.id;
    this.type = init.type;
    this.created_at = init.created_at;
    this.sequence = init.sequence;
    this.data = init.data;
  }

  /**
   * `frame` is one WireEvent (`{object, id, type, created_at, sequence, data}`)
   * — the `event` frame's payload, top-level, not re-wrapped.
   */
  static fromFrame(frame: Record<string, unknown>): Event {
    const sequence = Number(frame['sequence']);
    return new Event({
      id: asString(frame['id']),
      type: asString(frame['type']),
      created_at: asString(frame['created_at']),
      sequence: Number.isFinite(sequence) ? Math.trunc(sequence) : 0,
      data: asRecord(frame['data']) ?? {},
    });
  }
}

function userFromWire(d: Record<string, unknown>): User {
  return { id: asString(d['id']), handle: asString(d['handle']), name: asString(d['name']) };
}

function chatFromWire(d: Record<string, unknown>): Chat {
  const name = d['name'];
  const memberCount = d['member_count'];
  return {
    id: asString(d['id']),
    type: asString(d['type']),
    name: typeof name === 'string' ? name : null,
    member_count:
      typeof memberCount === 'number' && Number.isFinite(memberCount) ? memberCount : null,
  };
}

function messageFromWire(d: Record<string, unknown>): Message {
  const replyTo = d['reply_to'];
  const rawSender = d['sender'];
  const senderRecord = asRecord(rawSender);
  let sender: User | null;
  if (senderRecord) sender = userFromWire(senderRecord);
  else if (typeof rawSender === 'string' && rawSender !== '')
    sender = { id: rawSender, handle: '', name: '' };
  else sender = null;
  return {
    id: asString(d['id']),
    text: asString(d['text']),
    sent_at: asString(d['sent_at'], asString(d['created_at'])),
    sender,
    reply_to: typeof replyTo === 'string' ? replyTo : null,
    embeds: embedsFromWire(d['embeds']),
    buttons: buttonsFromWire(d['buttons']),
    button_used: buttonUsedFromWire(d['button_used']),
  };
}

/** An id-only `Message` — what an event that names a message by `msg_…` alone becomes. */
function messageFromRef(id: string): Message {
  return {
    id,
    text: '',
    sent_at: '',
    sender: null,
    reply_to: null,
    embeds: [],
    buttons: [],
    button_used: null,
  };
}

const EMPTY_MESSAGE: Message = messageFromRef('');
const EMPTY_USER: User = { id: '', handle: '', name: '' };

/** `data[key]` as a `User`, or an empty one when the frame omits it — never `null` for a field the contract pins as present. */
function userField(data: Record<string, unknown>, key: string): User {
  const record = asRecord(data[key]);
  return record ? userFromWire(record) : EMPTY_USER;
}

function optionalUser(data: Record<string, unknown>, key: string): User | null {
  const record = asRecord(data[key]);
  return record ? userFromWire(record) : null;
}

function optionalMessageRef(data: Record<string, unknown>): Message | null {
  const ref = data['message'];
  return typeof ref === 'string' ? messageFromRef(ref) : null;
}

/**
 * `@` + a user's `handle`, template-literals straight into `text` via
 * `toString()`. `entry` is the wire shape `send()`'s `mentions` array wants.
 * Braces are notation only — `mention(user)` never emits `{handle}`.
 */
export class Mention {
  readonly token: string;
  readonly entry: { user: string };

  constructor(user: User) {
    this.token = '@' + user.handle;
    this.entry = { user: user.id };
  }

  toString(): string {
    return this.token;
  }
}

export function mention(user: User): Mention {
  return new Mention(user);
}

/** What `send(..., { mentions })` accepts: a `Mention`, a full `User`, or a raw `{ user: 'usr_…' }`. */
export type MentionLike = Mention | User | { user: string };

function mentionEntry(m: MentionLike): { user: string } {
  if (m instanceof Mention) return m.entry;
  if (typeof (m as { id?: unknown }).id === 'string') return { user: (m as User).id };
  return { user: (m as { user: string }).user };
}

/** What `reply()` takes besides the text: the card to hang on the message. */
export interface ReplyOptions {
  embeds?: ReadonlyArray<EmbedLike>;
  buttons?: ReadonlyArray<ButtonLike>;
  /**
   * AMENDMENT-08 §3: this card's own button cooldown, overriding the bot
   * default for every button on it (a per-button `cooldown` still wins over
   * this). `undefined` (the default) inherits the bot's; `null` disables it
   * for this card; a `Cooldown` or a plain `{ rate, per, bucket? }` literal
   * attaches one. Refused, before the round trip, if `per` exceeds 60s.
   */
  buttonCooldown?: CooldownOption;
}

/** `send()` takes the same, plus who the `@handle` tokens in `text` point at. */
export interface SendOptions extends ReplyOptions {
  mentions?: MentionLike[];
}

/**
 * `reply('hi')`, `reply('hi', { embeds })` and `reply({ embeds })` are all
 * legal — an embed-only message carries no text, so the text argument is
 * optional and the options object may take its place.
 */
function splitTextAndOptions(
  textOrOptions: string | SendOptions,
  maybeOptions?: SendOptions,
): [string, SendOptions] {
  if (typeof textOrOptions === 'string') return [textOrOptions, maybeOptions ?? {}];
  return ['', textOrOptions];
}

/**
 * A send with nothing in it is refused here, before the round trip — the
 * server would answer `empty_text`, and an embed-only send is legal, so the
 * precondition is "text OR embeds OR buttons", not "text".
 */
function requireSomethingToSay(
  text: string,
  embeds: ReadonlyArray<unknown>,
  buttons: ReadonlyArray<unknown>,
): void {
  if (text === '' && embeds.length === 0 && buttons.length === 0) {
    throw new Error(NOTHING_TO_SAY);
  }
}

/**
 * What `edit()` and `ack()` may carry (AMENDMENT-07 §9). Each of the three is
 * independently three-state:
 *
 * - absent / `undefined` — leave that part of the card alone
 * - `[]` or `null` on `embeds`/`buttons` — CLEAR that part (both spellings go
 *   on the wire as `null`; §9 accepts either so a caller who built an array
 *   and filtered it empty gets the clear they meant)
 * - a non-empty array — the replacement, validated exactly as `send` validates
 *
 * `text: ''` is a real value, not an omission: §2 moved the empty check onto
 * the merged card, so clearing the words while keeping the plate is legal.
 */
export interface EditInit {
  text?: string;
  embeds?: ReadonlyArray<EmbedLike> | null;
  buttons?: ReadonlyArray<ButtonLike> | null;
}

/**
 * One card part, resolved to its wire value. The clear is resolved BEFORE
 * serialising on purpose: `serialiseEmbeds([])` returns `[]`, not `undefined`
 * and not `null`, so handing an empty array straight to it would put an empty
 * array on the wire — which AMENDMENT-07 §2 reads as "replace with nothing
 * present" only by accident and which the server's allowlist has no reason to
 * treat as a clear. `null` is the one spelling the wire carries (R-2).
 */
function embedsPart(
  embeds: ReadonlyArray<EmbedLike> | null | undefined,
): Record<string, unknown>[] | null | undefined {
  if (embeds === undefined) return undefined;
  if (embeds === null || embeds.length === 0) return null;
  return serialiseEmbeds(embeds);
}

/**
 * `embedsPart`'s twin for buttons — same three states, same reason — plus
 * (AMENDMENT-08 §3) every button's own cooldown, needed only when this call
 * is actually replacing the button row: `undefined`/`null`/`[]` all carry an
 * EMPTY cooldown map, since there is nothing to record a per-button override
 * against.
 */
function buttonsPart(
  buttons: ReadonlyArray<ButtonLike> | null | undefined,
): { json: Record<string, unknown>[] | null | undefined; cooldowns: ReadonlyMap<string, Cooldown | null> } {
  if (buttons === undefined) return { json: undefined, cooldowns: new Map() };
  if (buttons === null || buttons.length === 0) return { json: null, cooldowns: new Map() };
  return serialiseButtonsWithCooldowns(buttons);
}

/**
 * `EditInit` -> the serialised `CardParts` the HTTP layer puts on the wire.
 * Validation of a non-empty array happens here, so a bad embed throws before
 * the round trip exactly as it does on `send`.
 */
function cardParts(
  init: EditInit,
  buttonsJson: Record<string, unknown>[] | null | undefined,
): CardParts {
  return {
    text: init.text,
    embeds: embedsPart(init.embeds),
    buttons: buttonsJson,
  };
}

/**
 * Validates and normalizes a card-level `buttonCooldown` option — ATTACHMENT
 * time, same as a per-button cooldown (`serialiseButtonsWithCooldowns`
 * already validates those). Callers run this BEFORE the network call, so a
 * too-long `per` throws before anything is sent, never after.
 */
function normalizeCardCooldown(option: CooldownOption | undefined): Cooldown | null | undefined {
  return normalizeCooldownOption(option, { boundToButton: true });
}

/**
 * AMENDMENT-08 §3's "card lookup on press": records the card-level cooldown
 * and every per-button override for one outgoing message id, so a later
 * `button.pressed` event — which carries only ids, never the `Button`
 * objects this call was given — can resolve precedence (`bot.ts`'s
 * `#handleButtonPress`). A no-op when there is nothing to override: an
 * absent card-level cooldown and no per-button ones both mean "inherit",
 * which is already what a lookup MISS resolves to. `cardCooldown` is
 * already normalized (`normalizeCardCooldown`, run before the network call).
 */
function recordCardCooldown(
  http: HttpClient,
  messageId: string,
  cardCooldown: Cooldown | null | undefined,
  buttonCooldowns: ReadonlyMap<string, Cooldown | null>,
): void {
  http.cardCooldowns.record(messageId, { cardCooldown, byButtonId: buttonCooldowns });
}

/** True when none of the three parts is present — nothing for the server to do. */
function partsAreEmpty(parts: CardParts): boolean {
  return parts.text === undefined && parts.embeds === undefined && parts.buttons === undefined;
}

/** Accepts either a `Chat` or a raw chat id string — Context actions take both. */
function chatId(c: Chat | string): string {
  return typeof c === 'string' ? c : c.id;
}

/** Accepts either a `Message` or a raw message id string — Context actions take both. */
function messageId(m: Message | string): string {
  return typeof m === 'string' ? m : m.id;
}

/**
 * One page of `GET /v1/chats/{chat}/members` (CONTRACT-V1 §4, §5.0.1). No
 * auto-loading iterator. `MemberPage` is SDK-constructed — decoded from the
 * wire `list` envelope (`{object, data, has_more, next_cursor}`), never
 * itself the wire shape — so it follows this file's camelCase-for-SDK-types
 * convention (`chatFromWire`/`messageFromWire` output camelCase-free records
 * only because their wire fields already happen to be single words or
 * `sent_at`/`reply_to`-style; a type we construct ourselves, like this one,
 * is not a wire passthrough and gets `hasMore`/`nextCursor`).
 *
 * `hasMore` is read straight off the envelope, never inferred from a short
 * page or from `nextCursor` (CONTRACT-V1 §4: that inference is "the classic
 * off-by-one that ships in every SDK"). `nextCursor` is `null` whenever
 * `hasMore` is `false` (§2.1).
 */
export interface MemberPage {
  users: User[];
  hasMore: boolean;
  nextCursor: string | null;
}

function memberPageFromEnvelope(envelope: Record<string, unknown>): MemberPage {
  const rows = envelope['data'];
  const users: User[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const record = asRecord(row);
      if (record) users.push(userFromWire(record));
    }
  }
  const hasMore = envelope['has_more'] === true;
  const cursor = envelope['next_cursor'];
  return {
    users,
    hasMore,
    nextCursor: hasMore && typeof cursor === 'string' ? cursor : null,
  };
}

// --------------------------------------------------------------------------
// Event types and the handler context each one gets (BA-R68)
// --------------------------------------------------------------------------

/** `member.joined` / `member.left` — group chats only, human members only. */
export type MemberEventType = 'member.joined' | 'member.left';
/** `bot.added` / `bot.removed` — this bot, in that chat, with who did it. */
export type BotEventType = 'bot.added' | 'bot.removed';
/** `reaction.added` — on one of this bot's own messages. There is no `reaction.removed`. */
export type ReactionEventType = 'reaction.added';
/** `button.pressed` — someone pressed a button on one of this bot's own messages (AMENDMENT-05). */
export type ButtonEventType = 'button.pressed';
/** Every event type `bot.on()` names. `command.invoked` goes through `bot.command()`. */
export type EventType = MemberEventType | BotEventType | ReactionEventType | ButtonEventType;

interface BaseInit {
  chat: Chat;
  event: Event;
  http: HttpClient;
}

/**
 * What every context shares: the chat the event happened in, the raw event,
 * and the actions. Subclasses add the fields their family delivers. The
 * actions live here so `ctx.reply()` reads the same in every handler; a
 * subclass that knows which message to quote says so through `quotes()`.
 */
export class BaseContext {
  readonly chat: Chat;
  readonly event: Event;
  readonly #http: HttpClient;

  constructor(init: BaseInit) {
    this.chat = init.chat;
    this.event = init.event;
    this.#http = init.http;
  }

  /** The message id `reply()` quotes, or `null` to send the reply free-standing. */
  protected quotes(): string | null {
    return null;
  }

  /**
   * Send a message to this chat, quoting the message this event is about
   * when there is one (BA-R27). Returns the stored message, so `sent.id` is
   * ready for `edit()`, `delete()` and `react()`.
   *
   * A fresh `Idempotency-Key` per call, reused across that call's retries by
   * `HttpClient.request` itself. When the event carried no message id the
   * `reply_to` field is omitted and the reply floats free.
   */
  async reply(text: string, options?: ReplyOptions): Promise<Message>;
  async reply(options: ReplyOptions): Promise<Message>;
  async reply(textOrOptions: string | ReplyOptions = '', maybeOptions?: ReplyOptions) {
    const [text, options] = splitTextAndOptions(textOrOptions, maybeOptions);
    const embeds = serialiseEmbeds(options.embeds);
    const { json: buttons, cooldowns } = serialiseButtonsWithCooldowns(options.buttons);
    // AMENDMENT-08: attachment-time bound check runs before the network
    // call, same as the per-button cooldowns serialiseButtonsWithCooldowns
    // already validated above.
    const cardCooldown = normalizeCardCooldown(options.buttonCooldown);
    requireSomethingToSay(text, embeds, buttons);
    const sent = await this.#http.sendMessage(
      this.chat.id,
      text,
      randomUUID(),
      this.quotes(),
      undefined,
      embeds,
      buttons,
    );
    const message = messageFromWire(sent);
    if (buttons.length > 0) {
      recordCardCooldown(this.#http, message.id, cardCooldown, cooldowns);
    }
    return message;
  }

  /**
   * Send a message to any chat this bot is in — this one or another.
   * `mentions` names who `@handle` tokens in `text` point at: pass
   * `mention(user)`, a `User`, or `{ user: 'usr_…' }`. `embeds`/`buttons`
   * accept a builder or a plain object literal, validated the same either
   * way. Returns the stored message.
   */
  async send(chat: Chat | string, text: string, options?: SendOptions): Promise<Message>;
  async send(chat: Chat | string, options: SendOptions): Promise<Message>;
  async send(
    chat: Chat | string,
    textOrOptions: string | SendOptions = '',
    maybeOptions?: SendOptions,
  ) {
    const [text, options] = splitTextAndOptions(textOrOptions, maybeOptions);
    const mentions = options.mentions?.map(mentionEntry);
    const embeds = serialiseEmbeds(options.embeds);
    const { json: buttons, cooldowns } = serialiseButtonsWithCooldowns(options.buttons);
    const cardCooldown = normalizeCardCooldown(options.buttonCooldown);
    requireSomethingToSay(text, embeds, buttons);
    const sent = await this.#http.sendMessage(
      chatId(chat),
      text,
      randomUUID(),
      null,
      mentions,
      embeds,
      buttons,
    );
    const message = messageFromWire(sent);
    if (buttons.length > 0) {
      recordCardCooldown(this.#http, message.id, cardCooldown, cooldowns);
    }
    return message;
  }

  /**
   * Show or clear "is thinking…" in this chat. `POST /v1/chats/{chat}/typing`
   * with `{"is_typing": bool}`. Command handlers get this automatically
   * (auto-typing); reach for `withTyping()` when you want it yourself.
   */
  async typing(isTyping: boolean): Promise<void> {
    const id = this.chat.id;
    if (id === '') {
      throw new AurivalError('ctx.typing() needs a chat, and this event has none');
    }
    await this.#http.setTyping(id, isTyping);
  }

  /** Runs `fn` with the indicator on: `true` on entry, `false` on exit — ALWAYS, including on throw. */
  async withTyping<T>(fn: () => Promise<T>): Promise<T> {
    await this.typing(true);
    try {
      return await fn();
    } finally {
      await this.typing(false);
    }
  }

  /**
   * Change one of this bot's own messages in place. Pass what `reply()` or
   * `send()` returned, or its id. Someone else's message is `MessageNotYours`.
   * Returns the updated message.
   *
   * Two forms, and the string one is the door AMENDMENT-05 opened and both
   * READMEs teach — `ctx.edit(sent, 'done!')` keeps working byte for byte and
   * means `{ text: 'done!' }`:
   *
   * ```ts
   * await ctx.edit(sent, 'done!');                         // words only
   * await ctx.edit(sent, { embeds: [result] });            // plate only
   * await ctx.edit(sent, { text: '', buttons: [again] });  // empty words, new row
   * await ctx.edit(sent, { buttons: [] });                 // take the row off
   * ```
   *
   * AMENDMENT-07 §2: a part you do not pass is KEPT, `[]` or `null` on
   * `embeds`/`buttons` CLEARS it, and the server validates the merged card, so
   * `text: ''` is legal as long as something survives. An edit carrying none of
   * the three is refused here, before the round trip.
   *
   * No card-level `buttonCooldown` door here: AMENDMENT-08 §3 names exactly
   * one, `send(..., buttonCooldown)` (mirrored on `reply()`). A per-button
   * `new Button({ cooldown })` in a replacement row is still honoured — the
   * card table entry is recorded fresh with its card level left unset
   * ("inherit"), same as `reply()`/`send()` when no card-level cooldown was
   * passed either.
   */
  async edit(message: Message | string, text: string): Promise<Message>;
  async edit(message: Message | string, init?: EditInit): Promise<Message>;
  async edit(message: Message | string, textOrInit?: string | EditInit): Promise<Message> {
    const init: EditInit = typeof textOrInit === 'string' ? { text: textOrInit } : (textOrInit ?? {});
    const resolvedButtons = buttonsPart(init.buttons);
    const parts = cardParts(init, resolvedButtons.json);
    if (partsAreEmpty(parts)) throw new Error(NOTHING_TO_EDIT);
    const updated = messageFromWire(await this.#http.editMessage(messageId(message), parts));
    // AMENDMENT-08 §3: "carry the same recording through ack()/edit() when
    // they replace buttons" — only when this call actually replaces the row
    // with a non-empty array; `undefined` (kept) and `null`/`[]` (cleared)
    // have nothing fresh to record. The card level is always `undefined`
    // here (no door to set it on this call) — see the doc comment above.
    if (Array.isArray(resolvedButtons.json) && resolvedButtons.json.length > 0) {
      recordCardCooldown(this.#http, updated.id, undefined, resolvedButtons.cooldowns);
    }
    return updated;
  }

  /** Delete one of this bot's own messages. Someone else's is `MessageNotYours`. */
  async delete(message: Message | string): Promise<void> {
    await this.#http.deleteMessage(messageId(message));
  }

  /**
   * Put a reaction on a message, one emoji at a time. Reacting twice with the
   * same emoji is a no-op; a string longer than one emoji is
   * `ReactionEmojiTooLong`.
   */
  async react(message: Message | string, emoji: string): Promise<void> {
    await this.#http.setReaction(messageId(message), emoji);
  }

  /** Take a reaction off. Removing one that is not there is a no-op. */
  async unreact(message: Message | string, emoji: string): Promise<void> {
    await this.#http.unsetReaction(messageId(message), emoji);
  }

  /**
   * One page of who is in a chat, bots included — this chat by default.
   * Check `hasMore` and pass `nextCursor` back as `cursor` for the next page;
   * `ctx.chat.member_count` is the total without a call.
   */
  async members(chat?: Chat | string, options: { cursor?: string } = {}): Promise<MemberPage> {
    const resolved = chat !== undefined ? chatId(chat) : this.chat.id;
    if (resolved === '') {
      throw new AurivalError(
        'ctx.members() needs a chat: pass one, or call it where ctx.chat is already set',
      );
    }
    const envelope = await this.#http.listMembers(resolved, options.cursor);
    return memberPageFromEnvelope(envelope);
  }
}

export interface ContextInit extends BaseInit {
  command: string;
  arguments: string;
  sender: User;
  message: Message;
}

/**
 * What a `bot.command()` handler receives. Built by `bot.ts`'s dispatch
 * closure from one `command.invoked` event — `Socket` never constructs one.
 * `sender` and `message` are always set: the server never emits a command
 * without both.
 */
export class Context extends BaseContext {
  /** The command name as the server matched it, without the slash. */
  readonly command: string;
  /** Everything after the command name, untrimmed of its inner spaces. `''` when there was nothing. */
  readonly arguments: string;
  /** Who typed the command. */
  readonly sender: User;
  /** The message that carried the command. `reply()` quotes it. */
  readonly message: Message;

  constructor(init: ContextInit) {
    super(init);
    this.command = init.command;
    this.arguments = init.arguments;
    this.sender = init.sender;
    this.message = init.message;
  }

  protected override quotes(): string | null {
    return this.message.id === '' ? null : this.message.id;
  }

  /** Build straight from a `command.invoked` event's raw `data`. */
  static fromEvent(event: Event, http: HttpClient): Context {
    const data = event.data;
    const invokingMessage = asRecord(data['invoking_message']);
    const ref = data['message'];
    let message: Message;
    if (invokingMessage) {
      // BA-R42: the invoking message travels with the event as a full object
      // under `invoking_message`. Prefer that.
      message = messageFromWire(invokingMessage);
    } else if (typeof ref === 'string') {
      // `message` (the bare id string) is UNCHANGED wire compatibility — an
      // old server that has not deployed BA-R42 yet sends only that string,
      // so we fall back to an id-only Message, keeping a new SDK working
      // against an old server.
      message = messageFromRef(ref);
    } else {
      message = EMPTY_MESSAGE;
    }
    return new Context({
      command: asString(data['command']),
      arguments: asString(data['arguments']),
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      sender: userField(data, 'sender'),
      message,
      event,
      http,
    });
  }
}

export interface MemberContextInit extends BaseInit {
  user: User;
}

/** `member.joined` / `member.left`: someone came into, or left, a group chat this bot is in. */
export class MemberContext extends BaseContext {
  /** Who joined or left. Never the bot itself — that is `bot.added` / `bot.removed`. */
  readonly user: User;

  constructor(init: MemberContextInit) {
    super(init);
    this.user = init.user;
  }

  static fromEvent(event: Event, http: HttpClient): MemberContext {
    const data = event.data;
    return new MemberContext({
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      user: userField(data, 'user'),
      event,
      http,
    });
  }
}

export interface BotContextInit extends BaseInit {
  actor: User;
}

/** `bot.added` / `bot.removed`: this bot was put into, or taken out of, a chat. */
export class BotContext extends BaseContext {
  /** The person who added or removed the bot. */
  readonly actor: User;

  constructor(init: BotContextInit) {
    super(init);
    this.actor = init.actor;
  }

  static fromEvent(event: Event, http: HttpClient): BotContext {
    const data = event.data;
    return new BotContext({
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      actor: userField(data, 'actor'),
      event,
      http,
    });
  }
}

export interface ReactionContextInit extends BaseInit {
  sender: User;
  message: Message;
  emoji: string;
}

/** `reaction.added`: someone reacted to one of this bot's own messages. */
export class ReactionContext extends BaseContext {
  /** Who reacted. */
  readonly sender: User;
  /** The bot's message they reacted to — id only; the text is not re-sent. `reply()` quotes it. */
  readonly message: Message;
  /** The emoji, as one string. */
  readonly emoji: string;

  constructor(init: ReactionContextInit) {
    super(init);
    this.sender = init.sender;
    this.message = init.message;
    this.emoji = init.emoji;
  }

  protected override quotes(): string | null {
    return this.message.id === '' ? null : this.message.id;
  }

  static fromEvent(event: Event, http: HttpClient): ReactionContext {
    const data = event.data;
    return new ReactionContext({
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      sender: userField(data, 'sender'),
      message: optionalMessageRef(data) ?? EMPTY_MESSAGE,
      emoji: asString(data['emoji']),
      event,
      http,
    });
  }
}

export interface ButtonContextInit extends BaseInit {
  user: User;
  message: Message;
  button: string;
  interaction: string;
}

/** `button.pressed`: someone pressed a button on one of this bot's own messages (AMENDMENT-05). */
export class ButtonContext extends BaseContext {
  readonly #http: HttpClient;
  /** Who pressed the button. */
  readonly user: User;
  /** The bot's message the button lives on — id only; the text is not re-sent. `reply()` quotes it. */
  readonly message: Message;
  /** The pressed button's id. */
  readonly button: string;
  /** The interaction id — `ack()` posts to `/v1/interactions/{interaction}/ack`. */
  readonly interaction: string;

  constructor(init: ButtonContextInit) {
    super(init);
    this.#http = init.http;
    this.user = init.user;
    this.message = init.message;
    this.button = init.button;
    this.interaction = init.interaction;
  }

  protected override quotes(): string | null {
    return this.message.id === '' ? null : this.message.id;
  }

  /**
   * Acknowledge the button press — `POST /v1/interactions/{interaction}/ack`,
   * 204. Acking twice is `InteractionAlreadyUsed` (surfaced through the
   * existing code -> class mapping; there is no dedicated class here).
   *
   * `ack()` with no argument sends NO BODY and is byte-identical to 0.5.0: the
   * pressed row simply flips to used. Pass a body and AMENDMENT-07 §3 makes
   * the ack and the card replacement ONE atomic write, so a question card
   * becomes its result card without a second request and without a window
   * where the press is spent and the card still asks:
   *
   * ```ts
   * await ctx.ack({ text: '', embeds: [result], buttons: [playAgain] });
   * ```
   *
   * Clearing works as it does on `edit()`: `[]` or `null` puts `null` on the
   * wire. A body carrying `buttons` resets `used` to null — the row is new, so
   * it starts unused, and reusing the old ids is safe (§3). An ack never marks
   * the message edited. Unlike `edit()` there is no client-side emptiness
   * precondition: an ack with nothing in it is the flip, which is legal.
   *
   * No card-level `buttonCooldown` door here either, for the same reason as
   * `edit()`: AMENDMENT-08 §3 names exactly one, `send(..., buttonCooldown)`.
   * A per-button `new Button({ cooldown })` in a replacement row is still
   * honoured — the card table entry is recorded fresh with its card level
   * left unset ("inherit").
   */
  async ack(init?: EditInit): Promise<void> {
    if (init === undefined) {
      await this.#http.ackInteraction(this.interaction);
      return;
    }
    const resolvedButtons = buttonsPart(init.buttons);
    await this.#http.ackInteraction(this.interaction, cardParts(init, resolvedButtons.json));
    // AMENDMENT-08 §3: "carry the same recording through ack()/edit() when
    // they replace buttons" — the ack always concerns the button's own
    // message (`this.message`), so that id is the card table key here, same
    // as `updated.id` is for `edit()`. The card level is always `undefined`
    // here (no door to set it on this call) — see the doc comment above.
    if (Array.isArray(resolvedButtons.json) && resolvedButtons.json.length > 0) {
      recordCardCooldown(this.#http, this.message.id, undefined, resolvedButtons.cooldowns);
    }
  }

  static fromEvent(event: Event, http: HttpClient): ButtonContext {
    const data = event.data;
    const ref = data['message'];
    return new ButtonContext({
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      user: userField(data, 'user'),
      message: typeof ref === 'string' ? messageFromRef(ref) : EMPTY_MESSAGE,
      button: asString(data['button']),
      interaction: asString(data['interaction']),
      event,
      http,
    });
  }
}

export interface EventContextInit extends BaseInit {
  sender: User | null;
  user: User | null;
  actor: User | null;
  message: Message | null;
  emoji: string | null;
}

/**
 * An event type this SDK does not name yet. Nothing is pinned, so every
 * field is read off the frame if it is there and `null` if it is not —
 * whatever the wire carries is surfaced rather than discarded, and building
 * one never throws.
 */
export class EventContext extends BaseContext {
  readonly sender: User | null;
  readonly user: User | null;
  readonly actor: User | null;
  readonly message: Message | null;
  readonly emoji: string | null;

  constructor(init: EventContextInit) {
    super(init);
    this.sender = init.sender;
    this.user = init.user;
    this.actor = init.actor;
    this.message = init.message;
    this.emoji = init.emoji;
  }

  protected override quotes(): string | null {
    return this.message === null || this.message.id === '' ? null : this.message.id;
  }

  static fromEvent(event: Event, http: HttpClient): EventContext {
    const data = event.data;
    const emoji = data['emoji'];
    return new EventContext({
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      sender: optionalUser(data, 'sender'),
      user: optionalUser(data, 'user'),
      actor: optionalUser(data, 'actor'),
      message: optionalMessageRef(data),
      emoji: typeof emoji === 'string' ? emoji : null,
      event,
      http,
    });
  }
}

/** Any context a handler can receive. What `bot.onError()` sees beside the error. */
export type AnyContext =
  Context | MemberContext | BotContext | ReactionContext | ButtonContext | EventContext;

/**
 * The context class for an event, by its type. `command.invoked` gets
 * `Context`; the four named families get theirs; anything else gets
 * `EventContext`. The dispatch side of BA-R68 — `bot.ts` calls this and
 * hands the result to every handler registered for the type.
 */
export function contextFor(event: Event, http: HttpClient): AnyContext {
  switch (event.type) {
    case 'command.invoked':
      return Context.fromEvent(event, http);
    case 'member.joined':
    case 'member.left':
      return MemberContext.fromEvent(event, http);
    case 'bot.added':
    case 'bot.removed':
      return BotContext.fromEvent(event, http);
    case 'reaction.added':
      return ReactionContext.fromEvent(event, http);
    case 'button.pressed':
      return ButtonContext.fromEvent(event, http);
    default:
      return EventContext.fromEvent(event, http);
  }
}
