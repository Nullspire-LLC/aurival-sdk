/**
 * A minimal RFC6455 WebSocket server over `node:http`'s `upgrade` event —
 * hand-rolled because Node has no built-in WS *server* and `sdk/js` may add
 * zero runtime dependencies. Text frames under 64KB only; that is all this
 * protocol uses.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket as NetSocket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKeyFor(key: string): string {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error('wsserver test helper only supports frames under 64KB');
  }
  return Buffer.concat([header, payload]);
}

function encodeText(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'));
}

/** Parses masked client frames off a byte stream, one complete frame at a time. */
class FrameParser {
  #buf = Buffer.alloc(0);
  readonly #onFrame: (opcode: number, payload: Buffer) => void;

  constructor(onFrame: (opcode: number, payload: Buffer) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#buf.length < 2) return;
      const b0 = this.#buf[0]!;
      const b1 = this.#buf[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.#buf.length < 4) return;
        len = this.#buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.#buf.length < 10) return;
        len = Number(this.#buf.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.#buf.length < offset + 4) return;
        maskKey = this.#buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.#buf.length < offset + len) return;
      let payload = this.#buf.subarray(offset, offset + len);
      if (maskKey) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) {
          unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
        }
        payload = unmasked;
      }
      this.#buf = this.#buf.subarray(offset + len);
      this.#onFrame(opcode, Buffer.from(payload));
    }
  }
}

export interface ReceivedFrame {
  connIdx: number;
  op: string;
  d: Record<string, unknown>;
}

/** Mirrors `test_socket.py`'s `ServerState`. */
export class ServerState {
  connectCount = 0;
  connectTimes: number[] = [];
  received: ReceivedFrame[] = [];

  acksFor(connIdx: number): string[] {
    return this.received
      .filter((f) => f.connIdx === connIdx && f.op === 'ack')
      .map((f) => String(f.d['event_id']));
  }

  heartbeatsFor(connIdx: number): number {
    return this.received.filter((f) => f.connIdx === connIdx && f.op === 'heartbeat').length;
  }
}

export interface WsConn {
  send(obj: unknown): void;
  /** A bare close, no `bye` — a network fault by contract. */
  close(): void;
}

export type Script = (conn: WsConn, idx: number, state: ServerState) => Promise<void>;

export interface GatewayServer {
  state: ServerState;
  url: string;
  close(): Promise<void>;
}

/** Runs `script` once per accepted connection against a real websocket handshake. */
export async function startGateway(script: Script): Promise<GatewayServer> {
  const state = new ServerState();
  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  server.on('upgrade', (req: IncomingMessage, socket: NetSocket, head: Buffer) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
    );

    const idx = state.connectCount;
    state.connectCount += 1;
    state.connectTimes.push(performance.now() / 1000);

    let closed = false;
    const conn: WsConn = {
      send(obj: unknown) {
        if (closed) return;
        socket.write(encodeText(JSON.stringify(obj)));
      },
      close() {
        if (closed) return;
        closed = true;
        socket.end(encodeFrame(0x8, Buffer.alloc(0)));
      },
    };

    const parser = new FrameParser((opcode, payload) => {
      if (opcode === 0x8) {
        closed = true;
        socket.end();
        return;
      }
      if (opcode === 0x1) {
        try {
          const frame = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
          const d = frame['d'];
          state.received.push({
            connIdx: idx,
            op: typeof frame['op'] === 'string' ? frame['op'] : '',
            d: typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {},
          });
        } catch {
          // ignore malformed test traffic
        }
      }
    });

    socket.on('data', (chunk: Buffer) => parser.push(chunk));
    socket.on('error', () => {
      closed = true;
    });
    socket.on('close', () => {
      closed = true;
    });
    if (head.length > 0) parser.push(head);

    void script(conn, idx, state).finally(() => {
      if (!closed) conn.close();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    state,
    url: `ws://127.0.0.1:${port}/v1/gateway`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** A server that refuses every handshake with 401 — for the redaction test. */
export interface RefusingServer {
  seenAuth: string[];
  url: string;
  close(): Promise<void>;
}

export async function startRefusingGateway(): Promise<RefusingServer> {
  const seenAuth: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('upgrade', (req: IncomingMessage, socket: NetSocket) => {
    seenAuth.push(req.headers['authorization'] ?? '');
    socket.on('error', () => {
      // The client tears its side down the instant it sees the refusal;
      // an RST racing our own `end()` is expected, not a test failure.
    });
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    seenAuth,
    url: `ws://127.0.0.1:${port}/v1/gateway`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** A resolvable promise, without the `T | null` narrowing tests otherwise fight. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return pred();
}

export function sendHello(conn: WsConn, heartbeatMs = 20): void {
  conn.send({
    op: 'hello',
    d: { session_id: 's', heartbeat_interval_ms: heartbeatMs, resuming_from_sequence: 0 },
  });
}

export function byeFrame(code: string, errorType: string): Record<string, unknown> {
  return {
    op: 'bye',
    d: {
      error: {
        type: errorType,
        code,
        message: `bye: ${code}`,
        doc_url: `https://bots.aurival.com/docs/errors#${code}`,
        request_id: 'req_1',
      },
    },
  };
}

export function problemFrame(
  code: string,
  errorType = 'invalid_request_error',
): Record<string, unknown> {
  return {
    op: 'problem',
    d: {
      error: {
        type: errorType,
        code,
        message: `problem: ${code}`,
        doc_url: `https://bots.aurival.com/docs/errors#${code}`,
        request_id: 'req_1',
      },
    },
  };
}

export function commandInvokedEvent(eventId: string, sequence = 1): Record<string, unknown> {
  return {
    op: 'event',
    d: {
      object: 'event',
      id: eventId,
      type: 'command.invoked',
      created_at: '2026-01-01T00:00:00Z',
      sequence,
      data: {
        command: 'ping',
        arguments: '',
        message: 'msg_1',
        chat: { object: 'chat', id: 'chat_1', type: 'dm', name: null },
        sender: { object: 'user', id: 'user_1', handle: 'h', name: 'n' },
      },
    },
  };
}

export function backlogOverflowedEvent(eventId = 'evt_bo'): Record<string, unknown> {
  return {
    op: 'event',
    d: {
      object: 'event',
      id: eventId,
      type: 'backlog.overflowed',
      created_at: '2026-01-01T00:00:00Z',
      sequence: 0,
      data: { dropped_count: 5, resume_sequence: 42 },
    },
  };
}
