/**
 * `aurival init` (SDK-43). The half that needs a real service — pairing — is in
 * the e2e; everything here is the half that must hold with no network at all:
 * which file it writes, that it refuses to overwrite, and that a bad argv never
 * reaches the pairing lane.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { USAGE, main, starterFilename, starterSource } from '../src/cli.js';
import type { CliIO } from '../src/cli.js';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-cli-'));
}

function io(cwd: string): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd,
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    stdout,
    stderr,
  };
}

describe('starterFilename', () => {
  it('is bot.ts when the folder has a tsconfig.json', () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    expect(starterFilename(dir)).toBe('bot.ts');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is bot.js in a folder with no TypeScript', () => {
    const dir = scratch();
    expect(starterFilename(dir)).toBe('bot.js');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('starterSource', () => {
  it('is the README bot: one ping command that replies pong', () => {
    for (const name of ['bot.js', 'bot.ts']) {
      const source = starterSource(name);
      expect(source).toContain('import { Bot');
      expect(source).toContain("from 'aurival'");
      expect(source).toContain("bot.command('ping'");
      expect(source).toContain("ctx.reply('pong')");
      expect(source).toContain('bot.run()');
    }
  });

  it('types the handler only in the TypeScript flavour', () => {
    expect(starterSource('bot.ts')).toContain('ctx: Context');
    expect(starterSource('bot.js')).not.toContain('Context');
  });
});

describe('argv', () => {
  it('--help prints the usage and exits 0', async () => {
    const shell = io(scratch());
    expect(await main(['--help'], shell)).toBe(0);
    expect(shell.stdout.join('\n')).toBe(USAGE);
    fs.rmSync(shell.cwd, { recursive: true, force: true });
  });

  it('no command prints the usage and exits 2', async () => {
    const shell = io(scratch());
    expect(await main([], shell)).toBe(2);
    fs.rmSync(shell.cwd, { recursive: true, force: true });
  });

  it('an unknown command exits 2 and writes no file', async () => {
    const shell = io(scratch());
    expect(await main(['start'], shell)).toBe(2);
    expect(fs.readdirSync(shell.cwd)).toEqual([]);
    expect(shell.stderr.join('\n')).toContain('unknown command');
    fs.rmSync(shell.cwd, { recursive: true, force: true });
  });

  it('init takes no arguments', async () => {
    const shell = io(scratch());
    expect(await main(['init', '--force'], shell)).toBe(2);
    expect(fs.readdirSync(shell.cwd)).toEqual([]);
    fs.rmSync(shell.cwd, { recursive: true, force: true });
  });
});

describe('init refuses to overwrite', () => {
  // The refusal is checked BEFORE anything touches the network, so a second
  // init cannot cost a pairing trip and then say no. With no AURIVAL_API and no
  // service reachable, reaching the pairing lane at all would hang or throw —
  // returning 1 promptly is the proof it never got there.
  it('leaves an existing bot.js exactly as it was, without pairing', async () => {
    const dir = scratch();
    const target = path.join(dir, 'bot.js');
    fs.writeFileSync(target, '// mine\n');
    const shell = io(dir);

    const code = await main(['init'], shell);

    expect(code).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('// mine\n');
    expect(shell.stderr.join('\n')).toContain('bot.js already exists');
    expect(fs.existsSync(path.join(dir, '.aurival'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses on bot.ts in a TypeScript folder', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'bot.ts'), '// mine\n');
    const shell = io(dir);

    expect(await main(['init'], shell)).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'bot.ts'), 'utf8')).toBe('// mine\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
