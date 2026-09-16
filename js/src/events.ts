/**
 * Plain data a command handler receives (CONTRACT-V1 §3, §3.1).
 *
 * `Event` is the raw wire frame; `Context` is what `bot.ts` hands to a handler,
 * built from one. `Context` holds an `HttpClient` for `reply()` and nothing else
 * network-shaped — never the seed, a token, or the `Auth` object (SDK-33).
 */

import { randomUUID } from 'node:crypto';
import { AurivalError } from './errors.js';
import type { HttpClient } from './http.js';

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

export interface Message {
  id: string;
  text: string;
  sent_at: string;
  sender: User | null;
  reply_to: string | null;
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
  const sender = asRecord(d['sender']);
  return {
    id: asString(d['id']),
    text: asString(d['text']),
    sent_at: asString(d['sent_at']),
    sender: sender ? userFromWire(sender) : null,
    reply_to: typeof replyTo === 'string' ? replyTo : null,
  };
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

/**
 * Which `Context` fields a KNOWN generic event type actually carries
 * (CONTRACT-V1 §3.1). Any field not in a type's set is forced `null` when
 * building that type's `Context`, even if the wire payload happens to carry
 * a stray one — the payload shape for a known type is pinned by contract, so
 * JS must not surface what python's identical build does not (senior review,
 * merge gate). A type not in this map is unknown to this SDK and gets
 * opportunistic, unpinned population instead — see `fromGenericEvent`.
 */
const KNOWN_GENERIC_EVENT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'member.joined': new Set(['user']),
  'member.left': new Set(['user']),
  'bot.added': new Set(['actor']),
  'bot.removed': new Set(['actor']),
  'reaction.added': new Set(['sender', 'message', 'emoji']),
};

export interface ContextInit {
  command: string;
  arguments: string;
  chat: Chat;
  sender: User | null;
  /** Populated only for `member.joined` / `member.left`. */
  user: User | null;
  /** Populated only for `bot.added` / `bot.removed`. */
  actor: User | null;
  /** Populated only for `reaction.added`. */
  emoji: string | null;
  event: Event;
  message: Message | null;
  http: HttpClient;
}

/**
 * What a handler receives. Built by `bot.ts`'s dispatch closure from one
 * `Event` — `Socket` never constructs one. ONE class for every event type
 * (R6): `chat`/`sender`/`user`/`actor`/`message`/`emoji` are each populated
 * only for the event types that carry them —
 *
 *   - `command.invoked`: `chat`, `sender`, `message`
 *   - `member.joined` / `member.left`: `chat`, `user`
 *   - `bot.added` / `bot.removed`: `chat`, `actor`
 *   - `reaction.added`: `chat`, `sender`, `message`, `emoji`
 *
 * — everything else on a given `Context` is `null`. An unhandled or future
 * event type never throws building one: every field is read defensively off
 * `event.data` and falls back to `null`.
 */
export class Context {
  readonly command: string;
  readonly arguments: string;
  readonly chat: Chat;
  readonly sender: User | null;
  readonly user: User | null;
  readonly actor: User | null;
  readonly emoji: string | null;
  readonly event: Event;
  readonly message: Message | null;
  readonly #http: HttpClient;

  constructor(init: ContextInit) {
    this.command = init.command;
    this.arguments = init.arguments;
    this.chat = init.chat;
    this.sender = init.sender;
    this.user = init.user;
    this.actor = init.actor;
    this.emoji = init.emoji;
    this.event = init.event;
    this.message = init.message;
    this.#http = init.http;
  }

  /** Build straight from a `command.invoked` event's raw `data`. */
  static fromEvent(event: Event, http: HttpClient): Context {
    const data = event.data;
    const invokingMessage = asRecord(data['invoking_message']);
    const message = data['message'];
    let resolvedMessage: Message | null;
    if (invokingMessage) {
      // BA-R42: the invoking message travels with the event as a full object
      // under `invoking_message`. Prefer that.
      resolvedMessage = messageFromWire(invokingMessage);
    } else if (typeof message === 'string') {
      // `message` (the bare id string) is UNCHANGED wire compatibility — an
      // old server that has not deployed BA-R42 yet sends only that string,
      // so we fall back to an id-only Message rather than null, keeping a
      // new SDK working against an old server.
      resolvedMessage = { id: message, text: '', sent_at: '', sender: null, reply_to: null };
    } else {
      resolvedMessage = null;
    }
    return new Context({
      command: asString(data['command']),
      arguments: asString(data['arguments']),
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      sender: userFromWire(asRecord(data['sender']) ?? {}),
      user: null,
      actor: null,
      emoji: null,
      event,
      message: resolvedMessage,
      http,
    });
  }

  /**
   * Build from any non-`command.invoked` event `bot.on(type, fn)` registered
   * for — `member.joined`/`member.left`, `bot.added`/`bot.removed`,
   * `reaction.added`, or a type this SDK does not yet know the shape of.
   *
   * For a KNOWN type, the field set is pinned by CONTRACT-V1 §3.1: only the
   * fields that type actually carries are read off `data`, and every other
   * field is forced `null` even if the payload happens to carry a stray one
   * (a `member.joined` frame with a stray `sender` must not populate
   * `ctx.sender` — matches python). For a type this SDK does not recognize,
   * every field is read defensively and opportunistically — there is no
   * contract to pin it to, so whatever the frame happens to carry is
   * surfaced rather than discarded. `chat` itself falls back to an empty one
   * rather than throwing, for both cases.
   */
  static fromGenericEvent(event: Event, http: HttpClient): Context {
    const data = event.data;
    const chat = chatFromWire(asRecord(data['chat']) ?? {});
    const known = KNOWN_GENERIC_EVENT_FIELDS[event.type];

    if (known !== undefined) {
      const sender = known.has('sender') ? asRecord(data['sender']) : null;
      const user = known.has('user') ? asRecord(data['user']) : null;
      const actor = known.has('actor') ? asRecord(data['actor']) : null;
      const messageId = known.has('message') ? data['message'] : undefined;
      const emoji = known.has('emoji') ? data['emoji'] : undefined;
      return new Context({
        command: '',
        arguments: '',
        chat,
        sender: sender ? userFromWire(sender) : null,
        user: user ? userFromWire(user) : null,
        actor: actor ? userFromWire(actor) : null,
        emoji: typeof emoji === 'string' ? emoji : null,
        event,
        message:
          typeof messageId === 'string'
            ? { id: messageId, text: '', sent_at: '', sender: null, reply_to: null }
            : null,
        http,
      });
    }

    // Unknown type: opportunistic population, nothing pinned.
    const sender = asRecord(data['sender']);
    const user = asRecord(data['user']);
    const actor = asRecord(data['actor']);
    const messageId = data['message'];
    const emoji = data['emoji'];
    return new Context({
      command: '',
      arguments: '',
      chat,
      sender: sender ? userFromWire(sender) : null,
      user: user ? userFromWire(user) : null,
      actor: actor ? userFromWire(actor) : null,
      emoji: typeof emoji === 'string' ? emoji : null,
      event,
      message:
        typeof messageId === 'string'
          ? { id: messageId, text: '', sent_at: '', sender: null, reply_to: null }
          : null,
      http,
    });
  }

  /**
   * `POST /v1/messages`, quoting the message that invoked the command
   * (BA-R27, reversing SDK-30). One method, no flag. When the event carried no
   * message id the field is omitted and the reply floats free.
   *
   * A fresh `Idempotency-Key` per call, reused across that call's retries by
   * `HttpClient.request` itself.
   */
  async reply(text: string): Promise<Record<string, unknown>> {
    return this.#http.sendMessage(this.chat.id, text, randomUUID(), this.message?.id ?? null);
  }

  /** `POST /v1/chats/{chat}/typing` — `is_typing` only, no `state` spelling. */
  async typing(isTyping: boolean): Promise<void> {
    const id = this.chat.id;
    if (id === '') {
      throw new AurivalError('ctx.typing() needs a chat, and this event has none');
    }
    await this.#http.setTyping(id, isTyping);
  }

  /** Sends `true` on entry, `false` on exit — ALWAYS, including on throw. */
  async withTyping<T>(fn: () => Promise<T>): Promise<T> {
    await this.typing(true);
    try {
      return await fn();
    } finally {
      await this.typing(false);
    }
  }

  async edit(message: Message | string, text: string): Promise<Record<string, unknown>> {
    return this.#http.editMessage(messageId(message), text);
  }

  async delete(message: Message | string): Promise<void> {
    await this.#http.deleteMessage(messageId(message));
  }

  async react(message: Message | string, emoji: string): Promise<void> {
    await this.#http.setReaction(messageId(message), emoji);
  }

  async unreact(message: Message | string, emoji: string): Promise<void> {
    await this.#http.unsetReaction(messageId(message), emoji);
  }

  async send(
    chat: Chat | string,
    text: string,
    options: { mentions?: MentionLike[] } = {},
  ): Promise<Record<string, unknown>> {
    const mentions = options.mentions?.map(mentionEntry);
    return this.#http.sendMessage(chatId(chat), text, randomUUID(), null, mentions);
  }

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
