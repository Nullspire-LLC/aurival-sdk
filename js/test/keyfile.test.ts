/**
 * Tests for `KeyFile` — mode, atomicity, and the `.gitignore` rule (SDK-22).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// `node:fs/promises` is a frozen ESM namespace, so `rename` can't be
// `vi.spyOn`'d directly (mirrors the `node:os` workaround in auth.test.ts).
// Wrapping it in `vi.fn` lets the crash-mid-write test fail exactly the atomic
// step — after the tmp file is written, before it replaces the real path —
// which is the step a non-atomic ("write straight to `this.path`") save would
// skip entirely, making that mutation pass this test vacuously if the crash
// were injected any earlier.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { KeyFile, MachineKey, type Machine } from '../src/auth.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aurival-keyfile-'));
}

async function perm(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

function fixtureMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    bot: 'bot_a',
    machine: 'machine_b',
    host: 'https://x',
    created: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('KeyFile path resolution', () => {
  const ORIGINAL_ENV = process.env['AURIVAL_KEY_PATH'];
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env['AURIVAL_KEY_PATH'];
    else process.env['AURIVAL_KEY_PATH'] = ORIGINAL_ENV;
  });

  it('default path is .aurival/machine.json', () => {
    expect(KeyFile.defaultPath()).toBe(path.join('.aurival', 'machine.json'));
  });

  it('no path, no env: uses the default and isDefault is true', () => {
    delete process.env['AURIVAL_KEY_PATH'];
    const kf = new KeyFile();
    expect(kf.path).toBe(KeyFile.defaultPath());
    expect(kf.isDefault).toBe(true);
  });

  it('env override sets path and clears isDefault', async () => {
    const dir = await mkTmpDir();
    const override = path.join(dir, 'elsewhere', 'creds.json');
    process.env['AURIVAL_KEY_PATH'] = override;
    const kf = new KeyFile();
    expect(kf.path).toBe(override);
    expect(kf.isDefault).toBe(false);
  });

  it('explicit constructor path clears isDefault', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'custom.json'));
    expect(kf.isDefault).toBe(false);
  });
});

describe('KeyFile save/load', () => {
  it('writes a 0600 file inside a 0700 directory', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, '.aurival', 'machine.json'));
    const key = MachineKey.generate();
    await kf.save(key, fixtureMachine());
    expect(await perm(kf.path)).toBe(0o600);
    expect(await perm(path.dirname(kf.path))).toBe(0o700);
  });

  it('save then load round-trips key and machine', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'machine.json'));
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await kf.save(key, machine);

    const loaded = await kf.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.machine).toEqual(machine);
    expect(loaded?.key.publicKeyB64).toBe(key.publicKeyB64);
    expect(loaded?.key.fingerprint).toBe(key.fingerprint);
  });

  it('load on a missing file returns null', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'nope.json'));
    expect(await kf.load()).toBeNull();
  });

  it('save is atomic: no stray .tmp files on success', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'machine.json'));
    await kf.save(MachineKey.generate(), fixtureMachine());
    const leftovers = (await fs.readdir(dir)).filter(
      (f) => f.startsWith('.machine-') && f.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('a crash mid-write leaves the old file intact and no tmp file behind', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'machine.json'));
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await kf.save(key, machine);
    const originalBytes = await fs.readFile(kf.path);

    vi.mocked(fs.rename).mockImplementationOnce(() => {
      throw new Error('simulated crash mid-write');
    });
    await expect(kf.save(MachineKey.generate(), fixtureMachine({ bot: 'bot_c' }))).rejects.toThrow(
      'simulated crash mid-write',
    );

    expect(await fs.readFile(kf.path)).toEqual(originalBytes);
    const leftovers = (await fs.readdir(dir)).filter(
      (f) => f.startsWith('.machine-') && f.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('writes .gitignore only at the default path', async () => {
    const dir = await mkTmpDir();
    const cwd = process.cwd();
    process.chdir(dir);
    delete process.env['AURIVAL_KEY_PATH'];
    try {
      const kf = new KeyFile(); // default path, relative to cwd
      await kf.save(MachineKey.generate(), fixtureMachine());
      const gitignore = path.join(dir, '.aurival', '.gitignore');
      const contents = await fs.readFile(gitignore, 'utf8');
      expect(contents).toBe('*\n');
    } finally {
      process.chdir(cwd);
    }
  });

  it('does not write .gitignore beside an env override path', async () => {
    const dir = await mkTmpDir();
    const overrideDir = path.join(dir, 'custom-creds');
    process.env['AURIVAL_KEY_PATH'] = path.join(overrideDir, 'machine.json');
    try {
      const kf = new KeyFile();
      await kf.save(MachineKey.generate(), fixtureMachine());
      await expect(fs.access(path.join(overrideDir, '.gitignore'))).rejects.toThrow();
    } finally {
      delete process.env['AURIVAL_KEY_PATH'];
    }
  });

  it('load never exposes the seed on the returned objects', async () => {
    const dir = await mkTmpDir();
    const kf = new KeyFile(path.join(dir, 'machine.json'));
    const key = MachineKey.generate();
    const machine = fixtureMachine();
    await kf.save(key, machine);
    const onDisk = JSON.parse(await fs.readFile(kf.path, 'utf8')) as { seed: string };

    const loaded = await kf.load();
    expect(loaded).not.toBeNull();
    expect(Object.values(loaded?.machine ?? {})).not.toContain(onDisk.seed);
    // `MachineKey`'s only field is a `#`-private KeyObject: no own enumerable
    // property survives to be inspected, seed or otherwise.
    expect(Object.keys(loaded?.key ?? {})).toEqual([]);
    expect((loaded?.key as unknown as Record<string, unknown>)['seed']).toBeUndefined();
    expect((loaded?.key as unknown as Record<string, unknown>)['_seed']).toBeUndefined();
  });
});
