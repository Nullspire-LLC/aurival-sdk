<p align="center">
  <a href="https://bots.aurival.com/docs"><img src="https://raw.githubusercontent.com/Nullspire-LLC/aurival-sdk/main/assets/aurival-banner.png" alt="Aurival" width="100%"></a>
</p>
<p align="center">Write a bot for Aurival. Declare commands, call <code>run()</code>, and the SDK holds the socket.</p>
<p align="center">
  <a href="https://pypi.org/project/aurival/"><img src="https://img.shields.io/pypi/v/aurival.svg" alt="PyPI version"></a>
  <a href="https://www.npmjs.com/package/aurival"><img src="https://img.shields.io/npm/v/aurival.svg" alt="npm version"></a>
  <a href="https://github.com/Nullspire-LLC/aurival-sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

```python
from aurival import Bot

bot = Bot()

@bot.command("ping", "Check that the bot is alive")
async def ping(ctx):
    await ctx.reply("pong")

bot.run()
```

Python 3.10+.

A bot can declare up to 50 commands, the SDK refuses to connect past that.

## Getting started

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install aurival
aurival init
```

The venv line matters on current Debian, Ubuntu and Fedora, whose system Python refuses
`pip install` outside a virtual environment (PEP 668). `aurival init` pairs this machine and
writes the `bot.py` above for you. Run `python bot.py` when it's done.

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

```python
@bot.command("say")
async def say(ctx):
    ctx.command    # "say"
    ctx.arguments  # the raw rest of the line, unparsed, possibly ""
    ctx.chat       # Chat(id, type, name)
    ctx.sender     # User(id, handle, name)
    await ctx.reply("…")
```

`ctx.message` is the id of the message that invoked the command, or `None` for an event
that carries none. `ctx.reply()` quotes that message by default, so an answer never floats
free in a busy chat — there is no flag; on the rare event with no message id it sends a
plain message instead.

Handlers run concurrently, and an event is acked only after its handler returns — so a
crash mid-handler redelivers rather than loses. **Do not block inside a handler.** A
synchronous call (`requests.get`, `time.sleep`, a busy loop) starves the heartbeat on the
same event loop, and the server reaps a socket that has gone quiet for three intervals.
Use `await`, or hand the work to a thread.

An exception in a handler is logged with its traceback, the bot stays up, and the event is
still acked:

```python
@bot.on_error
async def on_error(error, ctx):
    ...   # ctx is None for anything that did not come from a handler
```

The hook also sees the two things that are not a handler's fault: a `problem`
frame from the server (your socket stays open), and a `backlog.overflowed` event
telling you how many events you missed while you were away and where delivery
resumed. Neither reaches a command handler.

## Shadowed commands

Every `run()` syncs your command list, and the server answers with the chats where another
bot already holds one of your names. Yours never fires there. The SDK logs one warning
line per shadowed chat, through the standard `aurival` logger:

```
WARNING:aurival:command 'ping' is shadowed in chat chat_01j… by another bot's command with the same name, and will never fire there
```

Rename the command, or get the other bot out of that chat. Nothing else in the SDK reacts
to it — a shadowed command in one chat is still live in every other.

## Environment

| variable | what it does |
|---|---|
| `AURIVAL_API` | point at another host. Must be `https://` unless it is loopback. The SDK prints the host it is using, so a redirect is visible. |
| `AURIVAL_KEY_PATH` | put `machine.json` somewhere else. No `.gitignore` is written beside an override — that is your directory, not ours. |

## Errors

One class per error type, one subclass per code the SDK acts on, and `code` and `doc_url`
on every instance:

```python
from aurival import RateLimitError, KeyRevoked

try:
    await ctx.reply("…")
except RateLimitError as exc:
    print(exc.code, exc.retry_after, exc.doc_url)
```

`KeyRevoked`, `SessionSuperseded` and `BotSuspended` end the process on purpose — each one
means something a reconnect cannot fix. Everything else the SDK handles for you:
token expiry, deploys, network faults, redelivery.

## Dependencies

Two, and each is here for a reason:

| package | version | why |
|---|---|---|
| [`aiohttp`](https://pypi.org/project/aiohttp/) | `3.14.3` | HTTP **and** the websocket, one library doing both. Two libraries where one would do is a dependency we would be choosing. |
| [`cryptography`](https://pypi.org/project/cryptography/) | `50.0.1` | Ed25519 signing. PyCA-maintained with prebuilt wheels and first-class Ed25519 — hand-rolling it would be a security review we do not want to own. |

Development only: `pytest 9.1.1`, `pytest-asyncio 1.4.0`, `ruff 0.16.6`, `setuptools 84.0.0`.

Every version was resolved from PyPI at build time (2026-09-05) and pinned. None came from
memory.

## Tests

```
pytest tests
```

The end-to-end test runs a real bot against the real Go service through
`backend-go/cmd/bot-api-testbed`, which needs a throwaway Postgres:

```
MIGRATE_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' \
  pytest tests
```

**Without that variable the end-to-end test announces that it skipped.** It never passes
quietly — a suite reporting green when it never reached the service is worse than no suite.

## License

Apache-2.0, see [LICENSE](LICENSE). The Aurival name, wordmark, and mascot are trademarks of Nullspire LLC and are not covered by the license, see [NOTICE](NOTICE).
