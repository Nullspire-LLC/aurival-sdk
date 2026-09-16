"""Wire-level tests for the six new `HttpClient` actions plus the mentions
addition to `send_message` (R8), against a real in-process aiohttp server —
same style as `test_http.py`: no mock of aiohttp itself.
"""

from __future__ import annotations

import socket as socketlib
import urllib.parse

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival import errors, http


class FakeAuth:
    async def token(self) -> str:
        return "tok-1"

    async def refresh(self) -> str:
        return "tok-1"


def _free_port() -> int:
    s = socketlib.socket(socketlib.AF_INET, socketlib.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


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

    async def __aexit__(self, *exc) -> None:
        assert self.session is not None
        await self.session.close()
        assert self.server is not None
        await self.server.close()

    @property
    def host(self) -> str:
        assert self.server is not None
        return str(self.server.make_url("")).rstrip("/")

    def client(self, **kw) -> http.HttpClient:
        assert self.session is not None
        return http.HttpClient(self.session, self.host, auth=FakeAuth(), **kw)


class _Capture:
    """Records method/path/body of one request, answers 204 or a JSON body."""

    def __init__(self, body: dict | None = None, status: int = 200) -> None:
        self.method: str | None = None
        self.path: str | None = None
        self.body: object = None
        self._response_body = body
        self._status = status

    def handler(self):
        async def h(request: web.Request):
            self.method = request.method
            self.path = request.path_qs
            self.body = await request.read()
            if self._response_body is None:
                return web.Response(status=self._status)
            return web.json_response(self._response_body, status=self._status)

        return h


@pytest.mark.asyncio
async def test_set_typing_wire_fact() -> None:
    cap = _Capture(status=204)
    app = web.Application()
    app.router.add_post("/v1/chats/{chat}/typing", cap.handler())
    async with Serve(app) as s:
        result = await s.client().set_typing("chat_1", True)
        assert cap.method == "POST"
        assert cap.path == "/v1/chats/chat_1/typing"
        assert cap.body == b'{"is_typing": true}'
        assert result == {}


@pytest.mark.asyncio
async def test_edit_message_wire_fact() -> None:
    cap = _Capture(body={"object": "message", "id": "msg_1", "text": "new"})
    app = web.Application()
    app.router.add_patch("/v1/messages/{msg}", cap.handler())
    async with Serve(app) as s:
        result = await s.client().edit_message("msg_1", "new")
        assert cap.method == "PATCH"
        assert cap.path == "/v1/messages/msg_1"
        assert cap.body == b'{"text": "new"}'
        assert result["id"] == "msg_1"


@pytest.mark.asyncio
async def test_delete_message_wire_fact() -> None:
    cap = _Capture(status=204)
    app = web.Application()
    app.router.add_delete("/v1/messages/{msg}", cap.handler())
    async with Serve(app) as s:
        result = await s.client().delete_message("msg_1")
        assert cap.method == "DELETE"
        assert cap.path == "/v1/messages/msg_1"
        assert result == {}


@pytest.mark.asyncio
async def test_set_reaction_wire_fact_emoji_is_percent_encoded() -> None:
    cap = _Capture(status=204)
    app = web.Application()
    app.router.add_put("/v1/messages/{msg}/reactions/{emoji}", cap.handler())
    async with Serve(app) as s:
        await s.client().set_reaction("msg_1", "\U0001F44D")
        assert cap.method == "PUT"
        encoded = urllib.parse.quote("\U0001F44D", safe="")
        assert cap.path == f"/v1/messages/msg_1/reactions/{encoded}"


@pytest.mark.asyncio
async def test_unset_reaction_wire_fact_emoji_is_percent_encoded() -> None:
    cap = _Capture(status=204)
    app = web.Application()
    app.router.add_delete("/v1/messages/{msg}/reactions/{emoji}", cap.handler())
    async with Serve(app) as s:
        await s.client().unset_reaction("msg_1", "\U0001F44D")
        assert cap.method == "DELETE"
        encoded = urllib.parse.quote("\U0001F44D", safe="")
        assert cap.path == f"/v1/messages/msg_1/reactions/{encoded}"


@pytest.mark.asyncio
async def test_send_message_with_mentions_wire_fact() -> None:
    cap = _Capture(body={"object": "message", "id": "msg_1"})
    app = web.Application()
    app.router.add_post("/v1/messages", cap.handler())
    async with Serve(app) as s:
        await s.client().send_message(
            "chat_1", "hey @wing", idempotency_key="idem-1", mentions=[{"user": "usr_1"}]
        )
        assert cap.method == "POST"
        assert cap.path == "/v1/messages"
        assert cap.body == (
            b'{"chat": "chat_1", "text": "hey @wing", "mentions": [{"user": "usr_1"}]}'
        )


@pytest.mark.asyncio
async def test_list_members_wire_fact_is_a_get_with_no_body() -> None:
    cap = _Capture(body={"object": "list", "data": [], "has_more": False, "next_cursor": None})
    app = web.Application()
    app.router.add_get("/v1/chats/{chat}/members", cap.handler())
    async with Serve(app) as s:
        result = await s.client().list_members("chat_1")
        assert cap.method == "GET"
        assert cap.path == "/v1/chats/chat_1/members"
        assert cap.body == b""
        assert result["object"] == "list"


@pytest.mark.asyncio
async def test_a_204_no_content_response_is_an_empty_dict_not_a_protocol_error() -> None:
    """R3: `request()` used to raise `ProtocolError` on an empty body for ANY
    status under 400 — the six new actions above answer 204 with no body."""
    app = web.Application()

    async def handler(request: web.Request):
        return web.Response(status=204)

    app.router.add_post("/v1/chats/{chat}/typing", handler)
    async with Serve(app) as s:
        result = await s.client().request(
            "POST", "/v1/chats/chat_1/typing", body={"is_typing": True}
        )
        assert result == {}


@pytest.mark.asyncio
async def test_an_empty_bodied_200_still_raises_protocol_error() -> None:
    """Only a 204 gets the empty-body pass — an empty-bodied 200 on any
    pre-existing endpoint (e.g. `send_message`) is still a `ProtocolError`,
    exactly as it was before R3."""
    app = web.Application()

    async def handler(request: web.Request):
        return web.Response(status=200)

    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        with pytest.raises(errors.ProtocolError):
            await s.client().send_message("chat_1", "hi", idempotency_key="idem-1")


@pytest.mark.asyncio
async def test_a_204_with_a_json_body_still_decodes_it() -> None:
    """The 204 short-circuit is gated on `status == 204 and not raw` — a
    spec-violating 204 that DOES carry a JSON body must still be decoded via
    `_decode_object`, not silently dropped to `{}`.

    This can't be produced over a real wire round-trip: aiohttp's own HTTP
    parser enforces RFC 7230 §3.3.3 rule 1 (a 204 has no body, full stop) on
    both ends — the test aiohttp *server* silently strips a body handed to a
    204 `web.Response`, and even a raw hand-crafted socket response carrying
    one is rejected by the aiohttp *client* parser before `HttpClient` ever
    sees it. So `raw` truthy on a 204 is unreachable through aiohttp itself;
    the only way to exercise that branch of `request()`'s own gate is to hand
    it a `read()` that returns a body, which this does by patching just that
    one coroutine on the response aiohttp already produced for a genuine 204
    — not a mock of aiohttp's request/response machinery itself.
    """
    app = web.Application()

    async def handler(request: web.Request):
        return web.Response(status=204)

    app.router.add_post("/v1/chats/{chat}/typing", handler)
    async with Serve(app) as s:
        client = s.client()
        real_request = client._session.request

        class _PatchedCM:
            def __init__(self, cm: object) -> None:
                self._cm = cm

            async def __aenter__(self):
                resp = await self._cm.__aenter__()  # type: ignore[attr-defined]

                async def fake_read() -> bytes:
                    return b'{"object": "message", "id": "msg_1"}'

                resp.read = fake_read
                return resp

            async def __aexit__(self, *exc: object) -> None:
                await self._cm.__aexit__(*exc)  # type: ignore[attr-defined]

        def patched_request(*args: object, **kwargs: object) -> _PatchedCM:
            return _PatchedCM(real_request(*args, **kwargs))

        client._session.request = patched_request  # type: ignore[method-assign]

        result = await client.request(
            "POST", "/v1/chats/chat_1/typing", body={"is_typing": True}
        )
        assert result == {"object": "message", "id": "msg_1"}
