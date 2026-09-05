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

This is the same package as [`aurival` on PyPI](../python), file for file and name for name.
Learn one and you have learned the other.

## Start from nothing

```
npm install aurival
npx aurival init
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
  ctx.message; // the id of the message that invoked you, or null
  await ctx.reply('…');
});
```

`ctx.reply()` quotes the message that invoked the command, so an answer never floats free
in a busy chat. There is no flag: on the rare event that carries no message id it sends a
plain message instead.

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

## Shadowed commands

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
aurival@0.1.0
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
