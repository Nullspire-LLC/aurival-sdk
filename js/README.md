<p align="center">
  <a href="https://bots.aurival.com/docs"><img src="https://raw.githubusercontent.com/Nullspire-LLC/aurival-sdk/main/assets/aurival-banner.png" alt="Aurival" width="100%"></a>
</p>
<p align="center">Write a bot for Aurival. Declare commands, call <code>run()</code>, and the SDK holds the socket.</p>
<p align="center">
  <a href="https://pypi.org/project/aurival/"><img src="https://img.shields.io/pypi/v/aurival.svg" alt="PyPI version"></a>
  <a href="https://www.npmjs.com/package/aurival"><img src="https://img.shields.io/npm/v/aurival.svg" alt="npm version"></a>
  <a href="https://github.com/Nullspire-LLC/aurival-sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

```ts
import { Bot } from 'aurival';

const bot = new Bot();

bot.command('ping', 'Check that the bot is alive', async (ctx) => {
  await ctx.reply('pong');
});

bot.run();
```

Node 22+. ESM. TypeScript source, shipping plain JS plus `.d.ts`, so you get types whether
or not you use TypeScript.

Node 22.0–22.10 print `[UNDICI-WS] Warning: WebSockets are experimental` on every start —
that line is expected, comes from Node's own `WebSocket` implementation, and does not mean
anything is wrong. Node 22.11+ is silent. The floor stays 22.

This is the same package as [`aurival` on PyPI](https://pypi.org/project/aurival/), file for file and name for name.
Learn one and you have learned the other.

## Start from nothing

```bash
npm install aurival
```

```bash
npx aurival init
```

```bash
node bot.js
```

`init` pairs this machine and writes a starter bot that already answers `/ping`. It writes
`bot.ts` when the folder already has TypeScript (a `tsconfig.json`), `bot.js` otherwise, so
the file it names is one you can run as it stands. It never overwrites an existing bot
file, and it refuses before it pairs rather than after.

`init` is a convenience, not a requirement: `bot.run()` still pairs on its first run.

## First run

There is nothing to configure. The first `run()` pairs this machine:

```
aurival: pairing code    K7QP-2M4X
aurival: fingerprint     018R-6WAC
Compare the fingerprint in the app, then approve. Waiting...
```

Compare the fingerprint in the app before you approve — it is what makes a stolen code
useless. The key lands in `./.aurival/machine.json` (mode `0600`, in a `0700` directory,
with a `.gitignore` beside it so it can never be committed). Every later run just starts.

The key deploys with the project, like a `.env`. Each bot has its own. A leaked key is one
machine you revoke; a leaked token would be the bot.

## What a handler gets

```ts
bot.command('say', async (ctx) => {
  ctx.command; // "say"
  ctx.arguments; // the raw rest of the line, unparsed, possibly ""
  ctx.chat; // { id, type, name }
  ctx.sender; // { id, handle, name }
  ctx.message.text; // "/say hi" — the invoking message, verbatim
  await ctx.reply('…');
});
```

`ctx.message` is now the invoking message itself: `ctx.message.id`, `.text`, `.sent_at`, `.sender`, and `.reply_to` (the id of the message it quoted, or `null`) — or, for an event that carries none, `ctx.message` itself is `null` and none of those fields are reachable. `ctx.reply()` still quotes it by id, so an answer never floats free in a busy chat. There is no flag: on the rare event that carries no message id it sends a plain message instead.

Handlers run concurrently, and an event is acked only after its handler settles — so a
crash mid-handler redelivers rather than loses. **Do not block inside a handler.** A
synchronous call (a busy loop, `execSync`, a long CPU pass) starves the heartbeat on the
same event loop, and the server reaps a socket that has gone quiet for three intervals.
Use `await`, or hand the work to a worker thread.

An exception in a handler is logged with its stack, the bot stays up, and the event is
still acked:

```ts
bot.onError((error, ctx) => {
  // ctx is null for anything that did not come from a handler
});
```

The hook also sees the two things that are not a handler's fault: a `problem` frame from
the server (your socket stays open), and a `backlog.overflowed` event telling you how many
events you missed while you were away and where delivery resumed. Neither reaches a
command handler.

## Other events

`bot.command()` is for `/slash` invocations. Everything else the server can tell you about
goes through `bot.on(type, fn)`:

```ts
bot.on('member.joined', async (ctx) => {
  await ctx.send(ctx.chat.id, `welcome, ${ctx.user?.handle}`);
});

bot.on('member.left', async (ctx) => {
  console.log(ctx.user?.handle, 'left', ctx.chat.id);
});

bot.on('bot.added', async (ctx) => {
  await ctx.send(ctx.chat.id, `thanks for adding me, ${ctx.actor?.handle}`);
});

bot.on('bot.removed', async (ctx) => {
  console.log(ctx.actor?.handle, 'removed me from', ctx.chat.id);
});

bot.on('reaction.added', async (ctx) => {
  console.log(ctx.sender?.handle, 'reacted', ctx.emoji, 'on', ctx.message?.id);
});
```

One `Context` for every event type. Only the fields that event actually carries are
populated — everything else is `null`:

| event             | `ctx.chat` | `ctx.sender` | `ctx.user` | `ctx.actor` | `ctx.message` | `ctx.emoji` |
| ----------------- | ---------- | ------------ | ---------- | ----------- | ------------- | ----------- |
| `command.invoked` | ✓          | ✓            |            |             | ✓             |             |
| `member.joined`   | ✓          |              | ✓          |             |               |             |
| `member.left`     | ✓          |              | ✓          |             |               |             |
| `bot.added`       | ✓          |              |            | ✓           |               |             |
| `bot.removed`     | ✓          |              |            | ✓           |               |             |
| `reaction.added`  | ✓          | ✓            |            |             | ✓             | ✓           |

An event type this SDK does not know about yet is never fatal — `bot.on()` a type the
server hasn't invented yet and, if it starts sending it, the handler runs with whatever
fields it happens to carry. There is no `reaction.removed` event: un-reacting is silent.

## Actions

Every action is available on a handler's `ctx`. `ctx.chat.member_count` carries the chat's
live participant count, so you don't need a separate call to know how many people are in it:

The typing indicator is also automatic (0.2.1): a command handler still running 300 ms after
it started shows the chat "is thinking", and the indicator clears when the handler returns,
including on a throw. A handler that replies inside those 300 ms sends nothing, so a fast bot
never flickers. `new Bot({ autoTyping: false })` turns it off if you would rather drive
`ctx.withTyping()` yourself.

```ts
bot.command('busy', async (ctx) => {
  await ctx.withTyping(async () => {
    // ... slow work, e.g. calling out to another service ...
    await ctx.reply(`done, and there are ${ctx.chat.member_count} of us in here`);
  });
});

bot.command('fix', async (ctx) => {
  const sent = await ctx.reply('working on it...');
  await ctx.edit(String(sent['id']), 'done!');
});

bot.command('oops', async (ctx) => {
  if (ctx.message) await ctx.delete(ctx.message);
});

bot.command('upvote', async (ctx) => {
  if (ctx.message) await ctx.react(ctx.message, '\u{1F44D}');
});

bot.command('downvote', async (ctx) => {
  if (ctx.message) await ctx.unreact(ctx.message, '\u{1F44D}');
});

bot.command('roster', async (ctx) => {
  // One page per call — never auto-loads the rest. Loop on `hasMore`, never
  // on whether `nextCursor` looks truthy: `hasMore` is the explicit signal
  // (CONTRACT-V1 §4), and inferring "more pages" from the cursor is exactly
  // the off-by-one every other SDK ships.
  const handles: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.members(undefined, { cursor });
    handles.push(...page.users.map((u) => u.handle));
    if (!page.hasMore) break;
    cursor = page.nextCursor ?? undefined;
  }
  await ctx.reply(handles.join(', '));
});
```

`ctx.typing(true | false)` and `ctx.withTyping(fn)` toggle the typing indicator — `withTyping`
sends `true` on entry and `false` on exit, always, even if `fn` throws.

`@`-mention someone with `mention(user)` — it template-literals straight into `text` as
`@handle`, and carries the id the server needs in `mentions`:

```ts
import { mention } from 'aurival';

bot.command('thanks', async (ctx) => {
  if (!ctx.sender) return; // no sender on this event type — nothing to thank
  await ctx.send(ctx.chat, `thanks, ${mention(ctx.sender)}!`, {
    mentions: [mention(ctx.sender)],
  });
});
```

> **0.2.0 breaking change:** `ctx.sender` is now `User | null` (was `User`). The single
> `Context` class is shared across every event type, and `sender` is genuinely absent on
> `member.joined`/`member.left`/`bot.added`/`bot.removed` (see the table above) — so it can
> no longer be typed as always-present. Narrow it before use:
>
> ```ts
> // 0.1.x — ctx.sender.handle compiled unconditionally.
> console.log(ctx.sender.handle);
>
> // 0.2.0 — narrow first (an early return, as in the `thanks` example above,
> // or an `if (ctx.sender)` guard around the rest of the handler).
> if (!ctx.sender) return;
> console.log(ctx.sender.handle);
> ```

## Shadowed commands

A bot can declare up to 50 commands, the SDK refuses to connect past that.

Every `run()` syncs your command list, and the server answers with the chats where another
bot already holds one of your names. Yours never fires there. The SDK prints one warning
line per shadowed chat:

```
aurival warn: /ping is shadowed by another bot in chat_01j…, so it will not reach you there
```

Rename the command, or get the other bot out of that chat. Nothing else in the SDK reacts
to it — a shadowed command in one chat is still live in every other.

## Environment

| variable           | what it does                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AURIVAL_API`      | point at another host. Must be `https://` unless it is loopback. The SDK prints the host it is using, so a redirect is visible.                           |
| `AURIVAL_KEY_PATH` | put `machine.json` somewhere else. No `.gitignore` is written beside an override — that is your directory, not ours.                                      |
| `AURIVAL_DEBUG`    | Node has no stdlib logger, so the default one mirrors an unconfigured Python `logging`: warnings and errors to stderr, debug and info only with this set. |

## Errors

One class per error type, one subclass per code the SDK acts on, and `code` and `doc_url`
on every instance:

```ts
import { RateLimitError, KeyRevoked } from 'aurival';

try {
  await ctx.reply('…');
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(error.code, error.retry_after, error.doc_url);
  }
}
```

A `rate_limited` reply is retried for you, up to five attempts, as long as `retry_after` is
15 seconds or less. Past that (0.2.1) the error is thrown at once instead of slept through:
a handler that sleeps for minutes holds its event unacknowledged for the whole wait, and the
server redelivers behind it.

`KeyRevoked`, `SessionSuperseded` and `BotSuspended` end the process on purpose — each one
means something a reconnect cannot fix. Everything else the SDK handles for you: token
expiry, deploys, network faults, redelivery.

`KeyRevoked` names the file to remove, since pairing again is the only way back:

```
KeyRevoked: The key on this machine was revoked. Generate a new keypair and pair the
machine again — a revoked key cannot be re-paired. Remove .aurival/machine.json and run
the bot again to pair a new key.
```

## Dependencies

**None.** `fetch`, `WebSocket` and Ed25519 signing are all built into Node 22, which is why
the floor is 22 rather than 20 — Node 20 has no unflagged `WebSocket` client, and "Node 20"
and "zero runtime dependencies" could not both be true.

```
$ npm ls --omit=dev
aurival@0.2.0
└── (empty)
```

Development only, and each earns its place:

| package                                                    | version   | why                                                                                                                                                           |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`typescript`](https://www.npmjs.com/package/typescript)   | `7.0.2`   | The source is TypeScript; this compiles it to the plain JS and `.d.ts` the package ships.                                                                     |
| [`vitest`](https://www.npmjs.com/package/vitest)           | `5.0.0`   | The test runner. Runs TypeScript directly, so the suite tests the source rather than a build artefact.                                                        |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | `22.20.1` | Types for the built-ins the package leans on. Pinned to the **22** line on purpose: a later major would type APIs Node 22 does not have, and the floor is 22. |
| [`prettier`](https://www.npmjs.com/package/prettier)       | `3.9.6`   | Formatting, so a diff is about the change.                                                                                                                    |

Every version was resolved from npm at build time (2026-09-05) with `npm view <pkg> version`
and pinned exactly. None came from memory.

`vitest` itself wants Node `>=22.12`; the package's own floor stays Node 22.0 (SDK-20). Run
the suite on a 22.12+ (or newer) Node. `package.json`'s `devEngines` warns rather than
fails on an older Node, since the runtime floor and the dev-toolchain floor are not the
same number.

## Tests

```
npm test
```

The end-to-end test runs a real bot against the real Go service through
`backend-go/cmd/bot-api-testbed`, which needs a throwaway Postgres:

```
MIGRATE_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' npm test
```

**Without that variable the end-to-end test announces that it skipped.** It never passes
quietly — a suite reporting green when it never reached the service is worse than no suite.

## License

Apache-2.0, see [LICENSE](LICENSE). The Aurival name, wordmark, and mascot are trademarks of Nullspire LLC and are not covered by the license, see [NOTICE](NOTICE).
