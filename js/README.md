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
  ctx.chat; // { id, type, name, member_count }
  ctx.sender; // { id, handle, name }, always set
  ctx.message.text; // "/say hi", the invoking message, verbatim
  await ctx.reply('…');
});
```

`ctx.message` is the invoking message itself: `ctx.message.id`, `.text`, `.sent_at`, `.sender`,
and `.reply_to` (the id of the message it quoted, or `null`). `ctx.reply()` quotes it by id, so
an answer never floats free in a busy chat. On an event that is about no message — someone
joining, someone adding the bot — there is nothing to quote and the reply is sent plain. There
is no flag for it: the context knows which message its event is about, or knows there is none.

`ctx.chat.member_count` is the chat's live participant count, bots included. It is a number on
every event the server sends today, and `null` only on a frame that omitted it — never
defaulted to 0, because a genuinely empty chat is still a number.

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
  await ctx.send(ctx.chat, `welcome, ${ctx.user.handle}`);
});

bot.on('member.left', async (ctx) => {
  console.log(ctx.user.handle, 'left', ctx.chat.id);
});

bot.on('bot.added', async (ctx) => {
  await ctx.send(ctx.chat, `thanks for adding me, ${ctx.actor.handle}`);
});

bot.on('bot.removed', async (ctx) => {
  console.log(ctx.actor.handle, 'removed me from', ctx.chat.id);
});

bot.on('reaction.added', async (ctx) => {
  console.log(ctx.sender.handle, 'reacted', ctx.emoji, 'on', ctx.message.id);
});
```

None of those handlers annotates `ctx`. The event name is what picks the class, so the editor
offers the five names as you type `bot.on('`, and then knows what `ctx` holds. A handler
defined somewhere else names its class itself:

```ts
import type { MemberContext } from 'aurival';

async function onLeft(ctx: MemberContext): Promise<void> {
  console.log(ctx.user.handle, 'left', ctx.chat.id);
}

bot.on('member.left', onLeft);
```

| event                           | `ctx`             | beside `ctx.chat` and `ctx.event`                                 |
| ------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `command.invoked`               | `Context`         | `command`, `arguments`, `sender`, `message`                       |
| `member.joined` / `member.left` | `MemberContext`   | `user`                                                            |
| `bot.added` / `bot.removed`     | `BotContext`      | `actor`                                                           |
| `reaction.added`                | `ReactionContext` | `sender`, `message` (id only, the text is not re-sent), `emoji`   |
| anything else                   | `EventContext`    | `sender`, `user`, `actor`, `message`, `emoji` — each one nullable |

Each class carries only its own family's fields, and every one of them is set. That is the
whole point: your editor tells you what `ctx` has, so you never read a doc to find out, and
you never guard a field that is always there. `ctx.emoji` in a member handler is a compile
error rather than a runtime `undefined`, and so is a `bot.added` handler registered for
`member.joined`.

An event type this SDK does not know about yet is never fatal — `bot.on()` a type the server
hasn't invented yet and, if it starts sending it, the handler runs with an `EventContext`
holding whatever fields the frame happened to carry. Nothing is pinned there, so everything is
nullable and you narrow before you read. There is no `reaction.removed` event: un-reacting is
silent.

## Actions

Every action is available on a handler's `ctx`, whichever class it is — they live on the shared
base, so `ctx.reply()` reads the same in a command as in a `member.joined`.

```ts
bot.command('fix', async (ctx) => {
  const sent = await ctx.reply('working on it…');
  await ctx.edit(sent, 'done!');
});

bot.command('oops', async (ctx) => {
  const sent = await ctx.reply('ignore that');
  await ctx.delete(sent);
});

bot.command('upvote', async (ctx) => {
  await ctx.react(ctx.message, '\u{1F44D}');
});

bot.command('downvote', async (ctx) => {
  await ctx.unreact(ctx.message, '\u{1F44D}');
});

bot.command('busy', async (ctx) => {
  await ctx.withTyping(async () => {
    // ... slow work, e.g. calling out to another service ...
    await ctx.reply(`done, and there are ${ctx.chat.member_count} of us in here`);
  });
});

bot.command('roster', async (ctx) => {
  // One page per call — never auto-loads the rest. Loop on `hasMore`, never
  // on whether `nextCursor` looks truthy: `hasMore` is the explicit signal
  // (CONTRACT-V1 §4), and inferring "more pages" from the cursor is exactly
  // the off-by-one every other SDK ships.
  const handles: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await ctx.members(undefined, cursor === null ? {} : { cursor });
    handles.push(...page.users.map((u) => u.handle));
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  await ctx.reply(handles.join(', '));
});
```

`reply()`, `send()` and `edit()` return the message they stored, so `sent` is what you hand
straight back to `edit()`, `delete()` and `react()` — no id juggling. The `sender` on one of
those, when it is set at all, is known by id alone — `handle` and `name` are empty strings,
because the REST entity names the sender with a bare `usr_…`.

`edit()` and `delete()` take only the bot's own messages; anyone else's answers
`message_not_yours`, which is why `oops` above deletes the reply it just sent rather than the
message that invoked it. `react()` and `unreact()` work on any message in a chat the bot is in.

The typing indicator is automatic: a command handler still running 300 ms after it started
shows the chat "is thinking", and the indicator clears when the handler returns, including on a
throw. A handler that replies inside those 300 ms sends nothing, so a fast bot never flickers.
`new Bot({ autoTyping: false })` turns it off if you would rather drive `ctx.withTyping()`
yourself.

`ctx.typing(true | false)` and `ctx.withTyping(fn)` toggle the indicator by hand — `withTyping`
sends `true` on entry and `false` on exit, always, even if `fn` throws.

`@`-mention someone with `mention(user)` — it template-literals straight into `text` as
`@handle`, and carries the id the server needs in `mentions`:

```ts
import { mention } from 'aurival';

bot.on('member.joined', async (ctx) => {
  const who = mention(ctx.user);
  await ctx.send(ctx.chat, `welcome, ${who}!`, { mentions: [who] });
});
```

Every entry in `mentions` needs its `@handle` token actually present in `text`, outside any
code block or inline code, or the server rejects the request — write the handle into the
message yourself, in plain text; the SDK will not edit `text` for you, and a mention inside
code, or with no token at all, renders as nothing.

## Embeds and buttons

`Embed` is a builder — every `setAuthor`/`setThumbnail`/`addField`/`setFooter` call returns the
same instance, so you chain them off the constructor. `Button` is a separate, flat object:
`new Button({ label, id, style })`, where `style` is one of
`'primary' | 'secondary' | 'danger' | 'link'`, and anything else throws a plain error naming the
bad style. Pass arrays of both into the existing options-object shape
`ctx.reply(text, { embeds, buttons })`, the same convention `ctx.send(chat, text, { mentions })`
already uses:

```ts
import { Embed, Button } from 'aurival';

const embed = new Embed({ title: 'Title', description: 'Description. Plain text or markdown, under the title.' })
  .setAuthor('Author line')
  .addField('Field name', 'Field value', true)
  .addField('Second field', 'Second value', true)
  .setImage('https://bots.aurival.com/docs-assets/aurival-welcome-cover.jpg')
  .setFooter('Footer text', 'https://bots.aurival.com/docs-assets/aurival-mascot-hero.png');

const buttons = [
  new Button({ label: 'Primary action', id: 'primary', style: 'primary' }),
  new Button({ label: 'Secondary action', id: 'secondary', style: 'secondary' }),
  new Button({ label: 'Danger action', id: 'danger', style: 'danger' }),
];

await ctx.reply({ embeds: [embed], buttons });
```

A card earns its place when there is something to put on it: buttons, fields, an image. A reply
that one line of text covers — a coin flip, a joke, a status line — reads better as that line,
and a plate wrapped around it is chrome the reader has to look past.

### A button that opens a link

`Button.link({ label, url })` builds a pill that opens a url instead of coming back to your bot.
It is the only sanctioned way to build one — `style: 'link'` on the plain constructor without a
url throws, because a link button with nowhere to go is a dead pill:

```ts
import { Button } from 'aurival';

const buttons = [
  Button.link({ label: 'Opens aurival.com', url: 'https://aurival.com' }),
  Button.link({ label: 'Opens the docs', url: 'https://bots.aurival.com' }),
  new Button({ label: 'Primary action', id: 'primary', style: 'primary' }),
];

await ctx.reply('Two link buttons and a regular one, sharing one row.', { buttons });
```

A link button never comes back to you: no `button.pressed` event, ever, and it never flips the
row to used. It also stays tappable after a sibling is pressed, and while a sibling is still
waiting on your `ack()` — the row greys out around it, the link does not. `id` still has to be
there and still has to be unique in the message, and the SDK still slugs it from the label when
you leave it out, so that `Opens the docs` pill gets `id: 'opens-the-docs'` like any other
button. Link
buttons count toward the five-button cap, and a message made only of link buttons is fine.

A url is `https://` and at most 2048 characters, everywhere a url is a link target. A non-link
button must not carry a `url`, and passing one throws rather than being quietly dropped — a typo
you cannot see is worse than an error you can.

### Emoji on a button

`emoji` puts one glyph in front of the label, inside the pill:

```ts
import { Button } from 'aurival';

const buttons = [
  new Button({ label: 'Secondary action', id: 'secondary', style: 'secondary', emoji: '🤔' }),
  new Button({ label: 'Primary action', id: 'primary', style: 'primary', emoji: '⏰' }),
];

await ctx.reply('Two buttons, each with one emoji in front of the label.', { buttons });
```

Exactly one unicode emoji, no custom emoji, no `:shortcode:`, no image url. The emoji does not
count toward the 24-character label cap — it is its own field, and folding it into the label
count would make one cap mean two things. The label is still required, so there is no
emoji-only button: a pill with no words is unguessable to everyone and unreadable to a screen
reader.

### A footer icon, a linked title, a linked author

`setFooter(text, icon)` puts a small image beside the footer text, `url` on the embed makes its
title tappable, and the third argument to `setAuthor` does the same for the author line:

```ts
import { Embed } from 'aurival';

const embed = new Embed({
  title: 'A linked title',
  description: 'The title and the author line below both open a url when tapped.',
  url: 'https://aurival.com',
})
  .setAuthor('Author line', 'https://bots.aurival.com/docs-assets/aurival-mascot-hero.png', 'https://aurival.com')
  .setThumbnail('https://bots.aurival.com/docs-assets/aurival-mascot-hero.png')
  .setFooter('Footer text', 'https://bots.aurival.com/docs-assets/aurival-mascot-hero.png');

await ctx.reply({ embeds: [embed] });
```

Each of the three needs the thing it attaches to: a footer icon needs footer text, an embed url
needs a title to hang the tap on, and an author url needs an author name. Without them there is
nothing for a reader to press, and dropping the url silently would fail where nobody could see
it.

### Markdown in the description

The description is rendered as markdown. Nothing else on the card is — title, field names, field
values, footer text and author name are all plain text, so a `**bold**` in a field name arrives
as four asterisks and two words:

```ts
import { Embed } from 'aurival';

const embed = new Embed({
  title: 'Markdown in the description',
  description:
    '**Bold**, *italic*, ~~strikethrough~~ and `inline code` all render.\n' +
    'Headings render as bold body text, not larger type.',
}).addField('Field name', 'Field value', true);

await ctx.reply({ embeds: [embed] });
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

| cap                                                    | limit                                        |
| ------------------------------------------------------ | -------------------------------------------- |
| embeds per message                                      | 3                                            |
| fields per message                                      | 6, summed across every embed                 |
| buttons per message                                     | 5                                            |
| button label                                            | 24 characters, emoji not counted             |
| button emoji                                            | exactly one unicode emoji                    |
| button style                                            | `primary`, `secondary`, `danger` or `link`   |
| embed description                                       | 1024 characters of raw markdown              |
| link url (button, title, author)                        | 2048 characters, `https://` only             |
| image url (thumbnail, image, author icon, footer icon)  | `https://` only, no length cap               |

One convention, which is ours and not a rule: when one button is the one you want pressed, put
it last. The server and the client never reorder a row — your order is the order the reader
sees — so this is a habit the docs suggest, not something enforced anywhere.

A press comes back as a `button.pressed` event, handled the same way any other event is:

```ts
bot.on('button.pressed', async (ctx) => {
  await ctx.ack();
  if (ctx.button === 'primary') {
    await ctx.reply('You pressed the primary button.');
  }
});
```

The `ctx` there is a `ButtonContext`: `.chat`, `.user`, `.message`, `.button` (the id you set
when building it) and `.interaction`. Call `await ctx.ack()` exactly once per press — a button
is single-use, and acking one a second time doesn't throw locally, the server 409s the request.

The showcase bot runs every one of these cards live. The full set is in the
[cookbook](https://bots.aurival.com/docs/cookbook).

## Buttons only the caller can press

By default nobody is locked: any member in the chat can press a card's buttons, exactly as
before this existed. Pass `forUser` to `reply`, `send`, `edit` or `ack` to lock the press to one
member.

```ts
await ctx.reply('Locked to the caller', { buttons, forUser: ctx.sender });
```

`forUser` takes a `User` (`ctx.sender` is one) or a bare `usr_…` id string. Either one
serializes to the same id on the wire.

Everyone still sees the card and its text. Only the press is gated: a non-caller's buttons
render at `.56` opacity with no checkmark and are not tappable. Nothing is drawn under the
row: the card never says who it is for, so write that into the embed footer yourself if you
want it on the plate. A link button on a locked card stays pressable by anyone. It never
round-trips to the server, so there is nothing for the lock to gate.

A non-caller who presses anyway is refused by the server with a `403`, before anything is
spent. `used` stays unset and the card is unchanged. That refusal never reaches your bot: a bot
never presses a button, so there is no SDK exception for it.

Omitting `forUser` on a `reply`/`edit`/`ack` that replaces a card **keeps the existing lock**.
Passing `forUser: null` **clears** it, and the card opens to everyone. Passing a new id **moves**
the lock to that member. This matters most on `ack`, where a quiz redraws its own card between
questions and must not silently unlock itself by leaving `forUser` out.

A caller-only quiz, start to finish:

```ts
import { Button, Embed } from 'aurival';

bot.command('locked', async (ctx) => {
  const embed = new Embed({
    title: 'Locked to the caller',
    description: 'Everyone sees this card. Only the person who ran the command can press.',
  });
  await ctx.reply({
    embeds: [embed],
    buttons: [new Button({ label: 'Only the caller presses', id: 'only', style: 'primary' })],
    forUser: ctx.sender,
  });
});

bot.on('button.pressed', async (ctx) => {
  await ctx.ack({ text: 'Pressed.', buttons: [] });
});
```

`ButtonContext` carries no `forUser` field. The presser is always the locked user by
construction: the server refuses everyone else before your handler ever runs, so there is
nothing on the press for it to expose. If you need the lock on a card you are acking, you
already have it: you set it on the send.

## Cooldowns

A cooldown paces a command or a button. You attach it, the SDK keeps the bucket, and the wire
never carries it — the server does not know one exists.

```ts
import { Bot, Cooldown } from 'aurival';

const bot = new Bot();                      // buttonCooldown: Cooldown(1, 2) already

bot.command('roll', { cooldown: { rate: 1, per: 5 } }, async (ctx) => { /* … */ });
bot.command('leaderboard', { cooldown: new Cooldown(3, 60, 'chat') }, async (ctx) => { /* … */ });
```

**`per` is seconds, not milliseconds.** That is deliberate and it is the one place this SDK
departs from JS habit: `AurivalAPIError.retryAfter` is already seconds, and a developer who
catches one and a developer who writes a cooldown should not hold two meanings of one number.

The options object is a third form of `command()`. The two you already use —
`command(name, handler)` and `command(name, description, handler)` — are untouched, and
`description` is a field on the options object when you want all three.

Three buckets, and each one says who shares the limit:

| bucket             | key                            | reads as                                        |
| ------------------ | ------------------------------ | ----------------------------------------------- |
| `user` (default)   | the invoking or pressing user  | each person gets one every N seconds            |
| `chat`             | the conversation               | this chat gets one every N seconds, whoever asks |
| `global`           | nothing                        | this bot answers one every N seconds, everywhere |

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

```ts
bot.onCooldown(async (ctx, retryAfter) => {          // bot-level
  await ctx.reply(`easy, ${Math.ceil(retryAfter)}s`);
});

bot.command('roll', { cooldown: { rate: 1, per: 5 }, onCooldown }, handler); // this one wins
```

`retryAfter` is seconds remaining, unrounded. The hook is called once per bucket per window too,
so replacing the sentence does not re-introduce the spam it existed to stop.

### Buttons already have one

Every bot ships with `Cooldown(1, 2, 'user')` on its buttons, without asking: one press every two
seconds per person, one bucket per person per bot. A press inside the window is answered rather
than handled — the presser's pending ink clears and their device shows a toast — and the button
stays live, because a cooldown is a wait, not a spend.

Override it where it belongs, and precedence is button, then card, then the bot default:

```ts
const bot = new Bot({ buttonCooldown: { rate: 1, per: 5 } }); // this bot's buttons
await ctx.reply({ buttons, buttonCooldown: null });           // this card's buttons, off
new Button({ label: 'Primary action', cooldown: null });      // this one button, off
```

A per-card or per-button cooldown gets its own buckets, keyed on the message, the button id and
the bucket subject — button ids are unique within a message and nowhere else, so two cards that
both call a button `roll` never share a limit. `null` disables at any level.

A button cooldown is at most 60 seconds and is refused where you write it, not later inside an
ack you cannot see. Command cooldowns have no cap: `{ rate: 1, per: 3600 }` on a command is a
legitimate once an hour.

Link buttons are outside all of this — a link opens on the device and never round-trips, so it
cannot carry a cooldown and `Button.link` has no `cooldown` field.

### Keep one Cooldown per button

A `Cooldown` owns its own bucket of remaining presses. Build a fresh one inside the ack handler —
or anywhere a press can re-run it — and it forgets every prior press, so the cooldown never
actually triggers. Define the `Cooldown` and the `Button` once, at module scope, and reuse those
same objects on the send and on every ack that follows it:

```ts
// Once, at module scope — not inside the handler.
const cooldown = new Cooldown(1, 10);
const button = new Button({ label: '+1', id: 'inc', style: 'primary', cooldown });

bot.on('button.pressed', async (ctx) => {
  await ctx.ack({ buttons: [button] });   // the same button, never rebuilt here
});
```

### The caveat, said plainly

**Buckets are process memory.** They reset on restart, and they are not shared between
instances: a bot running two processes has two independent buckets, and a deploy clears every
bucket it had. Cooldowns pace a conversation. They are not a quota, and they are not the abuse
bound — the server keeps its own floor underneath them.

## Upgrading from 0.2.x

There is one `Context` per event family now, instead of one class for every event with most of
its fields `null`. Three things change in code you already wrote.

`ctx.sender` in a command handler is a `User` again, not `User | null`. The narrowing 0.2.0
asked for was an artefact of the shared class — the server never sends a command without a
sender, and now the type says so. Drop the guard:

```ts
bot.command('thanks', async (ctx) => {
  // 0.2.x — if (!ctx.sender) return;
  await ctx.reply(`thanks, ${ctx.sender.handle}!`);
});
```

`ctx.user`, `ctx.actor` and `ctx.emoji` no longer exist on `Context`. They live on the class for
the family that actually delivers them, where they are never `null`, so an optional read becomes
a plain one:

```ts
bot.on('member.joined', async (ctx) => {
  // 0.2.x — ctx.user?.handle
  console.log(ctx.user.handle, 'joined');
});
```

`Context.fromGenericEvent()` is gone, and nothing replaces it. Choosing the class for an event
is the SDK's job, not yours — where 0.2.x called `Context.fromGenericEvent(event, http)`, 0.3.0
calls nothing, because `bot.on()` hands your handler the right context already built.

One thing that is not a break, but is worth knowing if you pinned to it: `version` reports
`'0.3.0'`. In 0.2.1 it still said `'0.2.0'`, which was simply wrong; a test pins it to
`package.json` now, so it cannot drift again.

### Upgrading from 0.3.x

`Embed`, `Button` and `ButtonContext` are new in 0.4.0. None of it is a break: `reply()` and
`send()` gained an `embeds` and a `buttons` field on their options object, both optional, so
calls that never mention them behave exactly as they did on 0.3.x.

`Message` gained three new fields — `embeds`, `buttons` and `buttonUsed` — all of which default
to an empty array (or `null` for `buttonUsed`) on a message that never carried any, so existing
code reading other `Message` fields is unaffected.

`bot.on('button.pressed', ...)` is a new event a bot can opt into; a bot that never registers a
handler for it simply never receives one.

### Upgrading from 0.4.x

Everything 0.5.0 adds to a card is optional: `url` on the `Embed` init object and as the third
argument to `setAuthor`, the second argument to `setFooter`, `emoji` and `url` on `Button`, and
the `Button.link` constructor. A card that uses none of them serialises exactly as it did on
0.4.0 — same keys, same bytes, no `url: null` where there was nothing before — so a bot you
wrote against 0.4.0 needs no edit at all.

`'link'` is a real button style now, where 0.4.0 refused it with `link buttons are not supported
in v1`. Build one with `Button.link({ label, url })`; that static is the sanctioned constructor, and it sets the
style for you.

A link button is not an action button wearing a url. It never produces a `button.pressed` event,
it never flips `used`, and it is not disabled by a sibling being pending or used — so a row can
go cold around a link and the link still works. If you were counting on every button in a row
answering back, count only the ones you did not build with `Button.link`.

### Upgrading from 0.5.x

0.6.0 adds optional fields in two places and takes nothing away. `ctx.edit()` takes an init
object next to the message, and `ctx.ack()` takes one too, so a press can answer by replacing the
card it was pressed on instead of stacking a second message under it. A bot written against
0.5.0 needs no edit at all: `await ctx.edit(sent, 'done!')` still takes a plain string, and a
bare `await ctx.ack()` sends exactly the bytes it sent before.

Three states, one rule, on both doors:

- leave a field out and that part of the card is kept as it was
- pass a value and that part is replaced
- pass `[]` or `null` and that part is cleared — both go on the wire as `"embeds": null`

`text` is not clearable, because a card always carries text and `''` already means empty. An edit
with all three left out throws `an edit needs text, embeds or buttons` before anything is sent,
and the server answers the same sentence as `NothingToEdit`.

Pressing a button is the whole feature in one pair of handlers. Both cards earn their plate: the
first card carries buttons, the replacement carries the result.

```ts
import { Button, Embed } from 'aurival';

bot.command('update', async (ctx) => {
  const embed = new Embed({ title: 'Press a button', description: 'The card is replaced in place when you press one.' });
  const buttons = [
    new Button({ label: 'Press me, card updates', id: 'u1', style: 'primary' }),
    new Button({ label: 'Or press me', id: 'u2', style: 'secondary' }),
  ];
  await ctx.reply({ embeds: [embed], buttons });
});

bot.on('button.pressed', async (ctx) => {
  const which = ctx.button === 'u1' ? 'first' : 'second';
  const result = new Embed({
    title: `You pressed the ${which} button`,
    description: 'ack() replaced the card in place. Nothing else in the chat moved.',
  });
  await ctx.ack({
    embeds: [result],
    buttons: [new Button({ label: 'Press again', id: 'again', style: 'primary' })],
  });
});
```

The ack and the replacement are one request. The question card becomes the result card in place,
the `Play again` row starts unused, and the message is not marked edited — an interaction
response is the bot answering the presser, not the author correcting themselves. Reusing button
ids across replacements is allowed and safe: the server keys the refusal on the interaction, not
on the id.

`edit()` is the other door and it does mark the message edited, so a card can redraw itself
outside a press:

```ts
await ctx.edit(sent, { embeds: [new Embed({ title: 'Title' })] });
await ctx.edit(sent, { buttons: [] });   // the row is gone, the plate stays
```

### Upgrading from 0.6.x

0.7.0 adds cooldowns and takes nothing away. `Cooldown` is a new export, `command()` gained a
third options form, `Bot` gained `buttonCooldown`, `reply()`/`send()` gained `buttonCooldown`,
and `Button` gained `cooldown`. Every one of them has a default that keeps 0.6.0 behaviour, with
**one exception you should know about**: buttons now carry `Cooldown(1, 2, 'user')` by default,
so a member cannot press the same bot's buttons faster than once every two seconds. That is
deliberate and it is on by default. If your bot's buttons are something a member is meant to
mash, turn it off explicitly:

```ts
const bot = new Bot({ buttonCooldown: null });
```

Both existing `command()` overloads keep their exact signatures, so no call you have written
changes shape.

Two new error classes ship with it, `CooldownWithBody` and `CooldownRetryAfterInvalid`, both
`InvalidRequestError`. You will not normally see either: the SDK builds the cooldown ack itself
and refuses an out-of-range button cooldown where you write it.

### Upgrading from 0.8.x

0.9.0 adds new per-field and per-embed caps, and **one of them can break a card that worked on
0.8.x**: none of these fields were length-limited before, so a card built past one of the new
limits used to send successfully and now throws. `Embed.addField`, `setAuthor` and `setFooter`
check length locally as of this version, before any round trip:

- an embed field name is at most 256 characters
- an embed field value is at most 1024 characters
- an embed author name is at most 256 characters
- an embed footer's text is at most 2048 characters
- `setImage` and `setThumbnail` urls are at most 2048 characters (author and footer icons
  stay uncapped)
- the embeds on one message carry at most 6000 characters in total, summed across every
  title, description, field name and value, author name and footer text — checked when the
  message is sent, since it spans every embed, not one

A card that never approaches these sizes is unaffected. One built past a limit now throws
locally, with the same sentence the server used to send back as a 400 — the SDK catches it
before the round trip instead of after. The server enforces the identical caps independently
of SDK version, so a bot on an older SDK sees the 400 from the wire the moment this ships, not
only on upgrade. Six matching error classes ship for the wire-error path, all
`InvalidRequestError`: `EmbedFieldNameTooLong`, `EmbedFieldValueTooLong`,
`EmbedAuthorNameTooLong`, `EmbedFooterTextTooLong`, `ImageURLTooLong` and `EmbedsTooLong`.

`mentions` got stricter too, and this is also a server-side change that applies regardless of
SDK version: a `@handle` token that appears only inside a code block or inline code no longer
satisfies the mention, and the server answers `mention_token_missing` the same way it always
has for a missing token — write the handle into `text` yourself, in plain text, outside any
fence or backtick.

Two fixes land alongside the caps: `ctx.edit(sent, { forUser: null })` with no other part
named is now a real edit that reaches the wire as `{ "for_user": null }`, rather than being
refused locally before the round trip — naming only the lock is a real change to the card.
And a successful button-cooldown ack now logs one `info` line naming the message, the button,
the presser and the window, so a cooldown firing and a press silently vanishing no longer look
identical from the outside.

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

## Command aliases

`aliases` on `bot.command(...)` gives one command several spellings, all handled by the same
function. `/roll` and `/r` fire the same handler, share the same cooldown bucket, and are one
command everywhere the server or the app talks about it.

```ts
bot.command('roll', { description: 'Roll dice', aliases: ['r'] }, async (ctx) => {
  await ctx.reply(`/${ctx.invokedAs} ran ${ctx.command}, dice rolled`);
});
```

`ctx.command` is always the canonical name, `'roll'`, whichever spelling fired the handler.
`ctx.invokedAs` is the token the human actually typed, lowercased: `'roll'` or `'r'`. They are
equal on a canonical call. Code that checks `ctx.command === 'roll'` keeps working no matter
which spelling reached it.

The options object also takes `cooldown`, same as any other command. It is one bucket, keyed on
the canonical name, shared across every spelling:

```ts
bot.command('roll', { description: 'Roll dice', aliases: ['r'], cooldown: { rate: 1, per: 5 } }, handler);
```

At most three aliases per command. A fourth throws locally, before anything is synced. It is the
same validation path as a bad command name: lowercase letters, digits, hyphens and underscores
only, and none of the reserved names (`help`, `report`, `block`, `mute`, `kick`, `ban`, `admin`,
`staff`, `support`, `aurival`).

The cooldown notice echoes the typed token: hit the limit through `/r` and you get `Slow down.
Try /r again in 3 s.`, never `/roll`.

In the app, the command picker lists a command's aliases as a muted secondary line under its
row: `also /r`. Picking a row that matched by alias fills that alias, not the canonical
spelling: typing `/r` and picking the row inserts `/r `, not `/roll `.

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
aurival@0.3.0
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
