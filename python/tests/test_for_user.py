"""AMENDMENT-09 §4: caller-locked buttons, the `for_user` wire field.

Every assertion on what a request actually carries runs against a real
in-process aiohttp server — same style as `test_messages.py` — because the
whole point of §4.3's tri-state is that two different SDK inputs (`OMITTED`
and `None`) must produce two different wires. Also covers `Message.for_user`
parsing, `ButtonContext`'s pinned absence of the field, the two new error
classes, and a signature pin on every public shape §2 and §4 touch.
"""

from __future__ import annotations

import asyncio
import inspect
import json

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival import caps, errors, http
from aurival.bot import Bot
from aurival.events import (
    BaseContext,
    Chat,
    ButtonContext,
    Context,
    Event,
    User,
    context_for,
)


class FakeAuth:
    async def token(self) -> str:
        return "tok-1"

    async def refresh(self) -> str:
        return "tok-1"


class Serve:
    def __init__(self, app: web.Application) -> None:
        self.app = app
        self.server: TestServer | None = None
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> Serve:
        self.server = TestServer(self.app)
        await self.server.start_server()
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, *exc: object) -> None:
        assert self.session is not None
        await self.session.close()
        assert self.server is not None
        await self.server.close()

    @property
    def host(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    def client(self) -> http.HttpClient:
        assert self.session is not None
        return http.HttpClient(self.session, self.host, auth=FakeAuth())


class _Capture:
    def __init__(self, body: dict | None = None, status: int = 200) -> None:
        self.raw: bytes | None = None
        self.calls = 0
        self._response_body = body
        self._status = status

    def handler(self):
        async def h(request: web.Request):
            self.calls += 1
            self.raw = await request.read()
            if self._response_body is None:
                return web.Response(status=self._status)
            return web.json_response(self._response_body, status=self._status)

        return h

    @property
    def body(self) -> dict:
        assert self.raw is not None, "the server was never called"
        return json.loads(self.raw) if self.raw else {}


_STORED = {"object": "message", "id": "msg_1", "chat": "chat_1", "text": "x"}
_THE_USER = User(id="usr_9", handle="wing", name="Wing")


def _command_app(cap: _Capture) -> web.Application:
    app = web.Application()
    app.router.add_post("/v1/messages", cap.handler())
    return app


def _edit_app(cap: _Capture) -> web.Application:
    app = web.Application()
    app.router.add_patch("/v1/messages/{msg}", cap.handler())
    return app


def _ack_app(cap: _Capture) -> web.Application:
    app = web.Application()
    app.router.add_post("/v1/interactions/{interaction}/ack", cap.handler())
    return app


def _context(client: http.HttpClient) -> Context:
    event = Event(
        id="evt_1",
        type="command.invoked",
        created_at="2026-09-18T00:00:00Z",
        sequence=1,
        data={
            "command": "ping",
            "arguments": "",
            "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
            "sender": {"object": "user", "id": "usr_1", "handle": "g", "name": "G"},
            "message": "msg_1",
        },
    )
    return Context.from_event(event, http=client)


def _button_context(client: http.HttpClient) -> ButtonContext:
    event = Event(
        id="evt_2",
        type="button.pressed",
        created_at="2026-09-18T00:00:00Z",
        sequence=2,
        data={
            "chat": "chat_1",
            "user": {"object": "user", "id": "usr_1", "handle": "g", "name": "G"},
            "message": "msg_1",
            "button": "jupiter",
            "interaction": "evt_2",
        },
    )
    ctx = context_for(event, http=client)
    assert isinstance(ctx, ButtonContext)
    return ctx


# --- for_user= on send, reply, edit and ack reaches the wire as the id -----


async def test_send_with_for_user_reaches_the_wire_as_the_id_string() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_command_app(cap)) as s:
        await _context(s.client()).send("chat_2", "hi", for_user="usr_9")
    assert cap.body["for_user"] == "usr_9"


async def test_reply_with_for_user_reaches_the_wire_as_the_id_string() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_command_app(cap)) as s:
        await _context(s.client()).reply("hi", for_user="usr_9")
    assert cap.body["for_user"] == "usr_9"


async def test_edit_with_for_user_reaches_the_wire_as_the_id_string() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "corrected", for_user="usr_9")
    assert cap.body["for_user"] == "usr_9"


async def test_ack_with_for_user_reaches_the_wire_as_the_id_string() -> None:
    cap = _Capture(body=None, status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack("done", for_user="usr_9")
    assert cap.body["for_user"] == "usr_9"


# --- a User and a bare id string both serialise to the same id (§12 D6/D21) -


async def test_a_user_object_and_a_bare_id_serialise_identically_on_send() -> None:
    cap_user = _Capture(body=_STORED)
    async with Serve(_command_app(cap_user)) as s:
        await _context(s.client()).send("chat_2", "hi", for_user=_THE_USER)
    cap_str = _Capture(body=_STORED)
    async with Serve(_command_app(cap_str)) as s:
        await _context(s.client()).send("chat_2", "hi", for_user="usr_9")
    assert cap_user.body["for_user"] == cap_str.body["for_user"] == "usr_9"


async def test_a_user_object_and_a_bare_id_serialise_identically_on_edit() -> None:
    cap_user = _Capture(body=_STORED)
    async with Serve(_edit_app(cap_user)) as s:
        await _context(s.client()).edit("msg_1", "x", for_user=_THE_USER)
    cap_str = _Capture(body=_STORED)
    async with Serve(_edit_app(cap_str)) as s:
        await _context(s.client()).edit("msg_1", "x", for_user="usr_9")
    assert cap_user.body["for_user"] == cap_str.body["for_user"] == "usr_9"


# --- for_user=None on edit and on ack sends explicit JSON null -------------


async def test_edit_with_for_user_none_clears_the_lock_with_explicit_null() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "x", for_user=None)
    assert "for_user" in cap.body
    assert cap.body["for_user"] is None


async def test_ack_with_for_user_none_clears_the_lock_with_explicit_null() -> None:
    cap = _Capture(body=None, status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack("done", for_user=None)
    assert "for_user" in cap.body
    assert cap.body["for_user"] is None


# --- omission on edit/ack sends NO for_user key at all (inherit) -----------


async def test_omitting_for_user_on_edit_sends_no_key_at_all() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "x")
    assert "for_user" not in cap.body


async def test_omitting_for_user_on_ack_sends_no_key_at_all() -> None:
    cap = _Capture(body=None, status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack("done")
    assert "for_user" not in cap.body


# --- for_user=None on send/reply sends no key -------------------------------


async def test_send_with_for_user_none_sends_no_key() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_command_app(cap)) as s:
        await _context(s.client()).send("chat_2", "hi", for_user=None)
    assert "for_user" not in cap.body


async def test_reply_with_for_user_none_sends_no_key() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_command_app(cap)) as s:
        await _context(s.client()).reply("hi", for_user=None)
    assert "for_user" not in cap.body


async def test_send_with_for_user_unset_sends_no_key_either() -> None:
    """The default is `None`, so an ordinary call that never names `for_user`
    at all produces the same wire as an explicit `None` (§4.1: a plain
    optional, not the tri-state edit/ack carry)."""
    cap = _Capture(body=_STORED)
    async with Serve(_command_app(cap)) as s:
        await _context(s.client()).send("chat_2", "hi")
    assert "for_user" not in cap.body


# --- Message.for_user is parsed, and is None when the wire omits it --------


def test_message_for_user_is_parsed_from_the_wire() -> None:
    from aurival.events import _message_from_wire

    msg = _message_from_wire({"id": "msg_1", "text": "x", "for_user": "usr_9"})
    assert msg.for_user == "usr_9"


def test_message_for_user_is_none_when_the_wire_omits_it() -> None:
    from aurival.events import _message_from_wire

    msg = _message_from_wire({"id": "msg_1", "text": "x"})
    assert msg.for_user is None


def test_message_for_user_is_none_when_the_wire_sends_explicit_null() -> None:
    from aurival.events import _message_from_wire

    msg = _message_from_wire({"id": "msg_1", "text": "x", "for_user": None})
    assert msg.for_user is None


async def test_send_returns_a_message_with_for_user_read_back() -> None:
    cap = _Capture(body={"object": "message", "id": "msg_1", "for_user": "usr_9"})
    async with Serve(_command_app(cap)) as s:
        message = await _context(s.client()).send("chat_2", "hi", for_user="usr_9")
    assert message.for_user == "usr_9"


# --- ButtonContext exposes NO for_user (pinned absence, §6.1 D20) ----------


def test_button_context_exposes_no_for_user_attribute() -> None:
    # Built via context_for, so every field is populated the way the
    # dispatcher actually builds it.
    event = Event(
        id="evt_2",
        type="button.pressed",
        created_at="2026-09-18T00:00:00Z",
        sequence=2,
        data={
            "chat": "chat_1",
            "user": {"object": "user", "id": "usr_1", "handle": "g", "name": "G"},
            "message": "msg_1",
            "button": "jupiter",
            "interaction": "evt_2",
        },
    )
    real_ctx = context_for(event, http=None)  # type: ignore[arg-type]
    assert isinstance(real_ctx, ButtonContext)
    assert not hasattr(real_ctx, "for_user"), (
        "ButtonContext must never gain a for_user attribute — the presser IS the locked "
        "user on every delivery (§6.1 D20), and there is no route to fetch the card's lock"
    )


def test_button_context_ack_signature_carries_no_for_user_attribute_leak() -> None:
    """A pinned absence at the class level too, so a later lane cannot slip
    a `self.for_user =` into `ButtonContext.__init__` without this failing."""
    params = {p.name for p in inspect.signature(ButtonContext.__init__).parameters.values()}
    assert "for_user" not in params


# --- TooManyAliases and ForUserNotMember raise on their codes ---------------


def test_for_user_not_member_raises_through_the_error_mapping() -> None:
    payload = {
        "error": {
            "type": "invalid_request_error",
            "code": "for_user_not_member",
            "message": "for_user must name a member of this chat",
            "doc_url": "https://bots.aurival.com/docs/errors#for_user_not_member",
            "request_id": "req_1",
        }
    }
    exc = errors.from_envelope(payload, status=400)
    assert isinstance(exc, errors.ForUserNotMember)
    assert isinstance(exc, errors.InvalidRequestError)
    assert exc.code == "for_user_not_member"


def test_too_many_aliases_raises_through_the_error_mapping() -> None:
    payload = {
        "error": {
            "type": "invalid_request_error",
            "code": "too_many_aliases",
            "message": "a command declares at most 3 aliases",
            "doc_url": "https://bots.aurival.com/docs/errors#too_many_aliases",
            "request_id": "req_1",
        }
    }
    exc = errors.from_envelope(payload, status=400)
    assert isinstance(exc, errors.TooManyAliases)
    assert isinstance(exc, errors.InvalidRequestError)
    assert exc.code == "too_many_aliases"


def test_both_new_classes_are_registered_in_code_classes() -> None:
    assert errors.CODE_CLASSES["for_user_not_member"] is errors.ForUserNotMember
    assert errors.CODE_CLASSES["too_many_aliases"] is errors.TooManyAliases


# --- signature pin: §2's and §4's public shapes -----------------------------


def test_bot_command_signature_is_pinned() -> None:
    params = list(inspect.signature(Bot.command).parameters.values())
    assert [p.name for p in params] == [
        "self",
        "name",
        "description",
        "aliases",
        "cooldown",
        "on_cooldown",
    ]
    kinds = {p.name: p.kind for p in params}
    assert kinds["name"] is inspect.Parameter.POSITIONAL_OR_KEYWORD
    assert kinds["description"] is inspect.Parameter.POSITIONAL_OR_KEYWORD, (
        "the description-positional overload must keep working unchanged"
    )
    assert kinds["aliases"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["cooldown"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["on_cooldown"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["description"] == ""
    assert defaults["aliases"] is None
    assert defaults["cooldown"] is None
    assert defaults["on_cooldown"] is None


def test_reply_signature_pins_for_user_as_a_plain_keyword_optional() -> None:
    params = list(inspect.signature(BaseContext.reply).parameters.values())
    names = [p.name for p in params]
    assert names[-1] == "for_user"
    kinds = {p.name: p.kind for p in params}
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["for_user"] is None, (
        "reply()'s for_user is a plain optional (default None means 'send no key'), not the "
        "OMITTED tri-state edit/ack carry (§4.1)"
    )


def test_send_signature_pins_for_user_as_a_plain_keyword_optional() -> None:
    params = list(inspect.signature(BaseContext.send).parameters.values())
    names = [p.name for p in params]
    assert names[-1] == "for_user"
    kinds = {p.name: p.kind for p in params}
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["for_user"] is None


def test_edit_signature_pins_for_user_as_the_omitted_tri_state() -> None:
    params = list(inspect.signature(BaseContext.edit).parameters.values())
    names = [p.name for p in params]
    assert names[-1] == "for_user"
    kinds = {p.name: p.kind for p in params}
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["for_user"] is http.OMITTED


def test_ack_signature_pins_for_user_as_the_omitted_tri_state() -> None:
    params = list(inspect.signature(ButtonContext.ack).parameters.values())
    names = [p.name for p in params]
    assert names[-1] == "for_user"
    kinds = {p.name: p.kind for p in params}
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["for_user"] is http.OMITTED


def test_context_invoked_as_exists_as_a_plain_string_attribute() -> None:
    event = Event(
        id="e",
        type="command.invoked",
        created_at="",
        sequence=1,
        data={"command": "roll", "invoked_as": "r"},
    )
    ctx = Context.from_event(event, http=None)  # type: ignore[arg-type]
    assert ctx.invoked_as == "r"
    assert isinstance(ctx.invoked_as, str)


def test_edit_with_only_for_user_none_still_trips_nothing_to_edit() -> None:
    """A lock-only PATCH is refused here, before any round trip, and stays
    refused: `nothing_to_edit`'s sentence is unchanged by AMENDMENT-09 and
    the server reads the same three parts — `handleEditMessage` answers
    `CodeNothingToEdit` on `patch.Empty()`, which does not consider the lock
    (`backend-go/internal/botapi/messages_mutate.go:450`, re-read at
    origin/main f67c83f6c). Widening the precondition would turn a free local
    refusal into a doomed round trip that answers the same thing.
    AMENDMENT-09 §12 step 16 clears a lock by naming a part alongside it.
    `sdk/js/src/events.ts`'s `partsAreEmpty` mirrors this exactly (SDK-7).
    """
    event = Event(
        id="evt_1",
        type="command.invoked",
        created_at="2026-09-18T00:00:00Z",
        sequence=1,
        data={"command": "ping"},
    )
    ctx = BaseContext(event=event, http=None, chat=Chat(id="chat_1", type="direct", name=None))  # type: ignore[arg-type]
    with pytest.raises(ValueError) as caught:
        asyncio.run(ctx.edit("msg_1", for_user=None))
    assert str(caught.value) == caps.NOTHING_TO_EDIT
