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
async def say(ctx: Context) -> None:
    ctx.command       # "say"
    ctx.arguments     # the raw rest of the line, unparsed, possibly ""
    ctx.chat          # Chat(id, type, name, member_count)
    ctx.sender        # User(id, handle, name), always set
    ctx.message.text  # "/say hi", the invoking message, verbatim
    await ctx.reply("…")
```

`ctx.sender` and `ctx.message` are plain `User` and `Message`, never `None` — `command.invoked`
always carries both, so a type that admitted `None` would only make you narrow something that
is always there. `ctx.message` is the invoking message in full: `.id`, `.text`, `.sent_at`,
`.sender` (the person who wrote it, or `None` on a message that is only a reference) and
`.reply_to`, the id of the message it quoted, or `None`. `ctx.reply()` quotes it, so an answer
never floats free in a busy chat — there is no flag, and on an event that carries no message
it sends a plain message instead.

Handlers run concurrently, and an event is acked only after its handler returns — so a
crash mid-handler redelivers rather than loses. **Do not block inside a handler.** A
synchronous call (`requests.get`, `time.sleep`, a busy loop) starves the heartbeat on the
same event loop, and the server reaps a socket that has gone quiet for three intervals.
Use `await`, or hand the work to a thread.

An exception in a handler is logged with its traceback, the bot stays up, and the event is
still acked:

```python
from aurival import AnyContext, Event

@bot.on_error
async def on_error(error: BaseException | Event, ctx: AnyContext | None) -> None:
    ...   # ctx is None for anything that did not come from a handler
```

The hook also sees the two things that are not a handler's fault: a `problem` frame from the
server (your socket stays open), and a `backlog.overflowed` event telling you how many events
you missed while you were away and where delivery resumed. Neither reaches a command handler,
which is why `error` is `BaseException | Event` and not just an exception.

### Upgrading from 0.2.x

`ctx.sender` is a `User` again on a command. Where 0.2.x made you write
`if ctx.sender is not None:` before `ctx.sender.handle`, 0.3.0 wants `ctx.sender.handle` on
its own — the narrowing existed only because one class covered every event, and that is what
went away.

`ctx.user`, `ctx.actor` and `ctx.emoji` are gone from `Context`. They live on the class for
the event that carries them, so `ctx: Context` on a `member.joined` handler becomes
`ctx: MemberContext`, and the `if ctx.user is not None:` guard it needed goes with it. An
unannotated `ctx` keeps working unchanged — it registers and runs as it always did, you
simply get nothing checked and nothing completed — see
[Events beyond commands](#events-beyond-commands).

`Context.from_event` no longer builds a context for anything but `command.invoked`, and
`context_for` is internal. If you were calling `Context.from_event(event, http=...)` to make
a context by hand, there is no supported replacement — the SDK builds the context, because
picking the class for an event type is exactly the decision the release moved off you.

## Events beyond commands

`@bot.command` is for `command.invoked`. Everything else — membership changes, your bot
being added or removed, a reaction landing on one of its messages — goes through
`@bot.on(event_type)`, a decorator or a direct call, either registering another handler for
that type:

```python
from aurival import BotContext, EventContext, MemberContext, ReactionContext

@bot.on("member.joined")
async def welcome(ctx: MemberContext) -> None:
    await ctx.send(ctx.chat, f"welcome, {ctx.user.name}!")

@bot.on("member.left")
async def farewell(ctx: MemberContext) -> None:
    await ctx.send(ctx.chat, f"{ctx.user.name} has left")

@bot.on("bot.added")
async def added(ctx: BotContext) -> None:
    await ctx.reply(f"thanks for the invite, {ctx.actor.name}")

@bot.on("bot.removed")
async def removed(ctx: BotContext) -> None:
    ...

@bot.on("reaction.added")
async def liked(ctx: ReactionContext) -> None:
    await ctx.react(ctx.message, ctx.emoji)   # no reaction.removed exists; un-reacting is silent

@bot.on("some.future.type")
async def future(ctx: EventContext) -> None:
    if ctx.user is not None:
        await ctx.reply(ctx.user.handle)


def sync_registration(bot: Bot) -> None:
    async def joined(ctx: MemberContext) -> None:
        ...

    bot.on("member.joined", joined)  # the non-decorator form
```

One class per event family, and each class declares only the fields its own event carries:

| event | context class | fields it adds |
|---|---|---|
| `command.invoked` | `Context` | `command`, `arguments`, `sender`, `message` |
| `member.joined` / `member.left` | `MemberContext` | `user` |
| `bot.added` / `bot.removed` | `BotContext` | `actor` |
| `reaction.added` | `ReactionContext` | `sender`, `message` (id only), `emoji` |
| anything else | `EventContext` | `sender`, `user`, `actor`, `message`, `emoji`, every one optional |

`chat`, `event` and all six actions come from `BaseContext`, so they are on every context
whatever the event. The split is there so your editor can tell you what `ctx` has: typing
`bot.on("` offers the five names the SDK knows, a handler's `ctx` annotation is checked
against the family you registered for — decorator or direct call — and autocomplete on
`ctx.` lists what this event actually carries and nothing that would always be empty. You
never read a doc to find out which fields are real on which event, and a handler annotated
for the wrong family is a red line before you run it.

Annotating is optional — a bare `ctx` registers and runs exactly as it always did, it is
just `Any`, so nothing completes it and nothing catches a field the event never carries.
`EventContext` is the forward-compatibility door: a type this SDK does not know yet still
registers and still builds a context, never an exception, because a bot has to keep running
against a server that has shipped an eighth type. It is populated opportunistically from
whatever the payload recognizably carries under the familiar keys, which is why every field
on it is optional — "ignored, not fatal" means you get what's there, not nothing.

`ctx.chat.member_count` is the chat's live participant count, bots included: an `int` on
every event the server sends today, and `None` only on a frame that omitted the key, because
defaulting it to `0` would claim a count we were never given.

## Actions

Six more things a handler can do, beyond `ctx.reply()`. Every send returns the `Message` the
server stored, so the thing you just posted is the thing you edit or delete next — you never
have to fish an id back out:

```python
@bot.command("work")
async def work(ctx: Context) -> None:
    sent = await ctx.reply("working…")
    async with ctx.typing():
        ...   # is_typing:true on enter, is_typing:false on exit, even on exception
    await ctx.edit(sent, "done")
    await ctx.react(ctx.message, "👍")
    await ctx.unreact(ctx.message, "👍")
    await ctx.delete(sent)

    page = await ctx.members()   # defaults to ctx.chat
    while page.has_more:         # never inferred from a short page or a cursor alone
        page = await ctx.members(cursor=page.next_cursor)   # one page at a time
```

`edit` and `delete` take a `Message` or a bare id, and only the bot's own messages — anyone
else's answers `MessageNotYours`. `react` and `unreact` work on any message in a chat the bot
is in and are idempotent, so reacting twice leaves one reaction rather than toggling it off.
The `sender` on a message you sent is id-only, with `handle` and `name` empty, because the
stored entity carries a bare `usr_…` id and the SDK will not invent the rest.

The typing indicator is also automatic: a command handler still running 300 ms after it
started shows the chat "is thinking", and the indicator clears when the handler returns,
including on an exception. A handler that replies inside those 300 ms sends nothing, so a
fast bot never flickers. `Bot(auto_typing=False)` turns it off if you would rather drive
`ctx.typing()` yourself, and `async with ctx.typing():` is also how you get the indicator up
from the first instant, or outside a command.

`ctx.send(chat, text, mentions=...)` posts to any chat, not only the one that triggered the
handler, and mentions a user by writing `@` + their handle into `text` yourself — `mention()`
builds that token for you:

```python
from aurival import MemberContext, mention

@bot.on("member.joined")
async def greet(ctx: MemberContext) -> None:
    who = mention(ctx.user)
    await ctx.send(ctx.chat, f"hey {who}, welcome!", mentions=[who])
```

`mentions` also takes a bare `User` or `{"user": "usr_…"}` directly — `mention()` exists for
the token, not because the other forms are wrong. Every entry in `mentions` needs its
`@handle` token actually present in `text`, or the server rejects the request.

## Embeds and buttons

`Embed` is a builder: `Embed(title=..., description=..., color=...)` gives you the starting
card, and every `add_field`/`set_author`/`set_thumbnail`/`set_footer` call returns the same
`Embed`, so you chain them straight into the constructor call. `Button(label, id=..., style=...)`
is a separate, flat object — `style` is one of `"primary" | "secondary" | "danger" | "link"`,
and anything else raises a plain `ValueError` naming the bad style. Pass lists of both straight
into `ctx.reply()` or `ctx.send()`:

```python
from aurival import Embed, Button

embed = (
    Embed(title="Title", description="Description. Plain text or markdown, under the title.")
    .set_author("Author line")
    .add_field("Field name", "Field value", inline=True)
    .add_field("Second field", "Second value", inline=True)
    .set_image("https://bots.aurival.com/docs-assets/aurival-welcome-cover.jpg")
    .set_footer("Footer text", icon="https://bots.aurival.com/docs-assets/aurival-mascot-hero.png")
)
buttons = [
    Button("Primary action", id="primary", style="primary"),
    Button("Secondary action", id="secondary", style="secondary"),
    Button("Danger action", id="danger", style="danger"),
]
await ctx.reply(embeds=[embed], buttons=buttons)
```

A card earns its place when there is something to put on it: buttons, fields, an image. A reply
that one line of text covers — a coin flip, a joke, a status line — reads better as that line,
and a plate wrapped around it is chrome the reader has to look past.

### A button that opens a link

`Button.link(label, url)` builds a pill that opens a url instead of coming back to your bot.
It is the only sanctioned way to build one — `style="link"` on the plain constructor without a
url raises, because a link button with nowhere to go is a dead pill:

```python
from aurival import Button

buttons = [
    Button.link("Opens aurival.com", "https://aurival.com"),
    Button.link("Opens the docs", "https://bots.aurival.com"),
    Button("Primary action", id="primary", style="primary"),
]
await ctx.reply("Two link buttons and a regular one, sharing one row.", buttons=buttons)
```

A link button never comes back to you: no `button.pressed` event, ever, and it never flips the
row to used. It also stays tappable after a sibling is pressed, and while a sibling is still
waiting on your `ack()` — the row greys out around it, the link does not. `id` still has to be
there and still has to be unique in the message, and the SDK still slugs it from the label when
you leave it out, so `Button.link("Opens the docs", ...)` gets `id="opens-the-docs"` like any
other button.
Link buttons count toward the five-button cap, and a message made only of link buttons is fine.

A url is `https://` and at most 2048 characters, everywhere a url is a link target. A non-link
button must not carry a `url`, and passing one raises rather than being quietly dropped — a typo
you cannot see is worse than an error you can.

### Emoji on a button

`emoji=` puts one glyph in front of the label, inside the pill:

```python
from aurival import Button

buttons = [
    Button("Secondary action", id="secondary", style="secondary", emoji="🤔"),
    Button("Primary action", id="primary", style="primary", emoji="⏰"),
]
await ctx.reply("Two buttons, each with one emoji in front of the label.", buttons=buttons)
```

Exactly one unicode emoji, no custom emoji, no `:shortcode:`, no image url. The emoji does not
count toward the 24-character label cap — it is its own field, and folding it into the label
count would make one cap mean two things. The label is still required, so there is no
emoji-only button: a pill with no words is unguessable to everyone and unreadable to a screen
reader.

### A footer icon, a linked title, a linked author

`set_footer(text, icon=...)` puts a small image beside the footer text, `url=` on the embed
makes its title tappable, and `url=` on `set_author` does the same for the author line:

```python
from aurival import Embed

embed = (
    Embed(
        title="A linked title",
        description="The title and the author line below both open a url when tapped.",
        url="https://aurival.com",
    )
    .set_author(
        "Author line",
        icon="https://bots.aurival.com/docs-assets/aurival-mascot-hero.png",
        url="https://aurival.com",
    )
    .set_footer("Footer text", icon="https://bots.aurival.com/docs-assets/aurival-mascot-hero.png")
)
await ctx.reply(embeds=[embed])
```

Each of the three needs the thing it attaches to: a footer icon needs footer text, an embed url
needs a title to hang the tap on, and an author url needs an author name. Without them there is
nothing for a reader to press, and dropping the url silently would fail where nobody could see
it.

### Markdown in the description

The description is rendered as markdown. Nothing else on the card is — title, field names, field
values, footer text and author name are all plain text, so a `**bold**` in a field name arrives
as four asterisks and two words:

```python
from aurival import Embed

embed = Embed(
    title="Markdown in the description",
    description=(
        "**Bold**, *italic*, ~~strikethrough~~ and `inline code` all render.\n"
        "Headings render as bold body text, not larger type."
    ),
).add_field("Field name", "Field value", inline=True)
await ctx.reply(embeds=[embed])
```

Supported: bold, italic, bold-italic, strikethrough and inline code. Headings render as bold
text at body size rather than as larger type, because a card is not a document. Not supported:
images, tables, code panels and autolink — a fenced block renders as plain styled text, not a
panel, and a bare URL never becomes a tap target.

Italic is `*text*`; underscores are not a delimiter and render as typed.

The 1024-character description cap counts the raw markdown source you typed, not what the reader
sees, so the asterisks and backticks are part of your budget.

A markdown link (`[label](https://…)`) or a bare URL is still refused inside the description, and
inside every other prose field with it. Links live in the structured url fields above, where the
client knows the target before it paints — in prose, a label can say one thing and go somewhere
else.

### Where a link goes, and what the reader sees first

A tap on a link button, a linked title or a linked author that points outside Aurival shows the
reader a leaving notice naming the host before anything opens, so nobody hands their IP to a
stranger by pressing a pill that looked friendly. The host on the notice is read off the real
url, so what they are shown is what opens. An `aurival.com` link skips the notice and opens in
the app, because it never left.

### Caps

The SDK checks every cap locally before the frame goes out, so a bad bot fails fast with a plain
error naming which cap it hit.

| cap | limit |
|---|---|
| embeds per message | 3 |
| fields per message | 6, summed across every embed |
| buttons per message | 5 |
| button label | 24 characters, emoji not counted |
| button emoji | exactly one unicode emoji |
| button style | `primary`, `secondary`, `danger` or `link` |
| embed description | 1024 characters of raw markdown |
| link url (button, title, author) | 2048 characters, `https://` only |
| image url (thumbnail, image, author icon, footer icon) | `https://` only, no length cap |

One convention, which is ours and not a rule: when one button is the one you want pressed, put
it last. The server and the client never reorder a row — your order is the order the reader
sees — so this is a habit the docs suggest, not something enforced anywhere.

A press comes back as a `button.pressed` event, handled the same way any other event is:

```python
from aurival import ButtonContext

@bot.on("button.pressed")
async def on_press(ctx: ButtonContext):
    await ctx.ack()
    if ctx.button == "primary":
        await ctx.reply("You pressed the primary button.")
```

`ButtonContext` carries `.chat`, `.user`, `.message`, `.button` (the id you set when building
it) and `.interaction`. Call `await ctx.ack()` exactly once per press — a button is single-use,
and acking one a second time doesn't raise locally, the server 409s the request.

The showcase bot runs every one of these cards live. The full set is in the
[cookbook](https://bots.aurival.com/docs/cookbook).

## Buttons only the caller can press

By default nobody is locked: any member in the chat can press a card's buttons, exactly as
before this existed. Pass `for_user=` to `reply`, `send`, `edit` or `ack` to lock the press to
one member.

```python
await ctx.reply("Locked to the caller", buttons=buttons, for_user=ctx.sender)
```

`for_user` takes a `User` (`ctx.sender` is one) or a bare `usr_…` id string. Either one
serializes to the same id on the wire.

Everyone still sees the card and its text. Only the press is gated: a non-caller's buttons
render at `.56` opacity with no checkmark, are not tappable, and the app shows a `For {name}`
hint under the row. A link button on a locked card stays pressable by anyone. It never
round-trips to the server, so there is nothing for the lock to gate.

A non-caller who presses anyway is refused by the server with a `403`, before anything is
spent. `used` stays unset and the card is unchanged. That refusal never reaches your bot: a bot
never presses a button, so there is no SDK exception for it.

Omitting `for_user` on a `reply`/`edit`/`ack` that replaces a card **keeps the existing lock**.
Passing `for_user=None` **clears** it, and the card opens to everyone. Passing a new id **moves**
the lock to that member. This matters most on `ack`, where a quiz redraws its own card between
questions and must not silently unlock itself by leaving `for_user` out.

A caller-only quiz, start to finish:

```python
from aurival import Button, ButtonContext, Context, Embed

@bot.command("locked")
async def locked(ctx: Context) -> None:
    embed = Embed(
        title="Locked to the caller",
        description="Everyone sees this card. Only the person who ran the command can press.",
    )
    await ctx.reply(
        embeds=[embed],
        buttons=[Button("Only the caller presses", id="only", style="primary")],
        for_user=ctx.sender,
    )

@bot.on("button.pressed")
async def answered(ctx: ButtonContext) -> None:
    await ctx.ack("Pressed.", buttons=[])
```

`ButtonContext` carries no `for_user` field. The presser is always the locked user by
construction: the server refuses everyone else before your handler ever runs, so there is
nothing on the press for it to expose. If you need the lock on a card you are acking, you
already have it: you set it on the send.

## Cooldowns

A cooldown paces a command or a button. You attach it, the SDK keeps the bucket, and the wire
never carries it — the server does not know one exists.

```python
from aurival import Bot, Cooldown, Context

bot = Bot()                                   # button_cooldown=Cooldown(1, 2.0) already

@bot.command("roll", cooldown=Cooldown(1, 5.0))
async def roll(ctx: Context) -> None: ...

@bot.command("leaderboard", cooldown=Cooldown(3, 60.0, "chat"))
async def leaderboard(ctx: Context) -> None: ...
```

`per` is **seconds**, the same unit `AurivalAPIError.retry_after` already uses, so a number you
catch and a number you write mean the same thing.

Three buckets, and each one says who shares the limit:

| bucket | key | reads as |
|---|---|---|
| `user` (the default) | the invoking or pressing user | each person gets one every N seconds |
| `chat` | the conversation | this chat gets one every N seconds, whoever asks |
| `global` | nothing | this bot answers one every N seconds, everywhere |

A command that is refused never reaches your handler, and a refusal spends nothing — the token
is taken only when the call passes.

### What the member sees

One plain reply per bucket per window, then silence for the rest of it. Somebody who types
`/roll` eight times in five seconds gets one sentence, not eight:

```
Slow down. Try /roll again in 3 s.
```

Replace it, or suppress it, with a hook. A registered hook owns the whole response: the SDK
sends nothing and the hook either replies or stays quiet. There is no return value to get right.

```python
@bot.on_cooldown                       # bot-level: every command without its own hook
async def cooling(ctx: Context, retry_after: float) -> None:
    await ctx.reply(f"easy, {retry_after:.0f}s")

async def roll_cooling(ctx: Context, retry_after: float) -> None: ...

@bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=roll_cooling)
async def roll(ctx: Context) -> None: ...   # the per-command hook wins
```

The hook is called once per bucket per window too, so replacing the sentence does not
re-introduce the spam it existed to stop.

### Buttons already have one

Every bot ships with `Cooldown(1, 2.0, "user")` on its buttons, without asking: one press every
two seconds per person, one bucket per person per bot. A press inside the window is answered
rather than handled — the presser's pending ink clears and their device shows a toast — and the
button stays live, because a cooldown is a wait, not a spend.

Override it where it belongs, and precedence is button, then card, then the bot default:

```python
bot = Bot(button_cooldown=Cooldown(1, 5.0))          # this bot's buttons
await ctx.reply(buttons=[...], button_cooldown=None) # this card's buttons, off
Button("Primary action", cooldown=None)              # this one button, off
```

A per-card or per-button cooldown gets its own buckets, keyed on the message, the button id and
the bucket subject — button ids are unique within a message and nowhere else, so two cards that
both call a button `roll` never share a limit. `None` disables at any level.

A button cooldown is at most 60 seconds and is refused where you write it, not later inside an
ack you cannot see. Command cooldowns have no cap: `Cooldown(1, 3600.0)` on a command is a
legitimate once an hour.

Link buttons are outside all of this — a link opens on the device and never round-trips, so it
cannot carry a cooldown and `Button.link` has no `cooldown` argument.

### Keep one Cooldown per button

A `Cooldown` owns its own bucket of remaining presses. Build a fresh one inside the ack handler —
or anywhere a press can re-run it — and it forgets every prior press, so the cooldown never
actually triggers. Define the `Cooldown` and the `Button` once, at module scope, and reuse those
same objects on the send and on every ack that follows it:

```python
# Once, at module scope — not inside the handler.
COOLDOWN = Cooldown(1, 10.0)
BUTTON = Button("+1", id="inc", style="primary", cooldown=COOLDOWN)

@bot.on("button.pressed")
async def on_press(ctx: ButtonContext):
    await ctx.ack(buttons=[BUTTON])   # the same BUTTON, never Button(...) rebuilt here
```

### The caveat, said plainly

**Buckets are process memory.** They reset on restart, and they are not shared between
instances: a bot running two processes has two independent buckets, and a deploy clears every
bucket it had. Cooldowns pace a conversation. They are not a quota, and they are not the abuse
bound — the server keeps its own floor underneath them.

## Upgrading from 0.3.x

`Embed`, `Button` and `ButtonContext` are new in 0.4.0. Nothing about them is required: `reply`
and `send` gained `embeds=` and `buttons=` keyword arguments, and both default to `None`, so
code that never mentions them behaves exactly as it did on 0.3.x.

`Message` gained three new attributes — `.embeds`, `.buttons` and `.button_used` — all of which
default to empty (or `None` for `.button_used`) on a message that never carried any, so existing
code reading other `Message` fields is unaffected.

`@bot.on("button.pressed")` is a new event a bot can opt into; a bot that never registers a
handler for it simply never receives one.

## Upgrading from 0.4.x

Everything 0.5.0 adds to a card is optional: `url=` on `Embed` and on `set_author`, `icon=` on
`set_footer`, `emoji=` and `url=` on `Button`, and the `Button.link` constructor. A card that
uses none of them serialises exactly as it did on 0.4.0 — same keys, same bytes, no `"url":
null` where there was nothing before — so a bot you wrote against 0.4.0 needs no edit at all.

`"link"` is a real button style now, where 0.4.0 refused it with `link buttons are not supported
in v1`. Build one with `Button.link(label, url)`; that classmethod is the sanctioned constructor, and it sets the
style for you.

One thing was removed rather than added, so it is the only change here that can break an import:
`aurival.caps.CAP_LINK_STYLE_DEFERRED` is gone. It held the sentence `link buttons are not
supported in v1`, and the deferral it named is over, so the constant went with the refusal. If you
imported it to pre-check a style before sending, delete that check — `Button.link` builds the
button the server now accepts.

A link button is not an action button wearing a url. It never produces a `button.pressed` event,
it never flips `used`, and it is not disabled by a sibling being pending or used — so a row can
go cold around a link and the link still works. If you were counting on every button in a row
answering back, count only the ones you did not build with `Button.link`.

## Upgrading from 0.5.x

0.6.0 adds keyword arguments in two places and takes nothing away. `ctx.edit` gained `embeds=`
and `buttons=` next to `text`, and `ctx.ack()` gained all three, so a press can answer by
replacing the card it was pressed on instead of stacking a second message under it. A bot
written against 0.5.0 needs no edit at all: `await ctx.edit(sent, "done")` and a bare `await
ctx.ack()` send exactly the bytes they sent before.

Three states, one rule, on both doors:

- leave an argument out and that part of the card is kept as it was
- pass a value and that part is replaced
- pass an empty list and that part is cleared — `embeds=[]` goes on the wire as `"embeds": null`

`None` already means "not present", so it cannot also mean "clear"; the empty list is the clear.
`text` is not clearable, because a card always carries text and `""` already means empty. An edit
with all three left out raises `ValueError("an edit needs text, embeds or buttons")` before
anything is sent, and the server answers the same sentence as `NothingToEdit`.

Pressing a button is the whole feature in one pair of handlers. Both cards earn their plate: the
first card carries buttons, the replacement carries the result.

```python
from aurival import Button, ButtonContext, Embed

@bot.command("update")
async def update(ctx: Context) -> None:
    embed = Embed(title="Press a button", description="The card is replaced in place when you press one.")
    buttons = [
        Button("Press me, card updates", id="u1", style="primary"),
        Button("Or press me", id="u2", style="secondary"),
    ]
    await ctx.reply(embeds=[embed], buttons=buttons)

@bot.on("button.pressed")
async def answered(ctx: ButtonContext) -> None:
    which = "first" if ctx.button == "u1" else "second"
    result = Embed(
        title=f"You pressed the {which} button",
        description="ack() replaced the card in place. Nothing else in the chat moved.",
    )
    await ctx.ack(embeds=[result], buttons=[Button("Press again", id="again", style="primary")])
```

The ack and the replacement are one request. The question card becomes the result card in place,
the `Play again` row starts unused, and the message is not marked edited — an interaction
response is the bot answering the presser, not the author correcting themselves. Reusing button
ids across replacements is allowed and safe: the server keys the refusal on the interaction, not
on the id.

`edit` is the other door and it does mark the message edited, so a card can redraw itself outside
a press:

```python
await ctx.edit(sent, embeds=[Embed(title="Title")])
await ctx.edit(sent, buttons=[])   # the row is gone, the plate stays
```

## Upgrading from 0.6.x

0.7.0 adds cooldowns and takes nothing away. `Cooldown` is a new export, `@bot.command` gained
`cooldown=` and `on_cooldown=`, `Bot` gained `button_cooldown=`, `reply`/`send` gained
`button_cooldown=`, and `Button` gained `cooldown=`. Every one of them has a default that keeps
0.6.0 behaviour, with **one exception you should know about**: buttons now carry
`Cooldown(1, 2.0, "user")` by default, so a member cannot press the same bot's buttons faster
than once every two seconds. That is deliberate and it is on by default. If your bot's buttons
are something a member is meant to mash, turn it off explicitly:

```python
bot = Bot(button_cooldown=None)
```

Two new error classes ship with it, `CooldownWithBody` and `CooldownRetryAfterInvalid`, both
`InvalidRequestError`. You will not normally see either: the SDK builds the cooldown ack itself
and refuses an out-of-range button cooldown where you write it.

## Shadowed commands

Every `run()` syncs your command list, and the server answers with the chats where another
bot already holds one of your names. Yours never fires there. The SDK logs one warning
line per shadowed chat, through the standard `aurival` logger:

```
WARNING:aurival:command 'ping' is shadowed in chat chat_01j… by another bot's command with the same name, and will never fire there
```

Rename the command, or get the other bot out of that chat. Nothing else in the SDK reacts
to it — a shadowed command in one chat is still live in every other.

## Command aliases

`aliases=` on `@bot.command` gives one command several spellings, all handled by the same
function. `/roll` and `/r` fire the same handler, share the same cooldown bucket, and are one
command everywhere the server or the app talks about it.

```python
from aurival import Context, Cooldown

async def on_roll_cooldown(ctx: Context, retry_after: float) -> None:
    await ctx.reply(f"easy, /{ctx.invoked_as} again in {retry_after:.0f}s")

@bot.command("roll", "Roll dice", aliases=["r"], cooldown=Cooldown(1, 5.0), on_cooldown=on_roll_cooldown)
async def roll(ctx: Context) -> None:
    await ctx.reply(f"/{ctx.invoked_as} ran {ctx.command}, dice rolled")
```

`ctx.command` is always the canonical name, `"roll"`, whichever spelling fired the handler.
`ctx.invoked_as` is the token the human actually typed, lowercased: `"roll"` or `"r"`. They are
equal on a canonical call. Code that checks `ctx.command == "roll"` keeps working no matter which
spelling reached it.

At most three aliases per command. A fourth raises locally, before anything is synced. It is the
same validation path as a bad command name: lowercase letters, digits, hyphens and underscores
only, and none of the reserved names (`help`, `report`, `block`, `mute`, `kick`, `ban`, `admin`,
`staff`, `support`, `aurival`).

Cooldowns key on the canonical command, not on what was typed: `/roll` and `/r` share one
bucket, not two. The cooldown notice echoes the typed token, though: hit the limit through `/r`
and you get `Slow down. Try /r again in 3 s.`, never `/roll`.

In the app, the command picker lists a command's aliases as a muted secondary line under its
row: `also /r`. Picking a row that matched by alias fills that alias, not the canonical
spelling: typing `/r` and picking the row inserts `/r `, not `/roll `.

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
15 seconds or less. Past that the error is raised at once instead of slept through: a handler
that sleeps for minutes holds its event unacknowledged for the whole wait, and the server
redelivers behind it.

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
