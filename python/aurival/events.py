"""Plain data a handler receives (CONTRACT-V1 §3, §3.1).

`Event` is the raw wire frame; a context is what `bot.py` hands to a handler,
built from one. A context holds an `HttpClient` for its actions and nothing
else network-shaped — never the seed, a token, or the `Auth` object (SDK-33).

One context class per event family (BA-R68, reversing AMENDMENT-04's one-class
rule): `Context` for `command.invoked`, `MemberContext` for `member.*`,
`BotContext` for `bot.*`, `ReactionContext` for `reaction.added`, and
`EventContext` for a type this SDK does not know yet. Each class declares only
the fields its event actually carries, so autocomplete shows what is there and
nothing that is always empty, and a field the contract guarantees is typed as
present rather than `| None`.
"""

from __future__ import annotations

import contextlib
import dataclasses
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Literal

from .caps import EMPTY_MESSAGE, NOTHING_TO_EDIT
from .cooldown import UNSET, Cooldown, CooldownSpec, validate_button_cooldown
from .embeds import (
    Button,
    ButtonLike,
    ButtonUsed,
    Embed,
    EmbedLike,
    resolve_buttons,
    serialise_buttons,
    serialise_embeds,
)
from .errors import AurivalError
from .http import OMITTED, Omitted

if TYPE_CHECKING:
    from aurival.http import HttpClient

# The five generic event types this SDK knows the shape of. `bot.on("` completes
# these; a type outside the set still registers (see `Bot.on`) and gets an
# `EventContext`.
MemberEventType = Literal["member.joined", "member.left"]
BotEventType = Literal["bot.added", "bot.removed"]
ReactionEventType = Literal["reaction.added"]
ButtonEventType = Literal["button.pressed"]
EventType = Literal[
    "member.joined",
    "member.left",
    "bot.added",
    "bot.removed",
    "reaction.added",
    "button.pressed",
]


@dataclasses.dataclass(frozen=True)
class User:
    id: str
    handle: str
    name: str


@dataclasses.dataclass(frozen=True)
class Chat:
    id: str
    type: str
    name: str | None
    # Live participants, bots included. `None` when the frame carries no key
    # (R5) — existing fixtures that never set it stay green — never defaulted
    # to 0, which would claim knowledge we don't have.
    member_count: int | None = None


@dataclasses.dataclass(frozen=True)
class Mention:
    """One `mentions` entry, built by `mention(user)`. `.token` is the literal
    `@handle` text to splice into `text` (never `@{handle}` — braces are
    notation only); `.entry` is the wire shape `POST /v1/messages` expects."""

    token: str
    entry: dict[str, str]

    def __str__(self) -> str:
        return self.token


def mention(user: User) -> Mention:
    """`@` + the user's handle, ready to drop into an f-string, plus the entry
    `send(mentions=[...])` needs. The token has to appear in `text` or the
    server refuses the send."""
    return Mention(token=f"@{user.handle}", entry={"user": user.id})


@dataclasses.dataclass(frozen=True)
class MemberPage:
    """One page of `GET /v1/chats/{chat}/members` — never auto-loads the rest
    (R9). `has_more` is the caller's signal for "is there another page", read
    straight off the envelope (CONTRACT-V1 §4) rather than inferred from a
    short page or from `next_cursor` alone — the off-by-one that inference
    invites is exactly what `has_more` exists to avoid. `next_cursor` is
    `None` whenever `has_more` is `False` (§2.1)."""

    users: list[User]
    has_more: bool
    next_cursor: str | None


@dataclasses.dataclass(frozen=True)
class Command:
    name: str
    description: str


@dataclasses.dataclass(frozen=True)
class Message:
    id: str
    text: str
    sent_at: str
    sender: User | None
    reply_to: str | None
    embeds: list[Embed] = dataclasses.field(default_factory=list)
    buttons: list[Button] = dataclasses.field(default_factory=list)
    button_used: ButtonUsed | None = None


@dataclasses.dataclass(frozen=True)
class Event:
    id: str
    type: str
    created_at: str
    sequence: int
    data: dict[str, object]

    @classmethod
    def from_frame(cls, d: dict[str, object]) -> Event:
        """`d` is one WireEvent (`{object, id, type, created_at, sequence,
        data}`) — the `event` frame's payload, top-level, not re-wrapped."""
        data = d.get("data")
        seq = d.get("sequence")
        return cls(
            id=str(d.get("id", "")),
            type=str(d.get("type", "")),
            created_at=str(d.get("created_at", "")),
            sequence=int(seq) if isinstance(seq, (int, float, str)) and seq else 0,
            data=data if isinstance(data, dict) else {},
        )


def _user_from_wire(d: dict[str, object]) -> User:
    return User(
        id=str(d.get("id", "")), handle=str(d.get("handle", "")), name=str(d.get("name", ""))
    )


def _chat_from_wire(d: dict[str, object]) -> Chat:
    name = d.get("name")
    member_count = d.get("member_count")
    # `bool` is an `int` subclass in Python — `isinstance(True, int)` is
    # `True` — so a stray boolean would otherwise silently become a member
    # count of 0 or 1. Rejected explicitly rather than trusted.
    return Chat(
        id=str(d.get("id", "")),
        type=str(d.get("type", "")),
        name=name if isinstance(name, str) else None,
        member_count=member_count
        if isinstance(member_count, int) and not isinstance(member_count, bool)
        else None,
    )


def _chat_field(data: dict[str, object]) -> Chat:
    """`ctx.chat` is never optional (CONTRACT-V1 §3.1: every payload has one)
    — an absent or malformed `chat` key still yields a `Chat`, just an empty
    one, rather than widening the typed surface to `Chat | None`."""
    chat = data.get("chat")
    return _chat_from_wire(chat if isinstance(chat, dict) else {})


def _user_field(data: dict[str, object], key: str) -> User:
    """Same rule as `_chat_field`, for a `user` the contract guarantees: an
    absent or malformed entry yields an empty `User`, never `None`."""
    value = data.get(key)
    return _user_from_wire(value if isinstance(value, dict) else {})


def _user_from_wire_opt(d: object) -> User | None:
    return _user_from_wire(d) if isinstance(d, dict) else None


def _message_from_ref(v: object) -> Message | None:
    """A `reaction.added` frame's `message` is a bare `msg_…` id, not an
    object — unlike `command.invoked`'s `invoking_message`. §3.1: this is
    always a reference string in this position, never a full object."""
    if isinstance(v, str):
        return Message(
            id=v,
            text="",
            sent_at="",
            sender=None,
            reply_to=None,
            embeds=[],
            buttons=[],
            button_used=None,
        )
    return None


_EMPTY_MESSAGE = Message(
    id="", text="", sent_at="", sender=None, reply_to=None, embeds=[], buttons=[], button_used=None
)


def _embeds_from_wire(v: object) -> list[Embed]:
    # `embeds`/`buttons` are ALWAYS present on the wire and `null` when unused
    # (AMENDMENT-05 §3, CONTRACT-V1 §2.1 nullable list) — a 0.3.x-era server
    # omits the key entirely. `null` and absent decode identically to `[]`;
    # `None` must never reach `Message.embeds`/`.buttons`.
    if not isinstance(v, list):
        return []
    return [Embed.from_dict(e) for e in v if isinstance(e, dict)]


def _buttons_from_wire(v: object) -> list[Button]:
    if not isinstance(v, list):
        return []
    return [Button.from_dict(b) for b in v if isinstance(b, dict)]


def _button_used_from_wire(v: object) -> ButtonUsed | None:
    return ButtonUsed.from_dict(v) if isinstance(v, dict) else None


def _require_something_to_say(
    text: str, embeds: list[dict[str, object]], buttons: list[dict[str, object]]
) -> None:
    """A send with nothing in it is refused here, before the round trip — the
    server would answer `empty_text`, and an embed-only send is legal, so the
    precondition is "text OR embeds OR buttons", not "text"."""
    if not text and not embeds and not buttons:
        raise ValueError(EMPTY_MESSAGE)


def _embeds_part(embeds: list[EmbedLike] | None) -> list[dict[str, object]] | Omitted | None:
    """Turn the `embeds` a caller passed to `edit`/`ack` into one of the three
    states the wire knows (AMENDMENT-07 §9).

    `None` means the caller never named the part, so it is `OMITTED` and the
    key never reaches the body. `[]` is the SDK's spelling of "clear", so it
    becomes a real `None` and goes out as `"embeds": null`. The empty case has
    to be decided here, on the caller's own list, rather than after
    serialising: `serialise_embeds([])` returns `[]`, not `None`, so a clear
    routed through it would be indistinguishable from "nothing to send".
    """
    if embeds is None:
        return OMITTED
    if not embeds:
        return None
    return serialise_embeds(embeds)


def _buttons_part(buttons: list[ButtonLike] | None) -> list[dict[str, object]] | Omitted | None:
    """`_embeds_part` for the button row: `None` omits, `[]` clears the row to
    `"buttons": null`, a non-empty list is serialised exactly as `send` does."""
    if buttons is None:
        return OMITTED
    if not buttons:
        return None
    return serialise_buttons(buttons)


def _resolve_and_validate_buttons(
    buttons: list[ButtonLike] | None, button_cooldown: CooldownSpec
) -> tuple[list[Button], list[dict[str, object]]]:
    """Shared by `reply`/`send`: resolve builders/dicts to `Button` objects —
    AMENDMENT-08's cooldown table needs each one's `.id`/`.cooldown`, not
    only the serialised dict `serialise_buttons` returns — and validate a
    card-level `button_cooldown`'s 60-second bound at attachment time, before
    the round trip (AMENDMENT-08 §5.1 D12)."""
    if isinstance(button_cooldown, Cooldown):
        validate_button_cooldown(button_cooldown)
    resolved = resolve_buttons(buttons)
    return resolved, [b.to_dict() for b in resolved]


def _record_button_cooldowns(
    http: HttpClient,
    message_id: str,
    button_cooldown: CooldownSpec,
    resolved_buttons: list[Button],
) -> None:
    """AMENDMENT-08 §3's card lookup table: a `button.pressed` event carries
    only ids, so `send()`/`reply()`/`edit()`/`ack()` record what was attached
    here, keyed by the message id, for the press dispatch to resolve
    precedence from later. Only worth recording when there are buttons for a
    press to ever resolve against."""
    if resolved_buttons:
        http.cooldowns.record(
            message_id, button_cooldown, {b.id: b.cooldown for b in resolved_buttons}
        )


def _ref_id(x: object) -> str:
    """Accepts a bare id string or anything with a plain `.id` attribute
    (`Message`, `Chat`) — the shape every action method below takes for its
    target."""
    return x if isinstance(x, str) else x.id  # type: ignore[attr-defined]


def _mention_entry(m: object) -> dict[str, str]:
    if isinstance(m, Mention):
        return dict(m.entry)
    if isinstance(m, User):
        return {"user": m.id}
    if isinstance(m, dict):
        return {str(k): str(v) for k, v in m.items()}
    raise TypeError(f"mentions entries must be Mention, User, or dict, got {type(m)!r}")


def _message_from_wire(d: dict[str, object]) -> Message:
    """Both message shapes on the wire (CONTRACT-V1 §2): the inlined
    `invoking_message` (`sent_at`, `sender` a full user) and the stored
    `message` entity every write returns (`created_at`, `sender` a bare
    `usr_…` id — the bot's own, so it becomes an id-only `User`)."""
    reply_to = d.get("reply_to")
    sender = d.get("sender")
    if isinstance(sender, dict):
        who: User | None = _user_from_wire(sender)
    elif isinstance(sender, str) and sender:
        who = User(id=sender, handle="", name="")
    else:
        who = None
    sent_at = d.get("sent_at")
    if not isinstance(sent_at, str):
        sent_at = d.get("created_at")
    return Message(
        id=str(d.get("id", "")),
        text=str(d.get("text", "")),
        sent_at=sent_at if isinstance(sent_at, str) else "",
        sender=who,
        reply_to=reply_to if isinstance(reply_to, str) else None,
        embeds=_embeds_from_wire(d.get("embeds")),
        buttons=_buttons_from_wire(d.get("buttons")),
        button_used=_button_used_from_wire(d.get("button_used")),
    )


class BaseContext:
    """What every handler receives, whatever the event: the `chat` it happened
    in, the raw `event`, and every action the bot can take. The per-event
    subclasses below add the fields their event actually carries.

    `chat` is always populated — CONTRACT-V1 §3.1 gives every payload one —
    so it is a plain `Chat`, never `Chat | None`.
    """

    def __init__(self, *, event: Event, http: HttpClient, chat: Chat) -> None:
        self.event = event
        self.chat = chat
        self._http = http

    def _quotes(self) -> str | None:
        """The message id `reply()` quotes, or `None` to send a plain message.
        Overridden by the contexts that carry a message."""
        return None

    async def reply(
        self,
        text: str = "",
        *,
        embeds: list[EmbedLike] | None = None,
        buttons: list[ButtonLike] | None = None,
        button_cooldown: CooldownSpec = UNSET,
    ) -> Message:
        """Send `text` to this chat, quoting the message the event was about
        when it carried one (BA-R27, reversing SDK-30) — `ctx.reply()` in a
        command handler quotes the invoking message, in a reaction handler the
        message that was reacted to, and in a membership handler it sends a
        plain message because there is nothing to quote. One method, no flag.
        Pass `embeds`/`buttons` to attach a card — `text` is optional when
        either is present, so `ctx.reply(embeds=[card])` is an embed-only
        reply. Returns the `Message` the server stored.

        `button_cooldown` (AMENDMENT-08 §3) sets the cooldown every button on
        this card inherits, unless a button names its own — tri-state: leave
        it unset to inherit the bot's default, pass `None` to disable it for
        this card, or pass a `Cooldown`. Bounded to 60 seconds, validated
        before the round trip.

        A fresh `Idempotency-Key` per call, reused across that call's retries
        by `HttpClient.request` itself.
        """
        body: dict[str, object] = {"chat": self.chat.id, "text": text}
        # OMITTED, NEVER null. `reply_to` is an optional request parameter, and
        # the server 404s anything that is not a decodable `msg_…` — including
        # an explicit null — with the same `not_found` an unresolvable id gets
        # (server.go:943-953). So an event with no message id must send no key,
        # not an empty one, or every reply to it fails as a missing message.
        quoted = self._quotes()
        if quoted:
            body["reply_to"] = quoted
        serialised_embeds = serialise_embeds(embeds)
        if serialised_embeds:
            body["embeds"] = serialised_embeds
        resolved_buttons, serialised_buttons = _resolve_and_validate_buttons(
            buttons, button_cooldown
        )
        if serialised_buttons:
            body["buttons"] = serialised_buttons
        _require_something_to_say(text, serialised_embeds, serialised_buttons)
        response = await self._http.request(
            "POST",
            "/v1/messages",
            body=body,
            idempotency_key=str(uuid.uuid4()),
        )
        message = _message_from_wire(response)
        _record_button_cooldowns(self._http, message.id, button_cooldown, resolved_buttons)
        return message

    async def send(
        self,
        chat: Chat | str,
        text: str = "",
        *,
        mentions: list[Mention | User | dict[str, str]] | None = None,
        embeds: list[EmbedLike] | None = None,
        buttons: list[ButtonLike] | None = None,
        button_cooldown: CooldownSpec = UNSET,
    ) -> Message:
        """Post `text` to any chat the bot is in — `ctx.chat` or another one —
        as a plain message, never quoting. Pass `mentions` to @-mention
        people: each entry is a `Mention` from `mention(user)`, a bare `User`,
        or `{"user": "usr_…"}`, and its `@handle` token has to appear in
        `text` or the server refuses the send. Pass `embeds`/`buttons` to
        attach a card — `text` is optional when either is present, so
        `ctx.send(chat, embeds=[card])` is an embed-only message. Returns
        the `Message` the server stored.

        `button_cooldown` is the card-level cooldown every button on this
        card inherits unless it names its own — same tri-state rule as
        `reply()`'s (AMENDMENT-08 §3)."""
        entries = [_mention_entry(m) for m in mentions] if mentions is not None else None
        serialised_embeds = serialise_embeds(embeds)
        resolved_buttons, serialised_buttons = _resolve_and_validate_buttons(
            buttons, button_cooldown
        )
        _require_something_to_say(text, serialised_embeds, serialised_buttons)
        response = await self._http.send_message(
            _ref_id(chat),
            text,
            idempotency_key=str(uuid.uuid4()),
            mentions=entries,
            embeds=serialised_embeds,
            buttons=serialised_buttons,
        )
        message = _message_from_wire(response)
        _record_button_cooldowns(self._http, message.id, button_cooldown, resolved_buttons)
        return message

    def typing(self) -> contextlib.AbstractAsyncContextManager[None]:
        """`async with ctx.typing():` — shows the chat that the bot is thinking
        for as long as the block runs: sends `is_typing: true` on enter and
        `is_typing: false` on exit, always, including on exception. A command
        handler gets this automatically after 300 ms (`Bot(auto_typing=True)`,
        the default), so reach for it when you want the indicator up from the
        first instant, or outside a command."""
        if not self.chat.id:
            # A real precondition a caller can trip in production (an event
            # type the SDK didn't recognize yet, so `chat` came back empty) —
            # `assert` would vanish under `python -O` and turn this into a
            # bare `None`/empty-string AttributeError deep inside `http`.
            raise AurivalError("ctx.typing() needs a chat, and this event has none")
        chat_id = self.chat.id
        http = self._http

        @contextlib.asynccontextmanager
        async def _cm() -> AsyncIterator[None]:
            await http.set_typing(chat_id, True)
            try:
                yield
            finally:
                await http.set_typing(chat_id, False)

        return _cm()

    async def edit(
        self,
        msg: Message | str,
        text: str | None = None,
        *,
        embeds: list[EmbedLike] | None = None,
        buttons: list[ButtonLike] | None = None,
    ) -> Message:
        """Replace part of a message the bot sent — `ctx.edit(sent,
        "corrected")` where `sent` is what `reply()` or `send()` returned, or
        its id. Only the bot's own messages: editing anyone else's answers
        `MessageNotYours`. Returns the updated `Message`.

        `text`, `embeds` and `buttons` are each optional and each replaces only
        the part it names; a part you leave out is kept as it is, so a
        countdown card can rewrite its embed without restating its buttons
        (AMENDMENT-07 §2). `None` means "not present", which is why it cannot
        also mean "clear": **an empty list clears**, so `embeds=[]` takes the
        embeds off the card and `buttons=[]` takes the row off. `text=""` is a
        real value, not an absence — a card may carry empty text, and only an
        edit whose merged result has nothing left in it is refused as empty.
        Naming none of the three is refused here, before the round trip.

        There is no `button_cooldown` parameter here — AMENDMENT-08 §3 names
        `send()` as the card-level attachment point. When `buttons` replaces
        the row, each button's own `Button(cooldown=)` still carries through
        to AMENDMENT-08's lookup table; the card level for this edit is
        `UNSET` (inherits the bot default), same as an untouched card would."""
        if text is None and embeds is None and buttons is None:
            raise ValueError(NOTHING_TO_EDIT)
        resolved_buttons = resolve_buttons(buttons) if buttons else []
        response = await self._http.edit_message(
            _ref_id(msg),
            text,
            embeds=_embeds_part(embeds),
            buttons=_buttons_part(buttons),
        )
        message = _message_from_wire(response)
        _record_button_cooldowns(self._http, message.id, UNSET, resolved_buttons)
        return message

    async def delete(self, msg: Message | str) -> None:
        """Delete a message the bot sent, by `Message` or id. Only the bot's
        own: deleting anyone else's answers `MessageNotYours`."""
        await self._http.delete_message(_ref_id(msg))

    async def react(self, msg: Message | str, emoji: str) -> None:
        """Put `emoji` on a message, by `Message` or id — any message in a chat
        the bot is in, not only its own. Idempotent: reacting twice with the
        same emoji leaves one reaction, never toggles it off."""
        await self._http.set_reaction(_ref_id(msg), emoji)

    async def unreact(self, msg: Message | str, emoji: str) -> None:
        """Take the bot's `emoji` reaction off a message, by `Message` or id.
        Idempotent: removing a reaction that is not there is not an error."""
        await self._http.unset_reaction(_ref_id(msg), emoji)

    async def members(
        self, chat: Chat | str | None = None, cursor: str | None = None
    ) -> MemberPage:
        """One page of who is in a chat — `ctx.chat` unless you pass another —
        bots included, as `User`s. Never auto-loads the rest: check
        `page.has_more` and pass `cursor=page.next_cursor` for the next page.
        `ctx.chat.member_count` already carries the total, so this is for the
        names, not the size."""
        target = chat if chat is not None else self.chat
        target_id = _ref_id(target)
        if not target_id:
            raise AurivalError(
                "ctx.members() needs a chat: pass one, or call it where ctx.chat is already set"
            )
        response = await self._http.list_members(target_id, cursor=cursor)
        data = response.get("data")
        users = (
            [_user_from_wire(u) for u in data if isinstance(u, dict)]
            if isinstance(data, list)
            else []
        )
        has_more = bool(response.get("has_more"))
        next_cursor = response.get("next_cursor")
        return MemberPage(
            users=users,
            has_more=has_more,
            # §2.1: `next_cursor` is `null` whenever `has_more` is `false` —
            # forced here rather than trusted from the wire, so a
            # spec-violating server can never hand a caller a cursor to a
            # page that doesn't exist.
            next_cursor=next_cursor if has_more and isinstance(next_cursor, str) else None,
        )


class Context(BaseContext):
    """What a `@bot.command` handler receives: the `command` that was run, its
    `arguments`, the `sender` who ran it, and the invoking `message` in full.
    `sender` and `message` are always present — `command.invoked` always
    carries both — so there is nothing to narrow before reading `.handle` or
    `.text`.
    """

    def __init__(
        self,
        *,
        event: Event,
        http: HttpClient,
        chat: Chat,
        command: str = "",
        arguments: str = "",
        sender: User | None = None,
        message: Message | None = None,
    ) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.command = command
        self.arguments = arguments
        self.sender: User = sender if sender is not None else _user_from_wire({})
        self.message: Message = message if message is not None else _EMPTY_MESSAGE

    def _quotes(self) -> str | None:
        return self.message.id or None

    @classmethod
    def from_event(cls, event: Event, *, http: HttpClient) -> Context:
        """Build from a `command.invoked` event's raw `data` (CONTRACT-V1 §3.1)."""
        data = event.data
        # BA-R42: the invoking message travels with the event as a full
        # object under `invoking_message`. Prefer that. But `message` (the
        # bare id string) is UNCHANGED wire compatibility — an old server that
        # has not deployed BA-R42 yet sends only that string, so we fall back
        # to an id-only Message, keeping a new SDK working against an old
        # server.
        invoking = data.get("invoking_message")
        message = (
            _message_from_wire(invoking)
            if isinstance(invoking, dict)
            else _message_from_ref(data.get("message"))
        )
        return cls(
            command=str(data.get("command", "")),
            arguments=str(data.get("arguments", "")),
            chat=_chat_field(data),
            sender=_user_field(data, "sender"),
            message=message,
            event=event,
            http=http,
        )


class MemberContext(BaseContext):
    """What a `member.joined` / `member.left` handler receives: the `user`
    whose membership changed. Group chats only, human members only — a bot
    joining or leaving produces no event, so `ctx.chat.member_count` is the
    only true count, never something to keep by hand."""

    def __init__(self, *, event: Event, http: HttpClient, chat: Chat, user: User) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.user = user


class BotContext(BaseContext):
    """What a `bot.added` / `bot.removed` handler receives: the `actor` who
    added or removed the bot. Called `actor` rather than `sender` or `user`
    because the person did something to the bot, not in the chat."""

    def __init__(self, *, event: Event, http: HttpClient, chat: Chat, actor: User) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.actor = actor


class ReactionContext(BaseContext):
    """What a `reaction.added` handler receives: the `sender` who reacted, the
    `emoji`, and the `message` it landed on — always one of the bot's own,
    and as an id-only `Message` (`.id` set, the rest empty) because the bot
    wrote it and already has it. `ctx.reply()` here quotes that message."""

    def __init__(
        self,
        *,
        event: Event,
        http: HttpClient,
        chat: Chat,
        sender: User,
        message: Message,
        emoji: str,
    ) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.sender = sender
        self.message = message
        self.emoji = emoji

    def _quotes(self) -> str | None:
        return self.message.id or None


class ButtonContext(BaseContext):
    """What a `button.pressed` handler receives: the `user` who pressed it,
    the `button` id, the `interaction` id to `ack()`, and the `message` the
    button was on — id-only (`.id` set, the rest empty), same spirit as
    `ReactionContext`, because the wire carries only a bare id here, not a
    full object. `ctx.reply()` quotes that message."""

    def __init__(
        self,
        *,
        event: Event,
        http: HttpClient,
        chat: Chat,
        user: User,
        message: Message,
        button: str,
        interaction: str,
    ) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.user = user
        self.message = message
        self.button = button
        self.interaction = interaction

    def _quotes(self) -> str | None:
        return self.message.id or None

    async def ack(
        self,
        text: str | None = None,
        *,
        embeds: list[EmbedLike] | None = None,
        buttons: list[ButtonLike] | None = None,
    ) -> None:
        """Acknowledge the button press — `POST /v1/interactions/{id}/ack`,
        204 no body. The interaction id sent is `self.interaction` verbatim,
        the `button.pressed` event's own id (AMENDMENT-05 §3) — no prefix
        rewriting.

        Pass any of `text`, `embeds` or `buttons` and the same request also
        replaces the card the button was on, so a question card becomes its
        result card in one write instead of a second message stacking under it
        (AMENDMENT-07 §3). The clearing rule is `edit`'s: `None` is "not
        present", an empty list clears that part, and a fresh `buttons` row
        starts unused. An ack carrying a card never marks the message edited.
        `ctx.ack()` with no arguments sends no body at all and is
        byte-identical to what 0.5.0 sent.

        No `button_cooldown` parameter, same reasoning as `edit()`'s: when
        `buttons` replaces the row, each button's own `Button(cooldown=)`
        still carries through to AMENDMENT-08's lookup table, at `UNSET`
        card level. There is no way to send a cooldown ack yourself through
        here — that ack is the SDK's own automatic one (§5), never
        developer-facing."""
        resolved_buttons = resolve_buttons(buttons) if buttons else []
        await self._http.ack_interaction(
            self.interaction,
            text,
            embeds=_embeds_part(embeds),
            buttons=_buttons_part(buttons),
        )
        _record_button_cooldowns(self._http, self.message.id, UNSET, resolved_buttons)


class EventContext(BaseContext):
    """What a handler for a type this SDK does not know yet receives. Never
    raises — a bot must keep running against a server that has shipped an
    eighth type — and populates opportunistically from whatever the payload
    recognizably carries under the familiar keys, so every field here is
    optional. "Ignored, not fatal" means you get what's there, not nothing."""

    def __init__(
        self,
        *,
        event: Event,
        http: HttpClient,
        chat: Chat,
        sender: User | None = None,
        user: User | None = None,
        actor: User | None = None,
        message: Message | None = None,
        emoji: str | None = None,
    ) -> None:
        super().__init__(event=event, http=http, chat=chat)
        self.sender = sender
        self.user = user
        self.actor = actor
        self.message = message
        self.emoji = emoji

    def _quotes(self) -> str | None:
        return self.message.id if self.message is not None and self.message.id else None


AnyContext = (
    Context | MemberContext | BotContext | ReactionContext | ButtonContext | EventContext
)


def _chat_field_or_ref(data: dict[str, object]) -> Chat:
    """`button.pressed`'s `chat` is a bare `chat_…` id, not the nested object
    every other event family carries (WIRE SHAPES (d) in the brief) — accept
    either so a future server that widens it back to an object still works."""
    chat = data.get("chat")
    if isinstance(chat, dict):
        return _chat_from_wire(chat)
    if isinstance(chat, str):
        return Chat(id=chat, type="", name=None, member_count=None)
    return Chat(id="", type="", name=None, member_count=None)


def context_for(event: Event, *, http: HttpClient) -> AnyContext:
    """The one place an event becomes a context — `bot.py`'s dispatch calls
    this, `Socket` never constructs one. A known type gets its own class with
    the contract's fields pinned; a stray key on the wire for a known type is
    not surfaced. An unknown type gets `EventContext`."""
    data = event.data
    if event.type == "command.invoked":
        return Context.from_event(event, http=http)
    if event.type in ("member.joined", "member.left"):
        return MemberContext(
            event=event, http=http, chat=_chat_field(data), user=_user_field(data, "user")
        )
    if event.type in ("bot.added", "bot.removed"):
        return BotContext(
            event=event, http=http, chat=_chat_field(data), actor=_user_field(data, "actor")
        )
    if event.type == "reaction.added":
        emoji = data.get("emoji")
        return ReactionContext(
            event=event,
            http=http,
            chat=_chat_field(data),
            sender=_user_field(data, "sender"),
            message=_message_from_ref(data.get("message")) or _EMPTY_MESSAGE,
            emoji=emoji if isinstance(emoji, str) else "",
        )
    if event.type == "button.pressed":
        interaction = data.get("interaction")
        return ButtonContext(
            event=event,
            http=http,
            chat=_chat_field_or_ref(data),
            user=_user_field(data, "user"),
            message=_message_from_ref(data.get("message")) or _EMPTY_MESSAGE,
            button=str(data.get("button", "")),
            interaction=(
                str(interaction) if isinstance(interaction, str) and interaction else event.id
            ),
        )
    emoji = data.get("emoji")
    return EventContext(
        event=event,
        http=http,
        chat=_chat_field(data),
        sender=_user_from_wire_opt(data.get("sender")),
        user=_user_from_wire_opt(data.get("user")),
        actor=_user_from_wire_opt(data.get("actor")),
        message=_message_from_ref(data.get("message")),
        emoji=emoji if isinstance(emoji, str) else None,
    )
