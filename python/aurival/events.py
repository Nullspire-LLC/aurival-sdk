"""Plain data a command handler receives (CONTRACT-V1 §3, §3.1).

`Event` is the raw wire frame; `Context` is what `bot.py` hands to a handler,
built from one. `Context` holds an `HttpClient` for `reply()` and nothing else
network-shaped — never the seed, a token, or the `Auth` object (SDK-33).
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import TYPE_CHECKING

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
    return Chat(
        id=str(d.get("id", "")),
        type=str(d.get("type", "")),
        name=name if isinstance(name, str) else None,
    )


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
    """What a command handler receives. Built by `bot.py`'s dispatch closure
    from one `Event` — `Socket` never constructs one."""

    def __init__(
        self,
        *,
        command: str,
        arguments: str,
        chat: Chat,
        sender: User,
        event: Event,
        message: Message | None,
        http: HttpClient,
    ) -> None:
        self.command = command
        self.arguments = arguments
        self.chat = chat
        self.sender = sender
        self.event = event
        self.message = message
        self._http = http

    @classmethod
    def from_event(cls, event: Event, *, http: HttpClient) -> Context:
        """Build straight from a `command.invoked` event's raw `data`."""
        data = event.data
        return cls(
            command=str(data.get("command", "")),
            arguments=str(data.get("arguments", "")),
            chat=_chat_from_wire(data.get("chat") if isinstance(data.get("chat"), dict) else {}),
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
