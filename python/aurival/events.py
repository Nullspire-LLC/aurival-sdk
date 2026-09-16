"""Plain data a command handler receives (CONTRACT-V1 §3, §3.1).

`Event` is the raw wire frame; `Context` is what `bot.py` hands to a handler,
built from one. `Context` holds an `HttpClient` for `reply()` and nothing else
network-shaped — never the seed, a token, or the `Auth` object (SDK-33).
"""

from __future__ import annotations

import contextlib
import dataclasses
import uuid
from typing import TYPE_CHECKING

from .errors import AurivalError

if TYPE_CHECKING:
    from aurival.http import HttpClient


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


@dataclasses.dataclass(frozen=True)
class Event:
    id: str
    type: str
    created_at: str
    sequence: int
    data: dict[str, object]

    @classmethod
    def from_frame(cls, d: dict) -> Event:
        """`d` is one WireEvent (`{object, id, type, created_at, sequence,
        data}`) — the `event` frame's payload, top-level, not re-wrapped."""
        data = d.get("data")
        return cls(
            id=str(d.get("id", "")),
            type=str(d.get("type", "")),
            created_at=str(d.get("created_at", "")),
            sequence=int(d.get("sequence") or 0),
            data=data if isinstance(data, dict) else {},
        )


def _user_from_wire(d: dict) -> User:
    return User(
        id=str(d.get("id", "")), handle=str(d.get("handle", "")), name=str(d.get("name", ""))
    )


def _chat_from_wire(d: dict) -> Chat:
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


def _chat_field(data: dict) -> Chat:
    """`Context.chat` is never optional (CONTRACT-V1 §3.1: every payload has
    one) — an absent or malformed `chat` key still yields a `Chat`, just an
    empty one, rather than widening the typed surface to `Chat | None`."""
    chat = data.get("chat")
    return _chat_from_wire(chat if isinstance(chat, dict) else {})


def _user_from_wire_opt(d: object) -> User | None:
    return _user_from_wire(d) if isinstance(d, dict) else None


def _message_from_ref(v: object) -> Message | None:
    """A `reaction.added` frame's `message` is a bare `msg_…` id, not an
    object — unlike `command.invoked`'s `invoking_message`. §3.1: this is
    always a reference string in this position, never a full object."""
    if isinstance(v, str):
        return Message(id=v, text="", sent_at="", sender=None, reply_to=None)
    return None


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
        return m  # type: ignore[return-value]
    raise TypeError(f"mentions entries must be Mention, User, or dict, got {type(m)!r}")


def _message_from_wire(d: dict) -> Message:
    reply_to = d.get("reply_to")
    sender = d.get("sender")
    return Message(
        id=str(d.get("id", "")),
        text=str(d.get("text", "")),
        sent_at=str(d.get("sent_at", "")),
        sender=_user_from_wire(sender) if isinstance(sender, dict) else None,
        reply_to=reply_to if isinstance(reply_to, str) else None,
    )


class Context:
    """What a handler receives. Built by `bot.py`'s dispatch closure from one
    `Event` — `Socket` never constructs one.

    One class for every event type (R6), never a per-event subclass. `chat`
    is always populated — CONTRACT-V1 §3.1 gives every one of the five
    payloads a `chat`, so it stays a plain `Chat`, never `Chat | None`, to
    keep 0.1.8's typed surface (`ctx.chat.id`, `reply()`'s own use of it)
    intact. Everything else — `sender`/`user`/`actor`/`message`/`emoji` —
    is populated for its own event type(s), `None` otherwise. A type the SDK
    doesn't recognize yet still builds a `Context` rather than raising, and
    populates opportunistically from whatever the payload recognizably
    carries under these same keys — "ignored, not fatal" means the developer
    still gets what's there, not nothing.
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
        user: User | None = None,
        actor: User | None = None,
        message: Message | None = None,
        emoji: str | None = None,
    ) -> None:
        self.command = command
        self.arguments = arguments
        self.chat = chat
        self.sender = sender
        self.user = user
        self.actor = actor
        self.event = event
        self.message = message
        self.emoji = emoji
        self._http = http

    @classmethod
    def from_event(cls, event: Event, *, http: HttpClient) -> Context:
        """Build from any event's raw `data` (CONTRACT-V1 §3.1)."""
        data = event.data

        if event.type == "command.invoked":
            return cls(
                command=str(data.get("command", "")),
                arguments=str(data.get("arguments", "")),
                chat=_chat_field(data),
                sender=_user_from_wire(
                    data.get("sender") if isinstance(data.get("sender"), dict) else {}
                ),
                event=event,
                # BA-R42: the invoking message travels with the event as a full
                # object under `invoking_message`. Prefer that. But `message`
                # (the bare id string) is UNCHANGED wire compatibility — an old
                # server that has not deployed BA-R42 yet sends only that string,
                # so we fall back to an id-only Message rather than None, keeping
                # a new SDK working against an old server.
                message=_message_from_wire(data["invoking_message"])
                if isinstance(data.get("invoking_message"), dict)
                else Message(id=data["message"], text="", sent_at="", sender=None, reply_to=None)
                if isinstance(data.get("message"), str)
                else None,
                http=http,
            )

        if event.type in ("member.joined", "member.left"):
            return cls(
                chat=_chat_field(data),
                user=_user_from_wire_opt(data.get("user")),
                event=event,
                http=http,
            )

        if event.type in ("bot.added", "bot.removed"):
            return cls(
                chat=_chat_field(data),
                actor=_user_from_wire_opt(data.get("actor")),
                event=event,
                http=http,
            )

        if event.type == "reaction.added":
            emoji = data.get("emoji")
            return cls(
                chat=_chat_field(data),
                sender=_user_from_wire_opt(data.get("sender")),
                message=_message_from_ref(data.get("message")),
                emoji=emoji if isinstance(emoji, str) else None,
                event=event,
                http=http,
            )

        # Unknown/unhandled type (CONTRACT-V1 §3, §9): never raises — an SDK
        # newer than the server, or older than a future event type, still
        # builds a usable Context. "Ignored, not fatal" means opportunistic,
        # not empty: whatever the payload recognizably carries under these
        # familiar keys is populated exactly as it would be for a known type,
        # so a developer catching an eighth type early still gets what's
        # there rather than nothing.
        emoji = data.get("emoji")
        return cls(
            chat=_chat_field(data),
            sender=_user_from_wire_opt(data.get("sender")),
            user=_user_from_wire_opt(data.get("user")),
            actor=_user_from_wire_opt(data.get("actor")),
            message=_message_from_ref(data.get("message")),
            emoji=emoji if isinstance(emoji, str) else None,
            event=event,
            http=http,
        )

    async def reply(self, text: str) -> dict:
        """`POST /v1/messages`, quoting the message that invoked the command.

        BA-R27, reversing SDK-30: `reply_to` is the invoking message's id, sent
        by default. One method, no flag — a reply that floats free in a busy
        chat is the thing reply-to exists to fix. A fresh `Idempotency-Key` per
        call, reused across that call's retries by `HttpClient.request` itself.
        """
        body: dict[str, str] = {"chat": self.chat.id, "text": text}
        # OMITTED, NEVER null. `reply_to` is an optional request parameter, and
        # the server 404s anything that is not a decodable `msg_…` — including
        # an explicit null — with the same `not_found` an unresolvable id gets
        # (server.go:943-953). So an event with no message id must send no key,
        # not an empty one, or every reply to it fails as a missing message.
        if self.message is not None and self.message.id:
            body["reply_to"] = self.message.id
        return await self._http.request(
            "POST",
            "/v1/messages",
            body=body,
            idempotency_key=str(uuid.uuid4()),
        )

    def typing(self) -> contextlib.AbstractAsyncContextManager[None]:
        """`async with ctx.typing():` — sends `is_typing: true` on enter and
        `is_typing: false` on exit, always, including on exception."""
        if not self.chat.id:
            # A real precondition a caller can trip in production (an event
            # type the SDK didn't recognize yet, so `chat` came back empty) —
            # `assert` would vanish under `python -O` and turn this into a
            # bare `None`/empty-string AttributeError deep inside `http`.
            raise AurivalError("ctx.typing() needs a chat, and this event has none")
        chat_id = self.chat.id
        http = self._http

        @contextlib.asynccontextmanager
        async def _cm():
            await http.set_typing(chat_id, True)
            try:
                yield
            finally:
                await http.set_typing(chat_id, False)

        return _cm()

    async def edit(self, msg: Message | str, text: str) -> dict:
        return await self._http.edit_message(_ref_id(msg), text)

    async def delete(self, msg: Message | str) -> None:
        await self._http.delete_message(_ref_id(msg))

    async def react(self, msg: Message | str, emoji: str) -> None:
        await self._http.set_reaction(_ref_id(msg), emoji)

    async def unreact(self, msg: Message | str, emoji: str) -> None:
        await self._http.unset_reaction(_ref_id(msg), emoji)

    async def send(
        self,
        chat: Chat | str,
        text: str,
        *,
        mentions: list[Mention | User | dict[str, str]] | None = None,
    ) -> dict:
        entries = [_mention_entry(m) for m in mentions] if mentions is not None else None
        return await self._http.send_message(
            _ref_id(chat), text, idempotency_key=str(uuid.uuid4()), mentions=entries
        )

    async def members(
        self, chat: Chat | str | None = None, cursor: str | None = None
    ) -> MemberPage:
        target = chat if chat is not None else self.chat
        target_id = _ref_id(target)
        if not target_id:
            raise AurivalError(
                "ctx.members() needs a chat: pass one, or call it where ctx.chat is already set"
            )
        response = await self._http.list_members(target_id, cursor=cursor)
        data = response.get("data")
        users = [_user_from_wire(u) for u in data if isinstance(u, dict)] if isinstance(
            data, list
        ) else []
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
