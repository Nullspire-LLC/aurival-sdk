"""AMENDMENT-07 §9's two doors: `ctx.edit` and `ctx.ack` carrying card parts.

Every assertion here is on the REQUEST the server actually received — raw
bytes for the "no body at all" case — not on what the SDK was handed, because
the whole point of §9's three states is that two different SDK inputs (`None`
and `[]`) must produce two different wires.
"""

from __future__ import annotations

import inspect
import json

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival import http
from aurival.caps import NOTHING_TO_EDIT
from aurival.embeds import Button, Embed
from aurival.events import ButtonContext, Context, Event, context_for


class FakeAuth:
    async def token(self) -> str:
        return "tok-1"

    async def refresh(self) -> str:
        return "tok-1"


class Serve:
    """The in-process aiohttp server `test_actions.py` uses — no mock of
    aiohttp itself, so the body under test is the body that got serialised."""

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
    """Records the raw request body and answers a stored message or a 204."""

    def __init__(self, body: dict | None = None, status: int = 200) -> None:
        self.raw: bytes | None = None
        self.content_type: str | None = None
        self.calls = 0
        self._response_body = body
        self._status = status

    def handler(self):
        async def h(request: web.Request):
            self.calls += 1
            self.raw = await request.read()
            self.content_type = request.headers.get("Content-Type")
            if self._response_body is None:
                return web.Response(status=self._status)
            return web.json_response(self._response_body, status=self._status)

        return h

    @property
    def body(self) -> dict:
        assert self.raw is not None, "the server was never called"
        return json.loads(self.raw)


_STORED = {"object": "message", "id": "msg_1", "chat": "chat_1", "text": "x"}


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
        created_at="2026-09-17T00:00:00Z",
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
        created_at="2026-09-17T00:00:00Z",
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


# --- §2: each part alone, and a part left out stays out ----------------------


async def test_edit_with_text_alone_sends_only_text() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "corrected")
    assert cap.body == {"text": "corrected"}, (
        "a part the caller never named must be absent from the PATCH body — present-with-null "
        "would clear it (AMENDMENT-07 §2)"
    )


async def test_edit_with_embeds_alone_sends_only_embeds() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", embeds=[Embed(title="Jupiter")])
    assert set(cap.body) == {"embeds"}
    assert cap.body["embeds"] == [{"title": "Jupiter"}]


async def test_edit_with_buttons_alone_sends_only_buttons() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit(
            "msg_1", buttons=[Button("Play again", id="again", style="primary")]
        )
    assert set(cap.body) == {"buttons"}
    assert cap.body["buttons"] == [{"id": "again", "label": "Play again", "style": "primary"}]


async def test_edit_takes_a_message_object_as_its_target() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        ctx = _context(s.client())
        sent = await ctx.edit("msg_1", "one")
        await ctx.edit(sent, "two")
    assert cap.calls == 2
    assert cap.body == {"text": "two"}


# --- §9: an empty list is the clear, and it reaches the wire as null ----------


async def test_edit_with_an_empty_embeds_list_puts_null_on_the_wire() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", embeds=[])
    assert cap.body == {"embeds": None}, (
        "`embeds=[]` is the SDK's spelling of a clear (§9); `send_message`'s `if embeds:` "
        "omission would silently turn it into 'keep what is there'"
    )


async def test_edit_with_an_empty_buttons_list_puts_null_on_the_wire() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", buttons=[])
    assert cap.body == {"buttons": None}


async def test_edit_clears_both_parts_at_once_and_keeps_text_absent() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", embeds=[], buttons=[])
    assert cap.body == {"embeds": None, "buttons": None}


# --- §2: empty text is a value on edit, not an absence -----------------------


async def test_edit_with_empty_text_sends_it_and_does_not_raise() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "", embeds=[Embed(title="Jupiter")])
    assert cap.body["text"] == "", (
        "the emptiness check moved to the MERGED card server-side (§2), so `text=''` beside a "
        "surviving embed is legal and must be sent, not swallowed as falsy"
    )


async def test_edit_with_empty_text_alone_still_reaches_the_server() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        await _context(s.client()).edit("msg_1", "")
    assert cap.body == {"text": ""}, (
        "whether empty text alone is legal is the server's call on the merged card — the SDK "
        "does not reuse send's `_require_something_to_say` here"
    )


# --- §7: naming none of the three is refused before any request --------------


async def test_edit_naming_nothing_raises_before_any_request() -> None:
    cap = _Capture(body=_STORED)
    async with Serve(_edit_app(cap)) as s:
        ctx = _context(s.client())
        with pytest.raises(ValueError) as excinfo:
            await ctx.edit("msg_1")
    assert str(excinfo.value) == NOTHING_TO_EDIT
    assert cap.calls == 0, "the precondition must refuse before the round trip, as send's does"


def test_the_nothing_to_edit_sentence_is_the_amendment_07_wording() -> None:
    # Byte-identical across errors_v1.go, ERRORS-V1.md §3, caps.py and caps.ts
    # (AMENDMENT-07 §7). Restated here so a reword of the constant fails loudly
    # instead of drifting away from the Go catalogue L1 has yet to land.
    assert NOTHING_TO_EDIT == "an edit needs text, embeds or buttons"


# --- §3/§8: an ack that turns the question card into its result --------------


async def test_ack_with_a_body_posts_the_replacement_card() -> None:
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack(
            "",
            embeds=[
                Embed(title="Jupiter", color="#3E6E8E", description="Correct.").add_field(
                    "Answered by", "Gustav", inline=True
                )
            ],
            buttons=[Button("Play again", id="again", style="primary")],
        )
    assert cap.body == {
        "text": "",
        "embeds": [
            {
                "title": "Jupiter",
                "description": "Correct.",
                "color": "#3E6E8E",
                "fields": [{"name": "Answered by", "value": "Gustav", "inline": True}],
            }
        ],
        "buttons": [{"id": "again", "label": "Play again", "style": "primary"}],
    }


async def test_ack_with_empty_text_alone_sends_it_with_no_client_side_refusal() -> None:
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack("")
    assert cap.body == {"text": ""}, (
        "there is no emptiness precondition on ack: whether an empty-text ack is legal is the "
        "server's call on the merged card"
    )


async def test_ack_clears_the_button_row_with_an_empty_list() -> None:
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack("done", buttons=[])
    assert cap.body == {"text": "done", "buttons": None}


async def test_bare_ack_sends_no_body_at_all() -> None:
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        await _button_context(s.client()).ack()
    assert cap.raw == b"", (
        "§9: `ctx.ack()` with no arguments is byte-identical to 0.5.0 — an empty JSON object "
        "`{}` would be a new wire, not the old one"
    )
    assert cap.content_type != "application/json", (
        "no json entity was written, so no json content-type is announced — aiohttp's own "
        "bodiless default (application/octet-stream) is what 0.5.0 sent too"
    )


async def test_bare_ack_is_byte_identical_to_the_0_5_0_request() -> None:
    """The strongest form of the §9 promise: the same body bytes and the same
    content-type as the raw `request` call `ack_interaction` made before it
    took a body."""
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        client = s.client()
        await _button_context(client).ack()
        through_ack = (cap.raw, cap.content_type)
        # exactly the 0.5.0 body: none at all.
        await client.request("POST", "/v1/interactions/evt_2/ack", idempotency_key="idem-1")
    assert through_ack == (cap.raw, cap.content_type)


async def test_bare_ack_posts_to_the_interaction_id_verbatim() -> None:
    cap = _Capture(status=204)
    async with Serve(_ack_app(cap)) as s:
        ctx = _button_context(s.client())
        assert ctx.interaction == "evt_2"
        await ctx.ack()
    assert cap.calls == 1


# --- §9: the signatures themselves ------------------------------------------


def test_edit_signature_is_pinned_to_amendment_07() -> None:
    params = list(inspect.signature(Context.edit).parameters.values())
    # AMENDMENT-09 §4.3 adds `for_user`, keyword-only, tri-state (§4.1-D21):
    # the pin grows by one name rather than being replaced.
    assert [p.name for p in params] == ["self", "msg", "text", "embeds", "buttons", "for_user"]
    kinds = {p.name: p.kind for p in params}
    assert kinds["msg"] is inspect.Parameter.POSITIONAL_OR_KEYWORD
    assert kinds["text"] is inspect.Parameter.POSITIONAL_OR_KEYWORD, (
        "`text` stays positional so every 0.5.0 caller — `await ctx.edit(sent, 'done')` — keeps "
        "working byte for byte"
    )
    assert kinds["embeds"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["buttons"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["text"] is None
    assert defaults["embeds"] is None
    assert defaults["buttons"] is None
    assert defaults["for_user"] is http.OMITTED, (
        "`for_user` defaults to OMITTED, not None — None already means 'clear the lock' (§4.3)"
    )


def test_ack_signature_is_pinned_to_amendment_07() -> None:
    params = list(inspect.signature(ButtonContext.ack).parameters.values())
    # AMENDMENT-09 §4.3 adds `for_user`, same tri-state as `edit`'s.
    assert [p.name for p in params] == ["self", "text", "embeds", "buttons", "for_user"]
    kinds = {p.name: p.kind for p in params}
    assert kinds["text"] is inspect.Parameter.POSITIONAL_OR_KEYWORD
    assert kinds["embeds"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["buttons"] is inspect.Parameter.KEYWORD_ONLY
    assert kinds["for_user"] is inspect.Parameter.KEYWORD_ONLY
    defaults = {p.name: p.default for p in params if p.default is not inspect.Parameter.empty}
    assert defaults["text"] is None
    assert defaults["embeds"] is None
    assert defaults["buttons"] is None
    assert defaults["for_user"] is http.OMITTED
    assert "for_user" not in {"text", "embeds", "buttons"}, (
        "every pre-existing argument stays optional, so `ctx.ack()` stays the zero-argument "
        "call 0.5.0 shipped"
    )
