"""Every row of the `bye` table gets a behavioural test: a real in-process
`aiohttp` websocket server sends the actual `bye`, and we assert on what
`Socket.run()` DOES — reconnect, wait, or raise — never on `BYE_ACTIONS`
directly.
"""

from __future__ import annotations

import asyncio
import contextlib

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

from aurival.errors import AurivalAPIError, AuthenticationError
from aurival.socket import ByeAction, action_for_bye

# --------------------------------------------------------------------------
# action_for_bye: pure fallback logic, independent of the table's contents
# --------------------------------------------------------------------------


def test_action_for_bye_known_code_ignores_type():
    # A known code's action does not depend on what `type` accompanies it.
    assert action_for_bye("key_revoked", "invalid_request_error") == ByeAction.RAISE


@pytest.mark.parametrize(
    ("error_type", "expected"),
    [
        ("api_error", ByeAction.SHORT_WAIT_RECONNECT),
        ("authentication_error", ByeAction.RAISE),
        ("invalid_request_error", ByeAction.RAISE),
        ("permission_error", ByeAction.RAISE),
        ("rate_limit_error", ByeAction.RAISE),
    ],
)
def test_action_for_bye_unknown_code_falls_back_on_type(error_type, expected):
    assert action_for_bye("some_future_code_not_in_the_table", error_type) == expected


# --------------------------------------------------------------------------
# access_token_expired: reauth, reconnect NOW, no backoff, "once" per
# connection (not per process)
# --------------------------------------------------------------------------


async def test_access_token_expired_reconnects_immediately_twice_per_connection():
    async def script(ws, idx, state):
        if idx < 2:
            await send_hello(ws)
            await ws.send_json(bye_frame("access_token_expired", "authentication_error"))
        else:
            await send_hello(ws)
            await asyncio.sleep(0.5)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: state.connect_count >= 3, timeout=2.0)
            assert ok, f"only {state.connect_count} connections, want 3"
            # Two byes, two reconnects -> two re-exchanges. Not one (per
            # process), not zero.
            assert auth.refresh_calls == 2
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_access_token_expired_reconnect_is_immediate_not_backed_off():
    async def script(ws, idx, state):
        if idx == 0:
            await send_hello(ws)
            await ws.send_json(bye_frame("access_token_expired", "authentication_error"))
        else:
            await send_hello(ws)
            await asyncio.sleep(0.5)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        # backoff_base is large; if REAUTH_RECONNECT ever slept on it, the
        # second connection would land far later than immediate.
        sock, _, _ = make_socket(http, auth, backoff_base=5.0, backoff_cap=5.0)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: state.connect_count >= 2, timeout=2.0)
            assert ok
            elapsed = state.connect_times[1] - state.connect_times[0]
            assert elapsed < 0.5, f"reconnect took {elapsed}s — that's a backoff, not immediate"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_access_token_expired_reexchange_failure_raises():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame("access_token_expired", "authentication_error"))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        auth.fail_refresh_next(
            AuthenticationError(
                type="authentication_error",
                code="bad_assertion",
                message="x",
                doc_url="x",
                request_id=None,
            )
        )
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        with pytest.raises(AuthenticationError):
            await asyncio.wait_for(sock.run(stop), timeout=2.0)
        assert state.connect_count == 1, "reconnected despite the re-exchange failing"


# --------------------------------------------------------------------------
# The nine RAISE codes: no reconnect
# --------------------------------------------------------------------------


RAISE_CODES = [
    ("key_revoked", "authentication_error"),
    ("key_already_paired", "authentication_error"),
    ("access_token_invalid", "authentication_error"),
    ("session_superseded", "invalid_request_error"),
    ("frame_too_large", "invalid_request_error"),
    ("bot_suspended", "permission_error"),
    # SDK-39: these three arrive as a `bye` at HEAD on the fiftieth `problem`
    # (gateway.go's MaxSocketProblemsBeforeBye) — the table names them, not
    # `too_many_problems`, which has no producing path yet.
    ("frame_invalid", "invalid_request_error"),
    ("unknown_operation", "invalid_request_error"),
    ("ack_unknown_event", "invalid_request_error"),
]


@pytest.mark.parametrize(("code", "error_type"), RAISE_CODES)
async def test_bye_raises_and_never_reconnects(code, error_type):
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame(code, error_type))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        with pytest.raises(AurivalAPIError) as excinfo:
            await asyncio.wait_for(sock.run(stop), timeout=2.0)
        assert excinfo.value.code == code
        assert state.connect_count == 1, "reconnected after a code the table says to raise on"


# --------------------------------------------------------------------------
# server_restarting / idle_timeout: ONE short jittered wait, not escalating
# --------------------------------------------------------------------------


@pytest.mark.parametrize("code", ["server_restarting", "idle_timeout"])
async def test_bye_short_wait_reconnects_without_escalating(code):
    async def script(ws, idx, state):
        if idx == 0:
            await send_hello(ws)
            await ws.send_json(bye_frame(code, "api_error"))
        else:
            await send_hello(ws)
            await asyncio.sleep(0.5)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        # Fixed jitter (0.5) makes both waits deterministic:
        #   short wait  = 0.02 + 0.5*(0.03-0.02)      = 0.025s
        #   escalating  = 0.5 * 0.01 * 2**0            = 0.005s, then 0.01, 0.02, 0.04, 0.05(cap)...
        # Chosen apart so a mutation to the escalating path is visible either way.
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: state.connect_count >= 2, timeout=2.0)
            assert ok
            elapsed = state.connect_times[1] - state.connect_times[0]
            # Short-wait range is (0.02, 0.03); give generous slack for
            # scheduling jitter but stay well clear of "instant" (REAUTH) and
            # of many-second escalating backoff.
            assert 0.015 <= elapsed <= 0.5, f"elapsed={elapsed}, not a single short wait"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# Unknown bye code: falls back on the ERRORS-V1 type, behaviourally
# --------------------------------------------------------------------------


async def test_unknown_bye_code_with_api_error_type_reconnects():
    async def script(ws, idx, state):
        if idx == 0:
            await send_hello(ws)
            await ws.send_json(bye_frame("brand_new_code_not_in_any_table", "api_error"))
        else:
            await send_hello(ws)
            await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: state.connect_count >= 2, timeout=2.0)
            assert ok, "an unknown api_error-typed bye did not reconnect"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_unknown_bye_code_with_other_type_raises():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(bye_frame("brand_new_code_not_in_any_table", "invalid_request_error"))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _, _ = make_socket(http, auth)
        stop = asyncio.Event()
        with pytest.raises(AurivalAPIError):
            await asyncio.wait_for(sock.run(stop), timeout=2.0)
        assert state.connect_count == 1
