/**
 * BA-R68: the point of one context class per event family is that an editor
 * can tell a developer what `ctx` carries without them opening the docs.
 * That only holds if the compiler agrees with the runtime, so this runs a
 * sample bot through `tsc` against the real `src/`. It must (a) type-check
 * clean and (b) reject the one line the old flat `Context` let through —
 * reading `ctx.emoji` in a member handler — and a handler of the wrong
 * family, so a regression that widens the classes back into one is caught,
 * not only a regression that narrows them.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.resolve(here, '..', 'src', 'index.ts');
const tsc = path.resolve(here, '..', 'node_modules', 'typescript', 'bin', 'tsc');

const TYPED_SAMPLE = `
import {
  Bot,
  Button,
  Embed,
  type BotContext,
  type ButtonContext,
  type Context,
  type EventContext,
  type MemberContext,
  type Message,
  type ReactionContext,
  type User,
  mention,
} from ${JSON.stringify(src.replace(/\.ts$/, '.js'))};

const bot = new Bot();

bot.command(
  'ping',
  { description: 'pings', aliases: ['p'] },
  async (ctx: Context) => {
    const sender: User = ctx.sender;
    const invokedAs: string = ctx.invokedAs;
    const sent: Message = await ctx.reply('pong, ' + sender.name + ' via ' + invokedAs, {
      forUser: sender,
    });
    const edited: Message = await ctx.edit(sent, { text: 'pong, again', forUser: null });
    const forUser: string | null = edited.forUser;
    if (forUser !== null) await ctx.reply(forUser);
    await ctx.delete(edited);
    await ctx.react(ctx.message, '👍');
    await ctx.withTyping(async () => undefined);
  },
);

// Inferred: no annotation needed, the literal picks the class.
bot.on('member.joined', async (ctx) => {
  const who: User = ctx.user;
  const m = mention(who);
  await ctx.send(ctx.chat, 'welcome ' + m, { mentions: [m] });
});

bot.on('member.left', async (ctx: MemberContext) => {
  await ctx.reply(ctx.user.name + ' left');
});

bot.on('bot.added', async (ctx: BotContext) => {
  const actor: User = ctx.actor;
  await ctx.reply('thanks, ' + actor.name);
});

bot.on('reaction.added', async (ctx: ReactionContext) => {
  const emoji: string = ctx.emoji;
  const message: Message = ctx.message;
  await ctx.react(message, emoji);
});

bot.on('some.future.type', async (ctx: EventContext) => {
  if (ctx.user !== null) await ctx.reply(ctx.user.handle);
});

bot.on('button.pressed', async (ctx: ButtonContext) => {
  const pressed: User = ctx.user;
  const embed = new Embed({ title: 'ok' }).addField('who', pressed.name);
  const button = new Button({ label: 'Again' });
  await ctx.ack();
  await ctx.reply('thanks, ' + pressed.name, { embeds: [embed], buttons: [button] });
});

bot.onError(async (_error, ctx) => {
  if (ctx !== null) await ctx.reply('sorry');
});
`;

const MISTYPED_FIELD = `
bot.on('member.left', async (ctx) => {
  console.log(ctx.emoji);
});
`;

const MISTYPED_FAMILY = `
async function onlyBots(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.actor.name);
}
bot.on('member.joined', onlyBots);
`;

const MISTYPED_BUTTON_FAMILY = `
async function onlyReactions(ctx: ReactionContext): Promise<void> {
  await ctx.reply(ctx.emoji);
}
bot.on('button.pressed', onlyReactions);
`;

// AMENDMENT-09 §6.1/D20: ButtonContext deliberately has no `forUser` — the
// presser always IS the locked user, and there is no route to resolve a
// lock from a `button.pressed` event's bare message reference. Pinned here
// (compiled through the real project tsconfig, not the ad-hoc one `check()`
// builds) alongside the runtime pin in `forUser.test.ts`.
const MISTYPED_BUTTON_FORUSER = `
bot.on('button.pressed', async (ctx: ButtonContext) => {
  console.log(ctx.forUser);
});
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function check(source: string): { ok: boolean; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurival-typed-'));
  dirs.push(dir);
  const file = path.join(dir, 'bot.ts');
  fs.writeFileSync(file, source);
  // TS 7 refuses CLI flags beside a tsconfig it can see, so the sample gets
  // its own project file, with the SDK's own strictness.
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'nodenext',
        types: ['node'],
        typeRoots: [path.resolve(here, '..', 'node_modules', '@types')],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: [file],
    }),
  );
  try {
    execFileSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output: '' };
  } catch (exc) {
    const failed = exc as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

describe('the typed sample under tsc', () => {
  it('type-checks clean: each on() literal hands the handler its own context class', () => {
    const result = check(TYPED_SAMPLE);
    expect(result.ok, result.output).toBe(true);
  }, 60_000);

  it('rejects ctx.emoji in a member handler — the families have not collapsed back into one', () => {
    const result = check(TYPED_SAMPLE + MISTYPED_FIELD);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("'emoji'");
  }, 60_000);

  it('rejects a bot.* handler registered for a member.* type', () => {
    const result = check(TYPED_SAMPLE + MISTYPED_FAMILY);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/BotContext|MemberContext/);
  }, 60_000);

  it('rejects a ReactionContext handler registered for button.pressed', () => {
    const result = check(TYPED_SAMPLE + MISTYPED_BUTTON_FAMILY);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/ReactionContext|ButtonContext/);
  }, 60_000);

  it('rejects reading ctx.forUser on a ButtonContext (AMENDMENT-09 §6.1/D20 — pinned absence)', () => {
    const result = check(TYPED_SAMPLE + MISTYPED_BUTTON_FORUSER);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("'forUser'");
  }, 60_000);
});
