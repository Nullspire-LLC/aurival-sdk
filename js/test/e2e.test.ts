/**
 * A real bot answering /ping, through the real service.
 *
 * This is the acceptance bar for the whole package (PLAN.md, "Tests"): pair, print
 * a code, approve it, sync commands, invoke, read `pong` back. Nothing here is
 * mocked — if the testbed cannot run, the suite says it SKIPPED rather than passing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, '..');
const REPO = path.resolve(SDK, '..', '..');
const BACKEND = path.join(REPO, 'backend-go');
const DSN_ENV = 'MIGRATE_TEST_DATABASE_URL';

// MATCHED ON ITS LABEL, NOT ITS SHAPE. newUserCode() and Fingerprint() produce the
// same XXXX-XXXX shape and both print during pairing, so a shape-only match picks
// up whichever came first and then fails at approval with no explanation.
const CODE_RE = /pairing code\s+([0-9A-Z]{4}-[0-9A-Z]{4})/;

const BOT_SOURCE = (dist: string) => `
import { Bot } from ${JSON.stringify(dist)};

const bot = new Bot();

bot.command("ping", "Check that the bot is alive", async (ctx) => {
  await ctx.reply("pong");
});

bot.run();
`;

function skipReason(): string | null {
  if (!process.env[DSN_ENV]) {
    return (
      `${DSN_ENV} is not set, so the SDK end-to-end suite cannot run against the real ` +
      'service and DID NOT RUN. It is not passing; it is absent. Start a throwaway ' +
      'Postgres and set the variable to exercise it.'
    );
  }
  const go = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (go.error) {
    return (
      'the Go toolchain is not on PATH, so cmd/bot-api-testbed cannot be built ' +
      'and the e2e DID NOT RUN'
    );
  }
  if (!fs.existsSync(BACKEND)) {
    return `${BACKEND} is missing, so the testbed cannot be built and the e2e DID NOT RUN`;
  }
  return null;
}

const REASON = skipReason();
if (REASON !== null) {
  process.stderr.write(`\nSKIPPING THE SDK END-TO-END SUITE: ${REASON}\n`);
}

// Loader/toolchain variables a parent environment may need to hand a spawned
// `process.execPath` child so the interpreter can start (mirrors the python
// suite's `bot_env` passthrough, hardened after CI-2026-09 broke on
// `actions/setup-python`'s shared-library build). None of these carry an
// event-allowlist or app secret, so passing them through does not reopen
// BA-R28/S14 — the base env stays a deliberately minimal, explicit object,
// never a copy of `process.env`.
const ENV_PASSTHROUGH = ['LD_LIBRARY_PATH'] as const;

function botEnv(base: Record<string, string>): Record<string, string> {
  const env = { ...base };
  for (const name of ENV_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

describe('botEnv', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/tmp/x', AURIVAL_API: 'http://127.0.0.1:0' };

  it('passes the loader path through when the parent has it', () => {
    const prior = process.env['LD_LIBRARY_PATH'];
    process.env['LD_LIBRARY_PATH'] = '/opt/tool-cache/node/x64/lib';
    try {
      expect(botEnv(base)['LD_LIBRARY_PATH']).toBe('/opt/tool-cache/node/x64/lib');
    } finally {
      if (prior === undefined) delete process.env['LD_LIBRARY_PATH'];
      else process.env['LD_LIBRARY_PATH'] = prior;
    }
  });

  it('omits the loader path when the parent has none', () => {
    const prior = process.env['LD_LIBRARY_PATH'];
    delete process.env['LD_LIBRARY_PATH'];
    try {
      expect('LD_LIBRARY_PATH' in botEnv(base)).toBe(false);
    } finally {
      if (prior !== undefined) process.env['LD_LIBRARY_PATH'] = prior;
    }
  });

  it('never leaks an event allowlist or app secret through the passthrough', () => {
    const prior = process.env['BOT_EVENT_CONVERSATIONS'];
    process.env['BOT_EVENT_CONVERSATIONS'] = 'chat_should_never_cross';
    try {
      const env = botEnv(base);
      expect('BOT_EVENT_CONVERSATIONS' in env).toBe(false);
      expect(env['AURIVAL_API']).toBe(base.AURIVAL_API);
    } finally {
      if (prior === undefined) delete process.env['BOT_EVENT_CONVERSATIONS'];
      else process.env['BOT_EVENT_CONVERSATIONS'] = prior;
    }
  });
});

interface Handshake {
  host: string;
  owner: string;
  bot: string;
  chat: string;
}

/** Drains a child's stdout for the whole session, so nothing is missed. */
class Transcript {
  readonly lines: string[] = [];
  #eof = false;
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    let buffer = '';
    const take = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      this.lines.push(...parts);
    };
    proc.stdout.on('data', take);
    proc.stderr.on('data', take);
    proc.stdout.on('close', () => {
      if (buffer) this.lines.push(buffer);
      this.#eof = true;
    });
  }
  get text(): string {
    return this.lines.join('\n');
  }
  get eof(): boolean {
    return this.#eof;
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null> | (T | null),
  message: string,
  timeoutMs = 90_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (exc) {
      last = exc;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${message} (last error: ${String(last)})`);
}

async function post(host: string, p: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(host + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as Record<string, unknown>;
}

async function get(host: string, p: string): Promise<Record<string, unknown>> {
  const resp = await fetch(host + p);
  return (await resp.json()) as Record<string, unknown>;
}

describe.skipIf(REASON !== null)('a real bot, through the real service', () => {
  let testbed: ChildProcessWithoutNullStreams;
  let handshake: Handshake;
  let workdir: string;
  let dist: string;
  const bots: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    // The e2e drives the BUILT package, exactly as a developer installing it would.
    const build = spawnSync('./node_modules/.bin/tsc', ['-p', 'tsconfig.build.json'], {
      cwd: SDK,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`building the SDK failed:\n${build.stderr}`);
    dist = path.join(SDK, 'dist', 'index.js');

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-e2e-'));
    const binary = path.join(workdir, 'bot-api-testbed');
    const goBuild = spawnSync('go', ['build', '-o', binary, './cmd/bot-api-testbed'], {
      cwd: BACKEND,
      encoding: 'utf8',
    });
    if (goBuild.status !== 0) throw new Error(`building the testbed failed:\n${goBuild.stderr}`);

    testbed = spawn(binary, [], {
      cwd: BACKEND,
      env: { ...process.env, AURIVAL_TESTBED_ADDR: '127.0.0.1:0' },
    }) as ChildProcessWithoutNullStreams;

    // The testbed prints one JSON line when it is serving. Reading it is how we
    // know the schema bootstrap finished — it takes a while on a fresh cluster.
    handshake = await new Promise<Handshake>((resolve, reject) => {
      let buf = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`no handshake:\n${stderr}`)), 120_000);
      testbed.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      testbed.stdout.on('data', (c: Buffer) => {
        buf += c.toString();
        for (const line of buf.split('\n')) {
          if (line.startsWith('{')) {
            clearTimeout(timer);
            resolve(JSON.parse(line) as Handshake);
            return;
          }
        }
      });
      testbed.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the testbed exited ${code} before serving:\n${stderr}`));
      });
    });
  }, 300_000);

  afterAll(() => {
    for (const b of bots) b.kill('SIGKILL');
    testbed?.kill('SIGTERM');
  });

  function spawnBot(dir: string): Transcript {
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'ping-bot.mjs');
    fs.writeFileSync(script, BOT_SOURCE(dist));
    const proc = spawn(process.execPath, [script], {
      cwd: dir,
      env: botEnv({
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: dir,
        AURIVAL_API: handshake.host,
      }),
    }) as ChildProcessWithoutNullStreams;
    bots.push(proc);
    return new Transcript(proc);
  }

  async function readCode(bot: Transcript): Promise<string> {
    return waitFor(
      () => {
        for (const line of bot.lines) {
          const m = CODE_RE.exec(line);
          if (m?.[1]) return m[1];
        }
        if (bot.eof) throw new Error(`the bot exited:\n${bot.text}`);
        return null;
      },
      'timed out waiting for the pairing code',
      90_000,
      100,
    );
  }

  it('answers /ping', async () => {
    const dir = path.join(workdir, 'run1');
    const bot = spawnBot(dir);
    const host = handshake.host;

    // 1. The code prints to STDOUT, not through the logger — a developer whose
    //    logger is at WARNING must still see it (SDK-31).
    const code = await readCode(bot);
    expect(code).toBeTruthy();

    // 2. The owner approves. In production this is a screen in the app behind the
    //    device lane; here it is the testbed standing in for it.
    expect(await post(host, '/__test/approve', { user_code: code })).toEqual({ approved: true });

    // 3. The key file lands where SDK-22 says, with the mode it says, and with a
    //    .gitignore beside it so it can never be committed by accident.
    const keyFile = path.join(dir, '.aurival', 'machine.json');
    await waitFor(() => fs.existsSync(keyFile) || null, 'the key file was never written');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyFile)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, '.aurival', '.gitignore'), 'utf8').trim()).toBe('*');
    const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as Record<string, string>;
    expect(Object.keys(saved).sort()).toEqual(['bot', 'created', 'host', 'machine', 'seed']);
    expect(saved['bot']).toBe(handshake.bot);

    // 4. Command sync landed, so the server routes /ping to this bot. `queued` is
    //    the honest signal: 0 means the emit fired nothing, and the invoke would
    //    otherwise look like an SDK failure.
    const invoke = await waitFor(async () => {
      const r = await post(host, '/__test/invoke', { chat: handshake.chat, text: '/ping' });
      return r['queued'] === 1 ? r : null;
    }, 'the invoke never queued an event — command sync did not land');
    expect(invoke['queued']).toBe(1);

    // 5. pong, read back out of the chat.
    const reply = await waitFor(async () => {
      const listing = await get(host, `/__test/messages?chat=${handshake.chat}`);
      const rows = listing['data'];
      if (!Array.isArray(rows)) return null;
      for (const row of rows as Array<Record<string, unknown>>) {
        if (row['text'] === 'pong' && row['sender'] !== `usr_${handshake.owner}`) return row;
      }
      return null;
    }, 'no pong arrived');
    expect(reply['text']).toBe('pong');

    // 6. And nothing in that whole transcript is a credential.
    expect(bot.text).not.toContain(saved['seed']);
    expect(bot.text).not.toContain('access_token');
  });

  // SDK-43. `init` is the first thing a developer runs, so the proof is that it
  // pairs through the real service and leaves a folder that already has a bot.
  it('aurival init pairs and scaffolds, and a second init refuses', async () => {
    const dir = path.join(workdir, 'init1');
    fs.mkdirSync(dir, { recursive: true });
    const cli = path.join(SDK, 'dist', 'cli.js');
    const env = botEnv({
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: dir,
      AURIVAL_API: handshake.host,
    });

    const proc = spawn(process.execPath, [cli, 'init'], {
      cwd: dir,
      env,
    }) as ChildProcessWithoutNullStreams;
    bots.push(proc);
    const transcript = new Transcript(proc);

    const code = await readCode(transcript);
    expect(await post(handshake.host, '/__test/approve', { user_code: code })).toEqual({
      approved: true,
    });

    const exitCode = await new Promise<number | null>((resolve) => proc.on('exit', resolve));
    expect(exitCode, transcript.text).toBe(0);

    // A folder with no tsconfig.json gets the file `node` runs as it stands.
    expect(fs.existsSync(path.join(dir, 'bot.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'bot.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'bot.js'), 'utf8')).toContain("ctx.reply('pong')");
    expect(fs.existsSync(path.join(dir, '.aurival', 'machine.json'))).toBe(true);
    expect(transcript.text).toContain('Next: node bot.js');

    const before = fs.readFileSync(path.join(dir, 'bot.js'), 'utf8');
    const second = spawnSync(process.execPath, [cli, 'init'], { cwd: dir, env, encoding: 'utf8' });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('bot.js already exists');
    expect(fs.readFileSync(path.join(dir, 'bot.js'), 'utf8')).toBe(before);
  }, 180_000);

  it('does not pair again on a second run', async () => {
    const dir = path.join(workdir, 'run2');
    const first = spawnBot(dir);
    const code = await readCode(first);
    await post(handshake.host, '/__test/approve', { user_code: code });
    const keyFile = path.join(dir, '.aurival', 'machine.json');
    await waitFor(() => fs.existsSync(keyFile) || null, 'the key file was never written');
    const saved = fs.readFileSync(keyFile, 'utf8');
    first.proc.kill('SIGTERM');

    const second = spawnBot(dir);
    await new Promise((r) => setTimeout(r, 15_000));
    expect(CODE_RE.test(second.text), `the second run paired again:\n${second.text}`).toBe(false);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(saved);
    second.proc.kill('SIGTERM');
  }, 120_000);
});
