"""The one-line stderr status banners (connecting/connected/reconnecting/
reconnected/stopped/disconnected): color-on-tty, plain otherwise, silenced by
`quiet=True` or `AURIVAL_QUIET=1`.

Unit tests exercise `StatusReporter` directly with a fake stream. Integration
tests drive a real `Socket` against the in-process gateway harness shared
with `test_socket.py` to prove the banners actually fire at the right wire
moments, not just that the formatting function works in isolation.
"""

from __future__ import annotations

import asyncio
import contextlib
import io

import pytest

from aurival.status import StatusReporter, format_duration
from tests.test_socket import (
    FakeAuth,
    FakeHttpClient,
    bye_frame,
    make_socket,
    run_gateway,
    send_hello,
    wait_until,
)


class _FakeStream(io.StringIO):
    """`io.StringIO` doesn't support `isatty()` toggling; this does."""

    def __init__(self, tty: bool) -> None:
        super().__init__()
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


# --------------------------------------------------------------------------
# format_duration
# --------------------------------------------------------------------------


def test_format_duration_sub_minute_shows_one_decimal_second():
    assert format_duration(2.34) == "2.3s"


def test_format_duration_minutes_and_seconds():
    assert format_duration(65) == "1m 5s"


def test_format_duration_hours_and_minutes():
    assert format_duration(3725) == "1h 2m"


# --------------------------------------------------------------------------
# StatusReporter: color on tty, plain otherwise, quiet suppresses everything
# --------------------------------------------------------------------------


def test_connecting_line_is_colored_on_a_tty():
    stream = _FakeStream(tty=True)
    StatusReporter(stream=stream).connecting("acme-bot")
    out = stream.getvalue()
    assert "aurival: connecting to bots.aurival.com as acme-bot…" in out
    assert "\033[33m" in out  # yellow


def test_connecting_line_is_plain_off_a_tty():
    stream = _FakeStream(tty=False)
    StatusReporter(stream=stream).connecting("acme-bot")
    out = stream.getvalue()
    assert out == "aurival: connecting to bots.aurival.com as acme-bot…\n"
    assert "\033[" not in out


def test_connected_line_shape_and_color():
    stream = _FakeStream(tty=True)
    StatusReporter(stream=stream).connected(bot="acme-bot", session_id="sess_abcdef123456", command_count=3)
    out = stream.getvalue()
    assert (
        "aurival: connected — acme-bot, session sess_abc, 3 commands registered. "
        "Waiting for commands. (Ctrl+C to stop)" in out
    )
    assert "\033[32m" in out  # green


def test_reconnecting_line_shape_and_color():
    stream = _FakeStream(tty=True)
    StatusReporter(stream=stream).reconnecting(reason="idle_timeout", delay_s=2.549)
    out = stream.getvalue()
    assert "aurival: connection closed (idle_timeout), reconnecting in 2.5s…" in out
    assert "\033[33m" in out  # yellow


def test_reconnected_line_shape_and_color():
    stream = _FakeStream(tty=True)
    StatusReporter(stream=stream).reconnected(duration_s=65)
    out = stream.getvalue()
    assert "aurival: reconnected after 1m 5s" in out
    assert "\033[32m" in out  # green


def test_stopped_line_shape_and_color():
    stream = _FakeStream(tty=True)
    StatusReporter(stream=stream).stopped(code="key_revoked", message="this key was revoked.")
    out = stream.getvalue()
    assert "aurival: stopped — key_revoked: this key was revoked." in out
    assert "\033[31m" in out  # red


def test_disconnected_line_shape():
    stream = _FakeStream(tty=False)
    StatusReporter(stream=stream).disconnected(duration_s=5)
    assert stream.getvalue() == "aurival: disconnected after 5.0s\n"


def test_quiet_flag_silences_every_line():
    stream = _FakeStream(tty=True)
    r = StatusReporter(quiet=True, stream=stream)
    r.connecting("b")
    r.connected(bot="b", session_id="s12345678", command_count=1)
    r.reconnecting(reason="network error", delay_s=1.0)
    r.reconnected(duration_s=1.0)
    r.stopped(code="c", message="m")
    r.disconnected(duration_s=1.0)
    assert stream.getvalue() == ""


def test_env_var_quiet_silences_every_line(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AURIVAL_QUIET", "1")
    stream = _FakeStream(tty=True)
    r = StatusReporter(stream=stream)
    r.connecting("b")
    assert stream.getvalue() == ""


def test_env_var_quiet_checked_live_not_cached_at_construction(monkeypatch: pytest.MonkeyPatch):
    stream = _FakeStream(tty=True)
    r = StatusReporter(stream=stream)
    r.connecting("b")
    assert stream.getvalue() != ""
    stream2 = _FakeStream(tty=True)
    r2 = StatusReporter(stream=stream2)
    monkeypatch.setenv("AURIVAL_QUIET", "1")
    r2.connecting("b")
    assert stream2.getvalue() == ""


# --------------------------------------------------------------------------
# Wired into Socket: the banners fire at the real wire moments
# --------------------------------------------------------------------------


async def test_socket_prints_connected_on_first_hello():
    async def script(ws, idx, state):
        await send_hello(ws)
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http, auth, reporter=reporter, bot_name="acme-bot", command_count=2
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: "connected" in stream.getvalue())
            assert ok, "no connected banner printed"
            assert (
                "aurival: connected — acme-bot, session s, 2 commands registered. "
                "Waiting for commands. (Ctrl+C to stop)" in stream.getvalue()
            )
            assert sock.first_connected_at is not None
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_socket_prints_reconnecting_before_backoff_sleep():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.close()  # bare close -> network fault -> backoff

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(http, auth, reporter=reporter, bot_name="acme-bot")
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: "reconnecting" in stream.getvalue())
            assert ok, "no reconnecting banner printed"
            assert "aurival: connection closed (network error), reconnecting in" in stream.getvalue()
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_socket_prints_reconnecting_with_bye_code_for_short_wait():
    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            await ws.send_json(bye_frame("idle_timeout", "api_error"))
        else:
            await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(http, auth, reporter=reporter, bot_name="acme-bot")
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: "idle_timeout" in stream.getvalue())
            assert ok, "reconnecting banner never named the bye code"
            assert "aurival: connection closed (idle_timeout), reconnecting in" in stream.getvalue()
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_socket_prints_reconnected_on_second_hello():
    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            await ws.close()
        else:
            await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http, auth, reporter=reporter, bot_name="acme-bot",
            backoff_base=0.01, backoff_cap=0.02, jitter=lambda: 0.1,
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: "reconnected after" in stream.getvalue(), timeout=3.0)
            assert ok, f"no reconnected banner printed: {stream.getvalue()!r}"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_socket_prints_stopped_before_raising_on_bye_raise_action():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame("key_revoked", "invalid_request_error"))

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(http, auth, reporter=reporter, bot_name="acme-bot")
        stop = asyncio.Event()
        with pytest.raises(Exception):
            await sock.run(stop)
        assert "aurival: stopped — key_revoked: bye: key_revoked" in stream.getvalue()


async def test_socket_status_lines_suppressed_when_quiet():
    async def script(ws, idx, state):
        await send_hello(ws)
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        stream = _FakeStream(tty=False)
        reporter = StatusReporter(quiet=True, stream=stream)
        sock, _dispatched, _ = make_socket(
            http, auth, reporter=reporter, bot_name="acme-bot", command_count=2
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: sock.first_connected_at is not None)
            await asyncio.sleep(0.05)
            assert stream.getvalue() == ""
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
