#!/usr/bin/env node
/**
 * `aurival init` (SDK-43): from an empty folder to a running bot in one command.
 *
 * One subcommand and `--help`, nothing else. The pairing printout is `run()`'s
 * own, through `ensurePaired`, so the code and fingerprint a developer compares
 * in the app are the same lines either way.
 */

import { existsSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KeyFile, resolveHost } from './auth.js';
import { ensurePaired } from './bot.js';
import { HttpClient, defaultLogger } from './http.js';

export const USAGE = `aurival — write a bot for Aurival

usage:
  aurival init     pair this machine and write a starter bot in this folder
  aurival --help   this

init writes bot.ts when the folder already has TypeScript (a tsconfig.json),
and bot.js otherwise, so the file it names is one you can actually run. It
never overwrites an existing bot file.
`;

/**
 * The one rule, stated so it can be applied: TypeScript if the folder already
 * has a tsconfig.json, plain JS otherwise. A folder with no TS toolchain gets a
 * file `node` runs as it stands — a `bot.ts` there would be a scaffold whose
 * printed next step does not work.
 */
export function starterFilename(dir: string): 'bot.ts' | 'bot.js' {
  return existsSync(path.join(dir, 'tsconfig.json')) ? 'bot.ts' : 'bot.js';
}

/** The README's bot, verbatim in behaviour: declare /ping, answer pong. */
export function starterSource(filename: string): string {
  const imports = filename.endsWith('.ts')
    ? "import { Bot, type Context } from 'aurival';"
    : "import { Bot } from 'aurival';";
  const ctx = filename.endsWith('.ts') ? '(ctx: Context)' : '(ctx)';
  return `${imports}

const bot = new Bot();

bot.command('ping', 'Check that the bot is alive', async ${ctx} => {
  await ctx.reply('pong');
});

bot.run();
`;
}

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  };
}

/** Returns the process exit code. Never calls `process.exit` itself. */
export async function main(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== 'init') {
    io.err(`aurival: unknown command ${JSON.stringify(command)}\n`);
    io.err(USAGE);
    return 2;
  }
  if (rest.length > 0) {
    io.err(`aurival: init takes no arguments, got ${JSON.stringify(rest.join(' '))}`);
    return 2;
  }
  return init(io);
}

export async function init(io: CliIO): Promise<number> {
  const filename = starterFilename(io.cwd);
  const target = path.join(io.cwd, filename);

  // Checked BEFORE pairing on purpose: pairing costs the developer a trip to
  // their phone, and burning one to then refuse would be rude.
  if (existsSync(target)) {
    io.err(`aurival: ${filename} already exists here, so init has nothing to do.`);
    io.err('Delete it first, or run init in an empty folder.');
    return 1;
  }

  const host = resolveHost();
  const log = defaultLogger();
  const keyFile = new KeyFile(null);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const { paired } = await ensurePaired(
      new HttpClient(host, null, log),
      keyFile,
      host,
      log,
      controller.signal,
    );
    if (!paired) io.out(`aurival: this machine is already paired (${keyFile.path}).`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }

  // 'wx': if something raced us to the name between the check above and here,
  // we still refuse rather than overwrite.
  await fs.writeFile(target, starterSource(filename), { encoding: 'utf8', flag: 'wx' });

  // The TS line names a runner we cannot promise is installed: a tsconfig.json
  // says the folder is TypeScript, not that `tsx` is there. Hedged rather than
  // stated, so the one next step is never a command that just fails.
  io.out(
    filename === 'bot.ts'
      ? `Wrote ${filename}. Next: run it with your TypeScript runner, for example npx tsx ${filename}`
      : `Wrote ${filename}. Next: node ${filename}`,
  );
  return 0;
}

// Only when this file is the entry point, so importing it in a test is inert.
// Through realpath and pathToFileURL because npm installs a bin as a SYMLINK in
// node_modules/.bin, and a raw string compare misses that by exactly one hop —
// `npx aurival init` would then print nothing and exit 0.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (exc: unknown) => {
      process.stderr.write(`aurival: ${exc instanceof Error ? exc.message : String(exc)}\n`);
      process.exitCode = 1;
    },
  );
}
