/**
 * Plain data a command handler receives (CONTRACT-V1 §3, §3.1).
 *
 * `Event` is the raw wire frame; `Context` is what `bot.ts` hands to a handler,
 * built from one. `Context` holds an `HttpClient` for `reply()` and nothing else
 * network-shaped — never the seed, a token, or the `Auth` object (SDK-33).
 */

import { randomUUID } from 'node:crypto';
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
  return {
    id: asString(d['id']),
    type: asString(d['type']),
    name: typeof name === 'string' ? name : null,
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

export interface ContextInit {
  command: string;
  arguments: string;
  chat: Chat;
  sender: User;
  event: Event;
  message: Message | null;
  http: HttpClient;
}

/**
 * What a command handler receives. Built by `bot.ts`'s dispatch closure from one
 * `Event` — `Socket` never constructs one.
 */
export class Context {
  readonly command: string;
  readonly arguments: string;
  readonly chat: Chat;
  readonly sender: User;
  readonly event: Event;
  readonly message: Message | null;
  readonly #http: HttpClient;

  constructor(init: ContextInit) {
    this.command = init.command;
    this.arguments = init.arguments;
    this.chat = init.chat;
    this.sender = init.sender;
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
      event,
      message: resolvedMessage,
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
}
