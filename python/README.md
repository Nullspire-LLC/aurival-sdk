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
from aurival import Bot, Context

bot = Bot()

@bot.command("ping", "Check that the bot is alive")
async def ping(ctx: Context):
    await ctx.reply("pong")

bot.run()
```

Python 3.10+.

A bot can declare up to 50 commands, the SDK refuses to connect past that.

## Getting started

Create a virtual environment.

```bash
python3 -m venv .venv
```

Activate it.

```bash
. .venv/bin/activate
```

The venv matters on current Debian, Ubuntu and Fedora, whose system Python refuses
`pip install` outside a virtual environment (PEP 668).

Install the SDK.

```bash
pip install aurival
```

Scaffold a starter bot.

```bash
aurival init
```

`aurival init` pairs this machine and writes the `bot.py` above for you. Run `python bot.py`
when it's done.

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
async def say(ctx: Context):
    ctx.command    # "say"
    ctx.arguments  # the raw rest of the line, unparsed, possibly ""
    ctx.chat       # Chat(id, type, name)
    ctx.sender     # User(id, handle, name) — always set for command.invoked, but see below
    ctx.message.text  # "/say hi" — the invoking message, verbatim
    await ctx.reply("…")
```

`ctx.message` now arrives in full: a `Message` with `ctx.message.id`, `.text`, `.sent_at`, `.sender`, and `.reply_to` (the id of the message it quoted, or `None`) — or, for an event that carries none, `ctx.message.id` and the rest are unreachable because `ctx.message` itself is `None`. `ctx.reply()` still quotes it by id by default, so an answer never floats free in a busy chat — there is no flag; on the rare event with no message id it sends a plain message instead.

### Breaking change in 0.2.0: `ctx.sender` is now optional

`ctx.sender` is `User | None`, not `User`. `Context` is one class for every event type
(0.2.0 added `member.*`, `bot.*`, `reaction.added` alongside `command.invoked` — see
[Events beyond commands](#events-beyond-commands)), and `member.joined`/`member.left` and
`bot.added`/`bot.removed` genuinely have no sender — they carry `ctx.user` or `ctx.actor`
instead. `command.invoked` still always populates it, but the type has to admit the honest
case, so a caller in a `py.typed`/mypy-strict codebase needs to narrow it before touching
`.handle` or `.id`:

```python
if ctx.sender is not None:
    print(ctx.sender.handle)
```

inside a `@bot.command` handler this is always true in practice, but the type checker has
no way to know that from `Context` alone.

Handlers run concurrently, and an event is acked only after its handler returns — so a
crash mid-handler redelivers rather than loses. **Do not block inside a handler.** A
synchronous call (`requests.get`, `time.sleep`, a busy loop) starves the heartbeat on the
same event loop, and the server reaps a socket that has gone quiet for three intervals.
Use `await`, or hand the work to a thread.

An exception in a handler is logged with its traceback, the bot stays up, and the event is
still acked:

```python
@bot.on_error
async def on_error(error, ctx: Context | None):
    ...   # ctx is None for anything that did not come from a handler
```

## Events beyond commands

`@bot.command` is for `command.invoked`. Everything else — membership changes, your bot
being added or removed, a reaction landing on one of its messages — goes through
`@bot.on(event_type)`, a decorator or a direct call, either registering another handler for
that type:

```python
@bot.on("member.joined")
async def welcome(ctx: Context):
    if ctx.user is not None:
        await ctx.send(ctx.chat, f"welcome, {ctx.user.name}!")

@bot.on("member.left")
async def farewell(ctx: Context):
    ...

@bot.on("bot.added")
async def added(ctx: Context):
    ...   # ctx.actor is who added it

@bot.on("bot.removed")
async def removed(ctx: Context):
    ...

@bot.on("reaction.added")
async def liked(ctx: Context):
    ...   # ctx.emoji, ctx.message, ctx.sender — no reaction.removed exists; un-reacting is silent


def sync_registration(bot: Bot) -> None:
    async def joined(ctx: Context) -> None:
        ...

    bot.on("member.joined", joined)  # the non-decorator form
```

One `Context` for every event type — which attributes are populated depends on which event
it is, and an attribute the current event doesn't carry is `None`, never a missing
attribute:

| event | populated |
|---|---|
| `command.invoked` | `command`, `arguments`, `chat`, `sender`, `message` |
| `member.joined` / `member.left` | `chat`, `user` |
| `bot.added` / `bot.removed` | `chat`, `actor` |
| `reaction.added` | `chat`, `sender`, `message` (id only), `emoji` |

An event type this SDK doesn't recognize yet still builds a `Context`, never an exception —
a bot must keep running against a server that has shipped an eighth type — and populates it
opportunistically from whatever the payload recognizably carries under the same keys above
(`sender`, `user`, `actor`, `message`, `emoji`); "ignored, not fatal" means you get what's
there, not nothing. `ctx.chat.member_count` is the chat's live participant count (bots
included), an `int`, or `None` when the event's frame didn't carry one.

## Actions

Six more things a handler can do, beyond `ctx.reply()`:

```python
async with ctx.typing():
    ...   # sends is_typing:true on enter, is_typing:false on exit, even on exception

await ctx.edit(ctx.message, "corrected text")
await ctx.delete(ctx.message)
await ctx.react(ctx.message, "👍")
await ctx.unreact(ctx.message, "👍")

page = await ctx.members()   # defaults to ctx.chat
if page.has_more:            # never inferred from a short page or a cursor alone
    more = await ctx.members(cursor=page.next_cursor)  # one page at a time — never auto-loads
```

The typing indicator is also automatic (0.2.1): a command handler still running 300 ms after
it started shows the chat "is thinking", and the indicator clears when the handler returns,
including on an exception. A handler that replies inside those 300 ms sends nothing, so a fast
bot never flickers. `Bot(auto_typing=False)` turns it off if you would rather drive
`ctx.typing()` yourself.

`ctx.send(chat, text, mentions=...)` posts to any chat, not only the one that triggered the
handler, and mentions a user by writing `@` + their handle into `text` yourself — `mention()`
builds that token for you:

```python
from aurival import mention

target = ctx.user  # or any User you already have
await ctx.send(ctx.chat, f"hey {mention(target)}, welcome!", mentions=[mention(target)])
```

`mentions` also takes a bare `User` or `{"user": "usr_…"}` directly — `mention()` exists for
the token, not because the other forms are wrong. Every entry in `mentions` needs its
`@handle` token actually present in `text`, or the server rejects the request.

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

A `rate_limited` reply is retried for you, up to five attempts, as long as `retry_after` is
15 seconds or less. Past that (0.2.1) the error is raised at once instead of slept through:
a handler that sleeps for minutes holds its event unacknowledged for the whole wait, and the
server redelivers behind it.

`KeyRevoked`, `SessionSuperseded` and `BotSuspended` end the process on purpose — each one
means something a reconnect cannot fix. Everything else the SDK handles for you:
token expiry, deploys, network faults, redelivery.

## Dependencies

Two, and each is here for a reason:

| package | version | why |
|---|---|---|
| [`aiohttp`](https://pypi.org/project/aiohttp/) | `3.14.3` | HTTP **and** the websocket, one library doing both. Two libraries where one would do is a dependency we would be choosing. |
| [`cryptography`](https://pypi.org/project/cryptography/) | `50.0.1` | Ed25519 signing. PyCA-maintained with prebuilt wheels and first-class Ed25519 — hand-rolling it would be a security review we do not want to own. |

Development only: `pytest 9.1.1`, `pytest-asyncio 1.4.0`, `ruff 0.16.6`, `build 1.6.0`, `setuptools 84.0.0`.

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
