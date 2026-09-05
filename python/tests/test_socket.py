"""Behavioural tests for `Socket`: a real in-process `aiohttp` websocket server
sends the actual frames, and we assert on what the socket DOES — never on the
`BYE_ACTIONS` dict directly (that agrees with itself and can never fail).

Shared harness: `ServerState`, `build_app`, `run_gateway`, `FakeAuth`,
`FakeHttpClient`, `wait_until`. `test_bye_table.py` imports these too.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import Awaitable, Callable

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival.errors import AurivalAPIError
from aurival.events import Event
from aurival.socket import Socket

# --------------------------------------------------------------------------
# Harness
# --------------------------------------------------------------------------


class FakeAuth:
    """Duck-types `Auth`: `token()` / `refresh()`. Errors are queued FIFO so a
    test can script "fail once, then succeed"."""

    def __init__(self, token: str = "tok-0") -> None:
        self._token = token
        self.token_calls = 0
        self.refresh_calls = 0
        self._token_errors: list[Exception] = []
        self._refresh_errors: list[Exception] = []

    def fail_token_next(self, exc: Exception) -> None:
        self._token_errors.append(exc)

    def fail_refresh_next(self, exc: Exception) -> None:
        self._refresh_errors.append(exc)

    async def token(self) -> str:
        self.token_calls += 1
        if self._token_errors:
            raise self._token_errors.pop(0)
        return self._token

    async def refresh(self) -> str:
        self.refresh_calls += 1
        if self._refresh_errors:
            raise self._refresh_errors.pop(0)
        self._token = f"{self._token}+r{self.refresh_calls}"
        return self._token


class FakeHttpClient:
    """Duck-types `HttpClient`: only `gateway_url()` is exercised here."""

    def __init__(self, url: str) -> None:
        self._url = url

    def gateway_url(self) -> str:
        return self._url


class ServerState:
    def __init__(self) -> None:
        self.connect_count = 0
        self.connect_times: list[float] = []
        # (connection index, op, d) for every client -> server frame
        self.received: list[tuple[int, str, dict]] = []

    def acks_for(self, conn_idx: int) -> list[str]:
        return [d["event_id"] for i, op, d in self.received if i == conn_idx and op == "ack"]

    def heartbeats_for(self, conn_idx: int) -> int:
        return sum(1 for i, op, _ in self.received if i == conn_idx and op == "heartbeat")


Script = Callable[[web.WebSocketResponse, int, ServerState], Awaitable[None]]


def build_app(state: ServerState, script: Script) -> web.Application:
    async def handler(request: web.Request) -> web.WebSocketResponse:
        idx = state.connect_count
        state.connect_count += 1
        state.connect_times.append(time.monotonic())
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        async def reader() -> None:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    frame = json.loads(msg.data)
                    state.received.append((idx, frame.get("op"), frame.get("d") or {}))

        reader_task = asyncio.create_task(reader())
        try:
            await script(ws, idx, state)
        finally:
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader_task
        return ws

    app = web.Application()
    app.router.add_get("/v1/gateway", handler)
    return app


@contextlib.asynccontextmanager
async def run_gateway(script: Script):
    state = ServerState()
    app = build_app(state, script)
    server = TestServer(app)
    await server.start_server()
    try:
        yield state, str(server.make_url("/v1/gateway"))
    finally:
        await server.close()


async def wait_until(
    pred: Callable[[], bool], timeout: float = 2.0, interval: float = 0.005
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        await asyncio.sleep(interval)
    return False


async def send_hello(ws: web.WebSocketResponse, heartbeat_ms: int = 20) -> None:
    await ws.send_json(
        {
            "op": "hello",
            "d": {
                "session_id": "s",
                "heartbeat_interval_ms": heartbeat_ms,
                "resuming_from_sequence": 0,
            },
        }
    )


def bye_frame(code: str, error_type: str) -> dict:
    return {
        "op": "bye",
        "d": {
            "error": {
                "type": error_type,
                "code": code,
                "message": f"bye: {code}",
                "doc_url": f"https://bots.aurival.com/docs/errors#{code}",
                "request_id": "req_1",
            }
        },
    }


def problem_frame(code: str, error_type: str = "invalid_request_error") -> dict:
    return {
        "op": "problem",
        "d": {
            "error": {
                "type": error_type,
                "code": code,
                "message": f"problem: {code}",
                "doc_url": f"https://bots.aurival.com/docs/errors#{code}",
                "request_id": "req_1",
            }
        },
    }


def command_invoked_event(event_id: str, *, sequence: int = 1) -> dict:
    return {
        "op": "event",
        "d": {
            "object": "event",
            "id": event_id,
            "type": "command.invoked",
            "created_at": "2026-01-01T00:00:00Z",
            "sequence": sequence,
            "data": {
                "command": "ping",
                "arguments": "",
                "message": "msg_1",
                "chat": {"object": "chat", "id": "chat_1", "type": "dm", "name": None},
                "sender": {"object": "user", "id": "user_1", "handle": "h", "name": "n"},
            },
        },
    }


def backlog_overflowed_event(event_id: str = "evt_bo") -> dict:
    return {
        "op": "event",
        "d": {
            "object": "event",
            "id": event_id,
            "type": "backlog.overflowed",
            "created_at": "2026-01-01T00:00:00Z",
            "sequence": 0,
            "data": {"dropped_count": 5, "resume_sequence": 42},
        },
    }


def make_socket(http, auth, *, dispatch=None, on_problem=None, **kw) -> tuple[Socket, list, list]:
    dispatched: list[Event] = []
    problems: list = []

    async def _dispatch(event: Event) -> None:
        dispatched.append(event)
        if dispatch is not None:
            await dispatch(event)

    def _on_problem(x) -> None:
        problems.append(x)
        if on_problem is not None:
            on_problem(x)

    # Deterministic, millisecond-scale waits — the same code path production
    # uses, just tiny numbers and a fixed (non-random) jitter. A test may
    # override any of these through `**kw`.
    opts = dict(
        backoff_base=0.01, backoff_cap=0.05, short_wait_range=(0.02, 0.03), jitter=lambda: 0.5
    )
    opts.update(kw)
    sock = Socket(http, auth, dispatch=_dispatch, on_problem=_on_problem, **opts)
    return sock, dispatched, problems


# --------------------------------------------------------------------------
# Heartbeat: its own task, off the dispatch path
# --------------------------------------------------------------------------


async def test_heartbeat_runs_independently_of_slow_handler():
    handler_started = asyncio.Event()

    async def slow_dispatch(event: Event) -> None:
        handler_started.set()
        await asyncio.sleep(0.15)  # much longer than the 20ms heartbeat interval

    async def script(ws, idx, state):
        await send_hello(ws, heartbeat_ms=20)
        await ws.send_json(command_invoked_event("evt_1"))
        await asyncio.sleep(0.2)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(http, auth, dispatch=slow_dispatch)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: handler_started.is_set())
            # The handler is asleep. Heartbeats must keep flowing anyway.
            ok = await wait_until(lambda: state.heartbeats_for(0) >= 3, timeout=1.0)
            assert ok, f"only {state.heartbeats_for(0)} heartbeats while handler slept"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# Ack timing: only after the handler returns
# --------------------------------------------------------------------------


async def test_event_acked_only_after_handler_returns():
    release = asyncio.Event()

    async def gated_dispatch(event: Event) -> None:
        await release.wait()

    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(command_invoked_event("evt_1"))
        await asyncio.sleep(0.5)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, dispatched, _ = make_socket(http, auth, dispatch=gated_dispatch)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: len(dispatched) == 1)
            await asyncio.sleep(0.05)
            assert state.acks_for(0) == [], "acked before the handler returned"
            release.set()
            ok = await wait_until(lambda: state.acks_for(0) == ["evt_1"])
            assert ok, "never acked after the handler returned"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# Dedupe: same id delivered twice runs the handler once
# --------------------------------------------------------------------------


async def test_duplicate_event_id_runs_handler_once():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(command_invoked_event("evt_dup"))
        await asyncio.sleep(0.05)
        await ws.send_json(command_invoked_event("evt_dup"))  # redelivered, already done
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, dispatched, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: state.acks_for(0).count("evt_dup") >= 2, timeout=1.0)
            assert len(dispatched) == 1, f"handler ran {len(dispatched)} times, want 1"
            # The second delivery still gets acked (idempotent), never re-run.
            assert state.acks_for(0).count("evt_dup") == 2
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def test_in_flight_event_never_dispatched_again():
    started = asyncio.Event()
    release = asyncio.Event()
    run_count = 0

    async def dispatch(event: Event) -> None:
        nonlocal run_count
        run_count += 1
        started.set()
        await release.wait()

    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(command_invoked_event("evt_inflight"))
        await wait_until_true_or_timeout()
        await ws.send_json(command_invoked_event("evt_inflight"))  # arrives while still in flight
        await asyncio.sleep(0.3)

    async def wait_until_true_or_timeout():
        for _ in range(200):
            if started.is_set():
                return
            await asyncio.sleep(0.005)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(http, auth, dispatch=dispatch)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: started.is_set())
            await asyncio.sleep(0.05)
            assert run_count == 1
            release.set()
            await wait_until(lambda: state.acks_for(0) == ["evt_inflight"])
            assert run_count == 1, "the still-in-flight redelivery ran the handler again"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# Unknown op / unknown event type: ignored, never fatal
# --------------------------------------------------------------------------


async def test_unknown_op_and_unknown_event_type_ignored_and_socket_survives():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json({"op": "something_new_from_the_future", "d": {}})
        await ws.send_json(
            {
                "op": "event",
                "d": {
                    "object": "event",
                    "id": "evt_future",
                    "type": "reaction.added",  # a type this SDK does not know
                    "created_at": "2026-01-01T00:00:00Z",
                    "sequence": 2,
                    "data": {},
                },
            }
        )
        await ws.send_json(command_invoked_event("evt_after"))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, dispatched, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: "evt_after" in state.acks_for(0))
            assert ok, "socket did not survive the unknown op / unknown event type"
            assert len(dispatched) == 1 and dispatched[0].id == "evt_after"
            # The unknown-type event was acked (kept the durable stream moving)
            # but never handed to a handler.
            assert "evt_future" in state.acks_for(0)
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# `problem`: WARNING + hook, socket survives
# --------------------------------------------------------------------------


async def test_problem_frame_reaches_hook_and_socket_survives(caplog):
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(problem_frame("ack_unknown_event"))
        await ws.send_json(command_invoked_event("evt_after"))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _dispatched, problems = make_socket(http, auth)
        stop = asyncio.Event()
        with caplog.at_level("WARNING", logger="aurival"):
            task = asyncio.create_task(sock.run(stop))
            try:
                ok = await wait_until(lambda: "evt_after" in state.acks_for(0))
                assert ok, "socket did not survive the problem frame"
            finally:
                stop.set()
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        assert len(problems) == 1
        assert isinstance(problems[0], AurivalAPIError)
        assert problems[0].code == "ack_unknown_event"
        assert any(r.levelname == "WARNING" for r in caplog.records)


# --------------------------------------------------------------------------
# backlog.overflowed: log + hook, never a handler
# --------------------------------------------------------------------------


async def test_backlog_overflowed_goes_to_log_and_hook_not_handler(caplog):
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.send_json(backlog_overflowed_event())
        await ws.send_json(command_invoked_event("evt_after"))
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, dispatched, problems = make_socket(http, auth)
        stop = asyncio.Event()
        with caplog.at_level("WARNING", logger="aurival"):
            task = asyncio.create_task(sock.run(stop))
            try:
                ok = await wait_until(lambda: "evt_after" in state.acks_for(0))
                assert ok
            finally:
                stop.set()
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        assert len(dispatched) == 1 and dispatched[0].id == "evt_after"
        assert len(problems) == 1
        assert isinstance(problems[0], Event)
        assert problems[0].type == "backlog.overflowed"
        # Never acked: it has no durable row (server would answer
        # ack_unknown_event if we tried).
        assert "evt_bo" not in state.acks_for(0)
        assert any(r.levelname == "WARNING" for r in caplog.records)


# --------------------------------------------------------------------------
# Across a reconnect: in-flight handlers finish, their ack is dropped,
# redelivery is re-acked without re-running.
# --------------------------------------------------------------------------


async def test_reconnect_drops_stale_ack_and_reacks_without_rerun():
    started = asyncio.Event()
    release = asyncio.Event()
    redeliver_now = asyncio.Event()
    run_count = 0

    async def dispatch(event: Event) -> None:
        nonlocal run_count
        run_count += 1
        started.set()
        await release.wait()

    async def script(ws, idx, state):
        if idx == 0:
            await send_hello(ws)
            await ws.send_json(command_invoked_event("evt_x"))
            # Die while the handler is still in flight — no bye, a bare close.
            await asyncio.sleep(0.05)
            await ws.close()
        else:
            await send_hello(ws)
            # Wait for the test to confirm the stale handler already finished
            # (and dropped its ack) before redelivering on the new session —
            # exactly the ordering RedeliverAfter guarantees in production.
            await redeliver_now.wait()
            await ws.send_json(command_invoked_event("evt_x"))
            await asyncio.sleep(0.4)

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(http, auth, dispatch=dispatch)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            await wait_until(lambda: started.is_set())
            await wait_until(lambda: state.connect_count >= 2)
            # The handler is still running (never cancelled) when the second
            # connection opens.
            assert run_count == 1
            release.set()
            await asyncio.sleep(0.05)  # let the stale handler finish and drop its ack
            assert state.acks_for(0) == [], "an ack was sent on the dead connection"
            redeliver_now.set()
            ok = await wait_until(lambda: "evt_x" in state.acks_for(1), timeout=2.0)
            assert ok, "the redelivered event was never acked on the new connection"
            assert run_count == 1, "the handler ran again instead of just re-acking"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# No `bye`: escalating backoff
# --------------------------------------------------------------------------


async def test_close_with_no_bye_backs_off_and_reconnects():
    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.close()  # bare close, no bye — a network fault by contract

    async with run_gateway(script) as (state, url):
        auth = FakeAuth()
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: state.connect_count >= 2, timeout=2.0)
            assert ok, "never reconnected after a bare close"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# --------------------------------------------------------------------------
# `/v1/token` 5xx during a reconnect: keep backing off, never raise
# --------------------------------------------------------------------------


async def test_token_5xx_during_reconnect_keeps_backing_off_never_raises():
    from aurival.errors import InternalError

    async def script(ws, idx, state):
        await send_hello(ws)
        await ws.close()

    async with run_gateway(script) as (_state, url):
        auth = FakeAuth()
        # The first two reconnect attempts fail to get a token at all (5xx).
        auth.fail_token_next(
            InternalError(
                type="api_error", code="internal_error", message="x", doc_url="x", request_id=None
            )
        )
        auth.fail_token_next(
            InternalError(
                type="api_error", code="internal_error", message="x", doc_url="x", request_id=None
            )
        )
        http = FakeHttpClient(url)
        sock, _dispatched, _ = make_socket(http, auth)
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            ok = await wait_until(lambda: auth.token_calls >= 3, timeout=2.0)
            assert ok, "gave up asking for a token instead of backing off"
            assert not task.done(), "run() raised instead of backing off on a token 5xx"
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
