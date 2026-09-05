"""The socket's connect path, under SDK-33.

`aiohttp.WSServerHandshakeError` carries `request_info`, and its `repr` prints
the request headers — `Authorization` included. A refused handshake is ordinary:
a token that aged out during a reconnect does it. So the exception must never
reach a log line or a traceback, and this is the test that says so.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival import socket as socket_module
from aurival.http import HttpClient

TOKEN = "attok_never_log_this_particular_value_12345"


class _Auth:
    bot = "bot_1"

    async def token(self) -> str:
        return TOKEN

    async def refresh(self) -> str:
        return TOKEN


async def _never_dispatch(event: object) -> None:  # pragma: no cover
    raise AssertionError("nothing should be dispatched over a refused handshake")


@pytest.mark.asyncio
async def test_a_failed_websocket_handshake_never_leaks_the_token(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen_auth: list[str] = []

    async def refuse(request: web.Request) -> web.Response:
        seen_auth.append(request.headers.get("Authorization", ""))
        return web.Response(status=401, text="nope")

    app = web.Application()
    app.router.add_get("/v1/gateway", refuse)
    server = TestServer(app)
    await server.start_server()
    try:
        base = f"http://127.0.0.1:{server.port}"
        caplog.set_level(logging.DEBUG, logger="aurival")
        async with aiohttp.ClientSession() as session:
            auth = _Auth()
            http = HttpClient(session, base, auth)  # type: ignore[arg-type]
            stop = asyncio.Event()
            sock = socket_module.Socket(
                http,
                auth,  # type: ignore[arg-type]
                dispatch=_never_dispatch,
                on_problem=lambda _p: None,
                backoff_base=0.01,
                backoff_cap=0.02,
            )
            runner = asyncio.create_task(sock.run(stop))
            await asyncio.sleep(0.3)  # a few refused handshakes and backoffs
            stop.set()
            try:
                await asyncio.wait_for(runner, timeout=5)
            except (TimeoutError, asyncio.TimeoutError):
                runner.cancel()

        # The negative assertion below is worthless unless the token really went
        # out on the wire — otherwise "not in the log" is trivially true.
        assert seen_auth, "the handshake never reached the server — this proves nothing"
        assert TOKEN in seen_auth[0], "the socket did not send the token it was given"

        formatter = logging.Formatter()
        haystack = "\n".join(formatter.format(r) for r in caplog.records)
        haystack += "\n" + "\n".join(str(r.exc_info) for r in caplog.records if r.exc_info)
        assert TOKEN not in haystack, "the access token reached a log line via the handshake"
    finally:
        await server.close()
