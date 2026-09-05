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

export interface ContextInit {
  command: string;
  arguments: string;
  chat: Chat;
  sender: User;
  event: Event;
  message: string | null;
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
  readonly message: string | null;
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
    const message = data['message'];
    return new Context({
      command: asString(data['command']),
      arguments: asString(data['arguments']),
      chat: chatFromWire(asRecord(data['chat']) ?? {}),
      sender: userFromWire(asRecord(data['sender']) ?? {}),
      event,
      // The `msg_` id of the message the bot was addressed with
      // (botview.go's CommandInvokedData.Message). `reply` quotes it (BA-R27).
      // An absent field is null, not a crash — then the reply floats free.
      message: typeof message === 'string' ? message : null,
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
    return this.#http.sendMessage(this.chat.id, text, randomUUID(), this.message);
  }
}
