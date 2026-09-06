"""Proactive access-token rotation (SDK-19): the socket refreshes ahead of the
server's own `bye access_token_expired`, so that bye becomes a rare fallback
instead of the routine 15-minute path.

Two layers: a direct unit test of `Socket._rotation_loop` (fake clock, fake
ws, no real network) proves the ORDER (refresh before close) and the close
code precisely; the rest run a real in-process `aiohttp` websocket server and
assert on what `Socket.run()` DOES end to end.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import aiohttp
import pytest
from test_socket import (
    FakeAuth,
    FakeHttpClient,
    bye_frame,
    make_socket,
    run_gateway,
    send_hello,
    wait_until,
)

from aurival.status import StatusReporter


class FakeStream:
    def __init__(self) -> None:
        self._buf: list[str] = []

    def write(self, text: str) -> None:
        self._buf.append(text)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False

    def getvalue(self) -> str:
        return "".join(self._buf)


class FakeClock:
    """`clock()` / `sleep()` pair the rotation timer is written against. The
    fake clock jumps forward by exactly the requested delay so deadline math
    is exact; `sleep()` also waits `delay * scale` REAL seconds so a chain of
    rotations (each pushing the next deadline hundreds of fake-seconds out by
    the token's real TTL) can't spin the event loop in a tight, real-time-free
    loop — the second rotation in any of these tests is always scaled to land
    outside the test's own timeout.
    """

    def __init__(self, start: float = 1_700_000_000.0, scale: float = 0.01) -> None:
        self.now = start
        self._scale = scale

    def __call__(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        delay = max(0.0, delay)
        # Advance AFTER the real await, not before: a cancelled sleep (a
        # reconnect tore down the connection this rotation task belonged to)
        # must not have "happened" — advancing eagerly let a cancelled task's
        # multi-thousand-fake-second delay leak into the NEXT connection's
        # deadline math and made it fire immediately.
        await asyncio.sleep(delay * self._scale)
        self.now += delay


class StubWs:
    """Duck-types the one `aiohttp.ClientWebSocketResponse` surface
    `_rotation_loop` touches: `.closed` and `close(code=...)`."""

    def __init__(self) -> None:
        self.closed = False
        self.close_calls: list[int] = []

    async def close(self, *, code: int) -> None:
        self.close_calls.append(code)
        self.closed = True


async def _run_until(sock, stop, pred, timeout=2.0):
    task = asyncio.create_task(sock.run(stop))
    try:
        ok = await wait_until(pred, timeout=timeout)
        return ok
    finally:
        stop.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


# --------------------------------------------------------------------------
# (a) unit level: order, deadline math, close code — no network involved
# --------------------------------------------------------------------------


async def test_rotation_loop_refreshes_before_closing_with_code_1000():
    clock = FakeClock(scale=0.0)  # no network here, so no need to spend real time
    auth = FakeAuth(token="tok-0", expires_at=clock.now + 100.0)
    http = FakeHttpClient("wss://example.invalid/v1/gateway")
    calls: list[str] = []

    async def tracking_refresh() -> str:
        calls.append("refresh")
        auth.refresh_calls += 1
        auth.expires_at += auth._ttl
        auth._token = f"{auth._token}+r{auth.refresh_calls}"
        return auth._token

    auth.refresh = tracking_refresh  # type: ignore[method-assign]
    sock, _dispatched, _ = make_socket(
        http,
        auth,
        rotation_headroom=60.0,
        rotation_jitter_max=5.0,
        jitter=lambda: 1.0,  # deterministic: full 5s of jitter, subtracted
        clock=clock,
        sleep=clock.sleep,
    )
    ws = StubWs()

    async def tracking_close(*, code: int) -> None:
        calls.append("close")
        ws.close_calls.append(code)
        ws.closed = True

    ws.close = tracking_close  # type: ignore[method-assign]

    start = clock.now
    await sock._rotation_loop(ws)

    assert calls == ["refresh", "close"], "must refresh BEFORE closing"
    assert ws.close_calls == [aiohttp.WSCloseCode.OK] == [1000]
    # deadline = expires_at(start+100) - headroom(60) - jitter(1.0 * 5.0) = start + 35
    # Compared as a DELTA, not the raw epoch value: `pytest.approx`'s default
    # relative tolerance is against the expected value, so on an epoch-scale
    # float (~1.7e9) it silently accepts anything within ~1700s — completely
    # swallowing the 35s this is actually meant to pin down.
    assert clock.now - start == pytest.approx(35.0)
    assert sock._rotating is True


async def test_rotation_loop_floors_the_delay_when_ttl_is_at_or_under_headroom():
    """A TTL at or under the refresh headroom makes the deadline already
    overdue the instant a connection reads it. Without a floor this would
    compute a ~0 delay every single connection forever — a tight
    refresh/close/redial loop hammering `/v1/token` from the whole fleet at
    once. The delay must floor at `_MIN_ROTATION_INTERVAL` (30s) instead.
    """
    clock = FakeClock(scale=0.0)
    # expires_at(start+50) - headroom(60) - jitter(0) = start - 10: already past.
    auth = FakeAuth(token="tok-0", expires_at=clock.now + 50.0)
    http = FakeHttpClient("wss://example.invalid/v1/gateway")
    sock, _dispatched, _ = make_socket(
        http, auth, rotation_headroom=60.0, jitter=lambda: 0.0, clock=clock, sleep=clock.sleep
    )
    ws = StubWs()
    start = clock.now

    await sock._rotation_loop(ws)

    # Floored at 30.0, not clamped to ~0 by an already-past deadline. Compared
    # as a delta for the same reason as above: raw-epoch `pytest.approx`
    # would accept the unfloored ~0 result too.
    assert clock.now - start == pytest.approx(30.0)
    assert ws.close_calls == [1000]


async def test_rotation_loop_does_not_close_when_refresh_fails():
    clock = FakeClock(scale=0.0)
    auth = FakeAuth(token="tok-0", expires_at=clock.now + 100.0)
    auth.fail_refresh_next(RuntimeError("network blip"))
    http = FakeHttpClient("wss://example.invalid/v1/gateway")
    sock, _dispatched, _ = make_socket(
        http, auth, rotation_headroom=60.0, jitter=lambda: 0.0, clock=clock, sleep=clock.sleep
    )
    ws = StubWs()

    await sock._rotation_loop(ws)

    assert auth.refresh_calls == 1
    assert ws.close_calls == [], "a failed refresh must never close the socket"
    assert sock._rotating is False


# --------------------------------------------------------------------------
# (a continued) / (b) / (c) / (d) / (e): end to end, real in-process gateway
# --------------------------------------------------------------------------


async def test_rotation_reconnects_with_the_new_token_and_prints_nothing():
    async def script(ws, idx, state):
        await send_hello(ws)
        await asyncio.sleep(1.0)

    async with run_gateway(script) as (state, url):
        clock = FakeClock(scale=0.01)
        auth = FakeAuth(token="tok-0", expires_at=clock.now + 100.0)
        http = FakeHttpClient(url)
        stream = FakeStream()
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http,
            auth,
            reporter=reporter,
            bot_name="acme-bot",
            rotation_headroom=60.0,
            jitter=lambda: 0.0,
            clock=clock,
            sleep=clock.sleep,
        )
        stop = asyncio.Event()
        ok = await _run_until(sock, stop, lambda: state.connect_count >= 2, timeout=2.0)
        assert ok, f"never reconnected: {state.connect_count} connections"

    assert auth.refresh_calls == 1, "rotation must call refresh() before closing"
    assert state.auth_headers[0] == "Bearer tok-0"
    assert state.auth_headers[1] == f"Bearer {auth._token}"
    assert auth._token != "tok-0", "reconnect must carry the refreshed token"
    assert "reconnecting" not in stream.getvalue()
    assert "reconnected" not in stream.getvalue()


async def test_rotation_failure_leaves_close_to_the_bye_fallback():
    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            # Long enough for the rotation timer to fire (and fail) first;
            # the real `bye` arrives after, as the fallback.
            await asyncio.sleep(0.5)
            await ws.send_json(bye_frame("access_token_expired", "authentication_error"))
        else:
            await asyncio.sleep(1.0)

    async with run_gateway(script) as (state, url):
        clock = FakeClock(scale=0.01)
        # (70 - 60) * scale = 0.1s real: fires well before the 0.5s bye above.
        auth = FakeAuth(token="tok-0", expires_at=clock.now + 70.0)
        auth.fail_refresh_next(RuntimeError("network blip"))
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(
            http,
            auth,
            rotation_headroom=60.0,
            jitter=lambda: 0.0,
            clock=clock,
            sleep=clock.sleep,
        )
        stop = asyncio.Event()
        ok = await _run_until(sock, stop, lambda: state.connect_count >= 2, timeout=2.0)
        assert ok, "bye fallback never reconnected after a failed rotation"

    # One failed attempt from the rotation timer, one successful one from the
    # bye handler's REAUTH_RECONNECT action — not zero, not more.
    assert auth.refresh_calls == 2


async def test_unplanned_drop_prints_reconnecting_then_reconnected_but_rotation_prints_neither():
    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            await asyncio.sleep(0.05)
            await ws.close()  # bare close: a genuine network-fault drop
        else:
            await asyncio.sleep(0.3)

    async with run_gateway(script) as (_state, url):
        clock = FakeClock(scale=0.01)
        # expires_at far enough out that no rotation fires in this test's window.
        auth = FakeAuth(token="tok-0", expires_at=clock.now + 10_000.0)
        http = FakeHttpClient(url)
        stream = FakeStream()
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http,
            auth,
            reporter=reporter,
            backoff_base=0.01,
            backoff_cap=0.02,
            jitter=lambda: 0.1,
            rotation_headroom=60.0,
            clock=clock,
            sleep=clock.sleep,
        )
        stop = asyncio.Event()
        ok = await _run_until(
            sock, stop, lambda: "reconnected after" in stream.getvalue(), timeout=3.0
        )
        assert ok, f"no reconnected banner: {stream.getvalue()!r}"

    out = stream.getvalue()
    assert "aurival: connection closed" in out and "reconnecting in" in out
    assert "aurival: reconnected after" in out
    assert auth.refresh_calls == 0, "no rotation should have fired in this window"


async def test_access_token_expired_bye_logs_debug_other_codes_log_warning(caplog):
    async def script_expired(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame("access_token_expired", "authentication_error"))

    caplog.set_level(logging.DEBUG, logger="aurival")
    async with run_gateway(script_expired) as (state, url):
        auth = FakeAuth(token="tok-0")
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth, rotation_headroom=60.0)
        stop = asyncio.Event()
        await _run_until(sock, stop, lambda: state.connect_count >= 2)

    debug_records = [r for r in caplog.records if r.levelno == logging.DEBUG]
    warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("bot-api bye: access_token_expired" in r.getMessage() for r in debug_records)
    assert not any("bot-api bye: access_token_expired" in r.getMessage() for r in warning_records)

    caplog.clear()

    async def script_other(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame("idle_timeout", "api_error"))

    async with run_gateway(script_other) as (state, url):
        auth = FakeAuth(token="tok-0")
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth, rotation_headroom=60.0, short_wait_range=(0.01, 0.02))
        stop = asyncio.Event()
        await _run_until(sock, stop, lambda: state.connect_count >= 2)

    warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("bot-api bye: idle_timeout" in r.getMessage() for r in warning_records)


def test_aurival_debug_env_surfaces_debug_lines(monkeypatch):
    import importlib

    monkeypatch.setenv("AURIVAL_DEBUG", "1")
    logger = logging.getLogger("aurival")
    had_handlers = list(logger.handlers)
    had_level = logger.level
    try:
        for h in had_handlers:
            logger.removeHandler(h)
        logger.setLevel(logging.NOTSET)

        from aurival import http as http_module

        importlib.reload(http_module)

        assert http_module._log.name == "aurival"
        assert http_module._log.isEnabledFor(logging.DEBUG)
        assert len(http_module._log.handlers) >= 1
    finally:
        for h in list(logger.handlers):
            logger.removeHandler(h)
        for h in had_handlers:
            logger.addHandler(h)
        logger.setLevel(had_level)
        importlib.reload(__import__("aurival.http", fromlist=["_log"]))


async def test_rotating_flag_does_not_leak_into_the_next_connection_after_a_bye_wins_the_race():
    """Regression: if a `bye` frame is already in flight when the rotation
    timer calls `ws.close()`, `_run_connection` returns that bye instead of
    `None`, and the `bye is None` branch that normally consumes and clears
    `_rotating` is never reached — the flag would otherwise leak into the
    NEXT connection and mislabel its first genuine network-fault close as a
    planned rotation (no `_mark_dropped()`, no backoff, no banner).
    """

    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            await asyncio.sleep(0.05)
            await ws.send_json(bye_frame("server_restarting", "api_error"))
        elif idx == 1:
            await asyncio.sleep(0.05)
            await ws.close()  # bare close: a genuine network-fault drop
        else:
            await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth(token="tok-0")
        http = FakeHttpClient(url)
        stream = FakeStream()
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http,
            auth,
            reporter=reporter,
            backoff_base=0.01,
            backoff_cap=0.02,
            short_wait_range=(0.01, 0.02),
            jitter=lambda: 0.5,
        )

        # Simulate: the rotation timer refreshed and set `_rotating = True`,
        # but its own `ws.close()` lost the race to the `server_restarting`
        # bye already in flight above. Fires ONCE, for connection #0 only —
        # connection #1's own close must be a genuine, untouched network
        # fault, not one this stub re-contaminates on its own.
        fired = False

        async def fake_rotation_loop(ws) -> None:
            nonlocal fired
            if fired:
                await asyncio.sleep(10)  # inert for every later connection
                return
            fired = True
            await asyncio.sleep(0.02)
            sock._rotating = True

        sock._rotation_loop = fake_rotation_loop

        stop = asyncio.Event()
        ok = await _run_until(sock, stop, lambda: state.connect_count >= 3, timeout=3.0)
        assert ok, f"never reached a third connection: {state.connect_count}"

    # Connection #1's bare close is a genuine network fault and must be
    # treated as one: the "network error" reason only `_sleep_backoff`
    # produces (a bye's reason names its code instead, e.g.
    # "server_restarting" for connection #0 above) — a leftover `_rotating`
    # would have skipped `_sleep_backoff` entirely and printed nothing for
    # connection #1's close.
    out = stream.getvalue()
    assert out.count("reconnecting in") == 2, f"expected two reconnect banners: {out!r}"
    assert "aurival: connection closed (server_restarting), reconnecting in" in out
    assert "aurival: connection closed (network error), reconnecting in" in out


async def test_a_cancelled_in_flight_refresh_never_resolves_into_a_later_connection():
    """Stale-refresh cross-check (mirrors a real bug the JS `#rotateToken`
    twin had and fixed with a generation guard): if `_rotation_loop`'s own
    task were only half-cancelled — the deadline timer cancelled but an
    in-flight `await auth.refresh()` left to resolve later — a refresh
    started on a DEAD connection could resolve during a LATER one and set
    `_rotating = True` mid-connection, masking that later connection's next
    genuine fault.

    `_rotation_loop` runs as a real `asyncio.Task` that `_run_connection`'s
    `finally` cancels and awaits on every exit path (both bare-close
    branches and the `bye` branch), so the in-flight `await` should raise
    `CancelledError` — a `BaseException`, so the surrounding bare
    `except Exception:` cannot swallow it — rather than resolving late.
    Proved here with a `refresh()` held open on a future the test controls,
    rather than left to inspection.
    """
    released = asyncio.Event()
    refresh_started = asyncio.Event()

    class HangingAuth(FakeAuth):
        async def refresh(self) -> str:
            refresh_started.set()
            await released.wait()  # the test controls exactly when this returns
            return await super().refresh()

    # `_MIN_ROTATION_INTERVAL` (30s) floors connection #0's own rotation
    # delay at 0.3s real (scale=0.01 below) even with an already-overdue
    # deadline — so connection #0 must stay open at LEAST that long before
    # its scripted bare close, or the close would win the race and the
    # rotation would never even start its refresh.
    CONN0_LIFETIME = 0.6  # > the 0.3s floor, with margin

    async def script(ws, idx, state):
        await send_hello(ws)
        if idx == 0:
            await asyncio.sleep(CONN0_LIFETIME)
            await ws.close()  # bare close while the refresh above is in flight
        elif idx == 1:
            await asyncio.sleep(0.05)
            await ws.close()  # bare close: the genuine fault this test is about
        else:
            await asyncio.sleep(1.0)

    async with run_gateway(script) as (state, url):
        # Way in the past: the rotation deadline is already overdue the
        # instant connection #0's rotation task reads it. The delay floors at
        # `_MIN_ROTATION_INTERVAL` (30s) rather than ~0 now, so a scaled fake
        # clock keeps this fast without changing what's being proved.
        clock = FakeClock(scale=0.01)
        auth = HangingAuth(token="tok-0", expires_at=clock.now)
        http = FakeHttpClient(url)
        stream = FakeStream()
        reporter = StatusReporter(stream=stream)
        sock, _dispatched, _ = make_socket(
            http, auth, reporter=reporter,
            backoff_base=0.01, backoff_cap=0.02, jitter=lambda: 0.0, rotation_headroom=0.0,
            clock=clock, sleep=clock.sleep,
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: refresh_started.is_set(), timeout=3.0)
            assert ok, "connection #0's rotation never started its refresh"

            # Deactivate rotation for every connection FROM HERE ON: with no
            # `expires_at`, `_rotation_loop` just idles in its defensive
            # wait-for-a-token branch instead of calling `refresh()` again.
            # This isolates the test to exactly one question — does the
            # ALREADY-CANCELLED call from connection #0 leak forward — by
            # ruling out connection #1 starting a fresh, uncancelled one of
            # its own.
            auth.expires_at = None

            ok = await wait_until(lambda: state.connect_count >= 2, timeout=2.0)
            assert ok, "never reached connection #1 while the refresh was held open"

            # Release the stale refresh now that connection #0 is dead — its
            # rotation task was cancelled when connection #0 closed, so this
            # must be a no-op: nothing should still be waiting on it.
            released.set()

            ok = await wait_until(lambda: state.connect_count >= 3, timeout=2.0)
            assert ok, f"never reached connection #2: {state.connect_count}"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    assert auth.refresh_calls == 0, (
        "the cancelled refresh must never actually complete, even after being "
        "released — a completed one would have set `_rotating = True` and "
        "masked connection #1's genuine fault below"
    )
    assert not sock._rotating, "a stale refresh must not leave `_rotating` set for later"
    out = stream.getvalue()
    assert "aurival: connection closed (network error), reconnecting in" in out, (
        f"connection #1's genuine bare close was not reported as a fault: {out!r}"
    )


async def test_successive_rotations_are_spaced_by_at_least_the_min_interval():
    """End-to-end version of the same floor: with a TTL at or under the
    headroom, the socket must not hot-loop refresh/close/redial across
    successive connections — each one's own rotation still respects the
    30s floor, so only a bounded, small number of rotations happen in any
    real-time window, never one per event-loop tick.
    """

    async def script(ws, idx, state):
        await send_hello(ws)
        await asyncio.sleep(1.0)  # outlives every rotation in this test

    async with run_gateway(script) as (_state, url):
        clock = FakeClock(scale=0.01)  # 30s floor -> 0.3s real per rotation
        # expires_at - headroom is already in the past for every connection.
        auth = FakeAuth(token="tok-0", expires_at=clock.now + 50.0)
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(
            http, auth, rotation_headroom=60.0, jitter=lambda: 0.0, clock=clock, sleep=clock.sleep
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            # Real 1s window: at the 30s-floor cadence (0.3s real each) this
            # allows at most a handful of rotations, never dozens — the
            # signature of a floor holding versus a hot loop.
            await asyncio.sleep(1.0)
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    assert 1 <= auth.refresh_calls <= 4, (
        f"expected a small, floor-bounded number of rotations, got {auth.refresh_calls} "
        "(a hot loop would run into the hundreds in this window)"
    )
