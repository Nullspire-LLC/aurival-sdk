/**
 * Shared by forms.test.ts and forms.vectors.test.ts: one fake server that is
 * both the REST API and the gateway (token exchange, command sync, message
 * send and interaction ack, the last two captured), a paired key file, and a
 * builder for a raw `form.submitted` frame whose `values` text the test
 * controls byte for byte.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeyFile, MachineKey, type Machine } from '../src/auth.js';
import { startGateway, type GatewayServer, type Script } from './wsserver.js';

export interface AckCall {
  interaction: string;
  body: unknown;
}

export interface FormServer extends GatewayServer {
  host: string;
  ackCalls: AckCall[];
  sentMessages: Record<string, unknown>[];
}

export async function startFormServer(script: Script): Promise<FormServer> {
  const sentMessages: Record<string, unknown>[] = [];
  const ackCalls: AckCall[] = [];
  const gateway = await startGateway(script, (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: unknown = raw ? JSON.parse(raw) : undefined;

      if (req.url === '/v1/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'tok_test',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
        return;
      }
      if (req.url?.startsWith('/v1/bots/') && req.url.endsWith('/commands') && req.method === 'PUT') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }));
        return;
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        sentMessages.push(body as Record<string, unknown>);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'message', id: `msg_sent_${sentMessages.length}` }));
        return;
      }
      const ack = /^\/v1\/interactions\/([^/]+)\/ack$/.exec(req.url ?? '');
      if (ack !== null && req.method === 'POST') {
        ackCalls.push({ interaction: ack[1] as string, body });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'invalid_request_error',
          code: 'not_found',
          message: 'not found',
          doc_url: 'https://bots.aurival.com/docs/errors#not_found',
        }),
      );
    })();
  });
  const host = gateway.url.replace(/^ws:\/\//, 'http://').replace(/\/v1\/gateway$/, '');
  return { ...gateway, host, ackCalls, sentMessages };
}

export async function withPairedBot<T>(
  gateway: { host: string },
  run: (keyPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurival-forms-test-'));
  const keyPath = path.join(dir, 'machine.json');
  const machine: Machine = {
    bot: 'bot_test',
    machine: 'machine_test',
    host: gateway.host,
    created: '2026-01-01T00:00:00Z',
  };
  await new KeyFile(keyPath).save(MachineKey.generate(), machine);
  try {
    return await run(keyPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface FormFrameInit {
  eventId: string;
  sequence?: number;
  button?: string;
  interaction?: string;
  /** The exact JSON text of the `values` object, e.g. `{"amount":12.50}`. */
  valuesText: string;
  /** Raw JSON members spliced into `data` BEFORE `values`, to prove the scan is structural. */
  decoyMembers?: string;
}

/** A `form.submitted` event frame as the server writes it (AMENDMENT-10 §4), with the caller's `values` text verbatim. */
export function formFrameText(init: FormFrameInit): string {
  const decoy = init.decoyMembers === undefined ? '' : `${init.decoyMembers},`;
  return (
    `{"op":"event","d":{"object":"event","id":${JSON.stringify(init.eventId)},` +
    `"type":"form.submitted","created_at":"2026-10-08T14:14:03Z","sequence":${init.sequence ?? 1},` +
    `"data":{${decoy}"interaction":${JSON.stringify(init.interaction ?? init.eventId)},` +
    `"chat":"ch_1","message":"msg_1","button":${JSON.stringify(init.button ?? 'trip_signup')},` +
    `"user":{"id":"u_1","username":"ana"},"values":${init.valuesText},` +
    `"submitted_at":"2026-10-08T14:14:03Z"}}}`
  );
}
