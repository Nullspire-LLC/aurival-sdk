"""Tests for aurival.http, against a REAL in-process aiohttp server.

No mocks of aiohttp itself: every test drives `aiohttp.web` through
`aiohttp.test_utils.TestServer` on a real socket, and a real `aiohttp.ClientSession`
talks to it — a mock is our own guess about what the server says.
"""

from __future__ import annotations

import importlib
import pathlib
import socket
import sys
import types

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer


def _load_aurival_submodule(name: str):
    if "aurival" not in sys.modules:
        pkg_dir = pathlib.Path(__file__).resolve().parents[1] / "aurival"
        stub = types.ModuleType("aurival")
        stub.__path__ = [str(pkg_dir)]
        sys.modules["aurival"] = stub
    return importlib.import_module(f"aurival.{name}")


errors = _load_aurival_submodule("errors")
http = _load_aurival_submodule("http")


def _envelope(error_type: str, code: str, message: str, request_id: str = "req_1") -> dict:
    return {
        "error": {
            "type": error_type,
            "code": code,
            "message": message,
            "doc_url": f"https://bots.aurival.com/docs/errors#{code}",
            "request_id": request_id,
        }
    }


class FakeAuth:
    """Duck-types `Auth` for http.py's purposes: `token()` and `refresh()`."""

    def __init__(self, token: str = "tok-1", refreshed_token: str = "tok-2") -> None:
        self.current = token
        self.refreshed_token = refreshed_token
        self.refresh_calls = 0

    async def token(self) -> str:
        return self.current

    async def refresh(self) -> str:
        self.refresh_calls += 1
        self.current = self.refreshed_token
        return self.current


class SleepSpy:
    """Replaces HttpClient._sleep so retry tests run instantly and record delays."""

    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Serve:
    """Runs a real aiohttp.web server + real ClientSession for one test."""

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
        return http.HttpClient(self.session, self.host, **kw)


# --- access_token_expired: re-exchange, retry once ---------------------------


@pytest.mark.asyncio
async def test_access_token_expired_retries_once_then_succeeds():
    seen_auth_headers = []

    async def handler(request: web.Request):
        seen_auth_headers.append(request.headers.get("Authorization"))
        if request.headers.get("Authorization") == "Bearer tok-2":
            return web.json_response({"access_token": "ok"}, status=200)
        return web.json_response(
            _envelope("authentication_error", "access_token_expired", "expired"), status=401
        )

    app = web.Application()
    app.router.add_post("/v1/token", handler)
    async with Serve(app) as s:
        auth = FakeAuth()
        client = s.client(auth=auth)
        result = await client.request("POST", "/v1/token", body={"assertion": "x"})
        assert result == {"access_token": "ok"}
        assert auth.refresh_calls == 1
        assert seen_auth_headers == ["Bearer tok-1", "Bearer tok-2"]


@pytest.mark.asyncio
async def test_access_token_expired_twice_raises():
    async def handler(request: web.Request):
        return web.json_response(
            _envelope("authentication_error", "access_token_expired", "still expired"), status=401
        )

    app = web.Application()
    app.router.add_post("/v1/token", handler)
    async with Serve(app) as s:
        auth = FakeAuth()
        client = s.client(auth=auth)
        with pytest.raises(errors.AccessTokenExpired):
            await client.request("POST", "/v1/token", body={"assertion": "x"})
        assert auth.refresh_calls == 1  # exactly one retry, not looped


@pytest.mark.asyncio
async def test_non_auth_authentication_error_raises_without_retry():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        return web.json_response(
            _envelope("authentication_error", "bad_assertion", "bad signature"), status=401
        )

    app = web.Application()
    app.router.add_post("/v1/token", handler)
    async with Serve(app) as s:
        auth = FakeAuth()
        client = s.client(auth=auth)
        with pytest.raises(errors.BadAssertion):
            await client.request("POST", "/v1/token", body={"assertion": "x"})
        assert calls == 1
        assert auth.refresh_calls == 0


# --- rate_limit_error ---------------------------------------------------------


@pytest.mark.asyncio
async def test_rate_limit_error_honours_retry_after_and_retries():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        if calls < 3:
            resp = web.json_response(
                _envelope("rate_limit_error", "rate_limited", "slow down"), status=429
            )
            resp.headers["Retry-After"] = "2"
            return resp
        return web.json_response({"chat": "chat_1", "text": "hi"}, status=201)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        spy = SleepSpy()
        client._sleep = spy
        result = await client.send_message("chat_1", "hi", idempotency_key="idem-1")
        assert result == {"chat": "chat_1", "text": "hi"}
        assert calls == 3
        assert spy.calls == [2.0, 2.0]


@pytest.mark.asyncio
async def test_rate_limit_error_bounded_at_5_attempts():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        resp = web.json_response(
            _envelope("rate_limit_error", "rate_limited", "slow down"), status=429
        )
        resp.headers["Retry-After"] = "0"
        return resp

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        client._sleep = SleepSpy()
        with pytest.raises(errors.RateLimited):
            await client.send_message("chat_1", "hi", idempotency_key="idem-1")
        assert calls == 5


@pytest.mark.asyncio
async def test_sync_commands_does_not_swallow_sync_rate_limited():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        resp = web.json_response(
            _envelope("rate_limit_error", "sync_rate_limited", "sync limit hit"), status=429
        )
        resp.headers["Retry-After"] = "60"
        return resp

    app = web.Application()
    app.router.add_put("/v1/bots/bot_1/commands", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        spy = SleepSpy()
        client._sleep = spy
        with pytest.raises(errors.SyncRateLimited):
            await client.sync_commands("bot_1", [{"name": "ping", "description": "d"}])
        assert calls == 1  # not retried inside http.py — bot.py owns this (SDK-35)
        assert spy.calls == []


# --- api_error / 5xx -----------------------------------------------------------


@pytest.mark.asyncio
async def test_api_error_5xx_retries_five_times_then_raises():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        return web.json_response(_envelope("api_error", "internal_error", "our fault"), status=500)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        client._sleep = SleepSpy()
        with pytest.raises(errors.InternalError):
            await client.send_message("chat_1", "hi", idempotency_key="idem-2")
        assert calls == 5


@pytest.mark.asyncio
async def test_api_error_retries_then_succeeds():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        if calls < 3:
            return web.json_response(
                _envelope("api_error", "internal_error", "our fault"), status=500
            )
        return web.json_response({"chat": "chat_1", "text": "hi"}, status=201)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        client._sleep = SleepSpy()
        result = await client.send_message("chat_1", "hi", idempotency_key="idem-3")
        assert result == {"chat": "chat_1", "text": "hi"}
        assert calls == 3


# --- invalid_request_error / permission_error: immediate, message intact -----


@pytest.mark.asyncio
async def test_invalid_request_error_raises_immediately_with_message_intact():
    calls = 0
    the_message = "A message needs text. If you meant to send nothing, do not send."

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        return web.json_response(
            _envelope("invalid_request_error", "empty_text", the_message), status=400
        )

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        with pytest.raises(errors.EmptyText) as exc_info:
            await client.send_message("chat_1", "", idempotency_key="idem-4")
        assert calls == 1
        assert exc_info.value.message == the_message


@pytest.mark.asyncio
async def test_permission_error_raises_immediately():
    calls = 0

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        return web.json_response(
            _envelope("permission_error", "bot_suspended", "This bot is suspended."), status=403
        )

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        with pytest.raises(errors.BotSuspended):
            await client.send_message("chat_1", "hi", idempotency_key="idem-5")
        assert calls == 1


# --- transport / protocol -------------------------------------------------------


@pytest.mark.asyncio
async def test_client_error_becomes_transport_error():
    dead_port = _free_port()  # nothing is listening: connection refused
    async with aiohttp.ClientSession() as session:
        client = http.HttpClient(session, f"http://127.0.0.1:{dead_port}", auth=FakeAuth())
        client._sleep = SleepSpy()
        with pytest.raises(errors.TransportError):
            await client.send_message("chat_1", "hi", idempotency_key="idem-6")


@pytest.mark.asyncio
async def test_non_json_body_becomes_protocol_error():
    async def handler(request: web.Request):
        return web.Response(text="not json at all", status=200)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        with pytest.raises(errors.ProtocolError):
            await client.send_message("chat_1", "hi", idempotency_key="idem-7")


@pytest.mark.asyncio
async def test_valid_json_that_is_not_an_object_becomes_protocol_error():
    async def handler(request: web.Request):
        return web.json_response([1, 2, 3], status=200)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        with pytest.raises(errors.ProtocolError):
            await client.send_message("chat_1", "hi", idempotency_key="idem-7b")


# --- Idempotency-Key --------------------------------------------------------


@pytest.mark.asyncio
async def test_idempotency_key_reused_across_retries_not_regenerated():
    calls = 0
    seen_keys = []

    async def handler(request: web.Request):
        nonlocal calls
        calls += 1
        seen_keys.append(request.headers.get("Idempotency-Key"))
        if calls < 3:
            return web.json_response(
                _envelope("api_error", "internal_error", "our fault"), status=500
            )
        return web.json_response({"chat": "chat_1", "text": "hi"}, status=201)

    app = web.Application()
    app.router.add_post("/v1/messages", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        client._sleep = SleepSpy()
        await client.send_message("chat_1", "hi", idempotency_key="idem-fixed")
        assert seen_keys == ["idem-fixed", "idem-fixed", "idem-fixed"]


# --- gateway_url ---------------------------------------------------------------


def test_gateway_url_maps_http_to_ws():
    class DummySession:
        pass

    client = http.HttpClient(DummySession(), "http://localhost:8080")
    assert client.gateway_url() == "ws://localhost:8080/v1/gateway"


def test_gateway_url_maps_https_to_wss():
    class DummySession:
        pass

    client = http.HttpClient(DummySession(), "https://bots.aurival.com")
    assert client.gateway_url() == "wss://bots.aurival.com/v1/gateway"


# --- list_commands / sync_commands wiring (happy path) --------------------------


@pytest.mark.asyncio
async def test_list_commands_happy_path():
    async def handler(request: web.Request):
        return web.json_response({"object": "list", "data": []}, status=200)

    app = web.Application()
    app.router.add_get("/v1/bots/bot_1/commands", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        result = await client.list_commands("bot_1")
        assert result == {"object": "list", "data": []}


@pytest.mark.asyncio
async def test_sync_commands_happy_path_sends_commands_body():
    received_body = {}

    async def handler(request: web.Request):
        nonlocal received_body
        received_body = await request.json()
        return web.json_response({"object": "list", "data": []}, status=200)

    app = web.Application()
    app.router.add_put("/v1/bots/bot_1/commands", handler)
    async with Serve(app) as s:
        client = s.client(auth=FakeAuth())
        await client.sync_commands("bot_1", [{"name": "ping", "description": "d"}])
        assert received_body == {"commands": [{"name": "ping", "description": "d"}]}
