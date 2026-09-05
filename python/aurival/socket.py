"""The live connection: `hello`, heartbeat, dispatch, acks, `problem`/`bye`
handling, reconnect (SOCKET-V1, DECISIONS SDK-23..28, SDK-39).

There are no WebSocket close codes in this API — every close is 1000, and a
close with no `bye` is a network fault, never a designed signal. The `bye`
payload is the only error channel; never branch on a close code.
"""

from __future__ import annotations

import asyncio
import contextlib
import enum
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import aiohttp

from aurival.errors import (
    AurivalAPIError,
    AuthenticationError,
    ProtocolError,
    TransportError,
    from_envelope,
)
from aurival.events import Event

if TYPE_CHECKING:
    from aurival.auth import Auth
    from aurival.http import HttpClient
    from aurival.status import StatusReporter

EVENT_COMMAND_INVOKED = "command.invoked"
EVENT_BACKLOG_OVERFLOWED = "backlog.overflowed"

_DEFAULT_HEARTBEAT_S = 30.0


class ByeAction(enum.Enum):
    REAUTH_RECONNECT = "reauth_reconnect"  # re-exchange, reconnect NOW, no backoff
    SHORT_WAIT_RECONNECT = "short_wait"  # ONE jittered wait, 1-5s, not escalating
    RAISE = "raise"  # stop; this is a bug, not a blip


# The table, exactly (SOCKET-V1 §4, PLAN.md "The socket, exactly", SDK-39).
#
# `frame_invalid`/`unknown_operation`/`ack_unknown_event` are here because a
# `problem` frame can graduate to a `bye` — not because a `problem` is itself
# fatal; it never is.
#
# BA-R23 HAS LANDED and the graduating `bye` now carries `too_many_problems`
# (gateway.go:170, errors_v1.go:325, SOCKET-V1 §4). SDK-39 was written while it
# was ruled-but-unimplemented and this comment used to say the code had no
# producing path — it does. The other three rows stay: they are still what an
# older service sends, and an SDK that dropped them would misread a live wire.
BYE_ACTIONS: dict[str, ByeAction] = {
    "access_token_expired": ByeAction.REAUTH_RECONNECT,
    "key_revoked": ByeAction.RAISE,
    "key_already_paired": ByeAction.RAISE,
    "access_token_invalid": ByeAction.RAISE,
    "session_superseded": ByeAction.RAISE,
    "frame_too_large": ByeAction.RAISE,
    "frame_invalid": ByeAction.RAISE,
    "unknown_operation": ByeAction.RAISE,
    "ack_unknown_event": ByeAction.RAISE,
    "too_many_problems": ByeAction.RAISE,
    "bot_suspended": ByeAction.RAISE,
    "server_restarting": ByeAction.SHORT_WAIT_RECONNECT,
    "idle_timeout": ByeAction.SHORT_WAIT_RECONNECT,
}


def action_for_bye(code: str, error_type: str) -> ByeAction:
    """Unknown code falls back on the ERRORS-V1 `type` (SDK-11 / BA-R24):
    `api_error` reconnects (a short wait, matching `server_restarting` and
    `idle_timeout`, its only other members), everything else raises."""
    action = BYE_ACTIONS.get(code)
    if action is not None:
        return action
    return ByeAction.SHORT_WAIT_RECONNECT if error_type == "api_error" else ByeAction.RAISE


class Socket:
    """One bot's live connection. `run(stop)` owns reconnect forever, until
    `stop` fires or a `bye` says the credential itself is dead."""

    def __init__(
        self,
        http: HttpClient,
        auth: Auth,
        *,
        dispatch: Callable[[Event], Awaitable[None]],
        on_problem: Callable[[AurivalAPIError | Event], None],
        logger: logging.Logger | None = None,
        seen_limit: int = 10_000,
        # Injectable backoff seam — same code path production uses, just with
        # tighter numbers, so a test runs in milliseconds rather than minutes.
        backoff_base: float = 1.0,
        backoff_cap: float = 60.0,
        short_wait_range: tuple[float, float] = (1.0, 5.0),
        jitter: Callable[[], float] = random.random,
        # Status UX seam (additive, never wire-affecting): `reporter` prints
        # the one-line connect/reconnect/stop banners; `bot_name` and
        # `command_count` are display-only values `Bot` already knows.
        reporter: StatusReporter | None = None,
        bot_name: str = "",
        command_count: int = 0,
    ) -> None:
        self._http = http
        self._auth = auth
        self._dispatch = dispatch
        self._on_problem = on_problem
        self._logger = logger or logging.getLogger("aurival")
        self._seen_limit = seen_limit
        self._seen: dict[str, None] = {}
        self._in_flight: dict[str, asyncio.Task[None]] = {}
        self._generation = 0
        self._backoff_n = 0
        self._backoff_base = backoff_base
        self._backoff_cap = backoff_cap
        self._short_wait_range = short_wait_range
        self._jitter = jitter
        self._reporter = reporter
        self._bot_name = bot_name
        self._command_count = command_count
        self._ever_hello = False
        self._drop_time: float | None = None
        # Public: `Bot` reads this after a clean `run()` return to print
        # "disconnected after <uptime>". `None` means we never connected.
        self.first_connected_at: float | None = None

    async def run(self, stop: asyncio.Event) -> None:
        async with aiohttp.ClientSession() as ws_session:
            while not stop.is_set():
                try:
                    token = await self._auth.token()
                except AuthenticationError:
                    raise
                except (AurivalAPIError, TransportError, ProtocolError):
                    if await self._sleep_backoff(stop):
                        return
                    continue

                bye: AurivalAPIError | None
                try:
                    async with ws_session.ws_connect(
                        self._http.gateway_url(),
                        headers={"Authorization": f"Bearer {token}"},
                    ) as ws:
                        bye = await self._run_connection(ws, stop)
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
                    bye = None
                    if stop.is_set():
                        return
                    if await self._sleep_backoff(stop):
                        return
                    continue

                if stop.is_set():
                    return

                if bye is None:
                    # A close with no `bye`: a network fault, never a designed
                    # signal (SOCKET-V1 §1). Escalating backoff, unbounded.
                    if await self._sleep_backoff(stop):
                        return
                    continue

                action = action_for_bye(bye.code, bye.type)
                if action is ByeAction.RAISE:
                    if self._reporter is not None:
                        self._reporter.stopped(code=bye.code, message=bye.message)
                    raise bye
                if action is ByeAction.REAUTH_RECONNECT:
                    try:
                        await self._auth.refresh()
                    except AuthenticationError:
                        raise
                    except (AurivalAPIError, TransportError, ProtocolError):
                        # The exchange itself is unwell (e.g. `/v1/token` 5xx):
                        # keep backing off, never raise (SDK-26).
                        if await self._sleep_backoff(stop, reason=bye.code):
                            return
                    continue  # reconnect NOW — no backoff, "once" per connection
                if action is ByeAction.SHORT_WAIT_RECONNECT:
                    if await self._short_wait(stop, reason=bye.code):
                        return
                    continue

    async def _run_connection(
        self, ws: aiohttp.ClientWebSocketResponse, stop: asyncio.Event
    ) -> AurivalAPIError | None:
        """Reads frames until the socket closes. Returns the `bye` error if one
        arrived, else `None` — a network-fault close, per SOCKET-V1 §1."""
        self._generation += 1
        generation = self._generation
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            while True:
                msg = await self._receive_or_stop(ws, stop)
                if msg is None:
                    await ws.close()
                    self._mark_dropped()
                    return None
                if msg.type in (
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSING,
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.ERROR,
                ):
                    self._mark_dropped()
                    return None
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    raw = json.loads(msg.data)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(raw, dict):
                    continue
                op = raw.get("op")
                d = raw.get("d")
                d = d if isinstance(d, dict) else {}

                if op == "hello":
                    interval_ms = d.get("heartbeat_interval_ms")
                    interval_s = (
                        interval_ms / 1000
                        if isinstance(interval_ms, int | float) and interval_ms > 0
                        else _DEFAULT_HEARTBEAT_S
                    )
                    # We reached a live session: the next fault is a fresh
                    # problem, not a continuation of the last one.
                    self._backoff_n = 0
                    self._on_hello(d.get("session_id"))
                    if heartbeat_task is not None:
                        heartbeat_task.cancel()
                    heartbeat_task = asyncio.create_task(self._heartbeat_loop(ws, interval_s))
                elif op == "heartbeat_ack":
                    pass
                elif op == "event":
                    await self._handle_event(ws, d, generation)
                elif op == "problem":
                    exc = from_envelope(d)
                    self._logger.warning("bot-api problem: %s: %s", exc.code, exc.message)
                    self._on_problem(exc)
                elif op == "bye":
                    exc = from_envelope(d)
                    self._logger.warning("bot-api bye: %s: %s", exc.code, exc.message)
                    self._mark_dropped()
                    return exc
                # else: unknown op. Ignored, never fatal (CONTRACT-V1 §3, §9).
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task

    async def _receive_or_stop(
        self, ws: aiohttp.ClientWebSocketResponse, stop: asyncio.Event
    ) -> aiohttp.WSMessage | None:
        """`None` means `stop` fired while we were waiting on a frame — a read
        must never sit behind an unbounded wait a SIGINT cannot reach."""
        recv_task: asyncio.Task[aiohttp.WSMessage] = asyncio.ensure_future(ws.receive())
        stop_task: asyncio.Task[bool] = asyncio.ensure_future(stop.wait())
        try:
            done, _ = await asyncio.wait(
                {recv_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if recv_task in done:
                return recv_task.result()
            return None
        finally:
            for t in (recv_task, stop_task):
                if not t.done():
                    t.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await t

    async def _heartbeat_loop(self, ws: aiohttp.ClientWebSocketResponse, interval_s: float) -> None:
        # Its own task, never on the dispatch path — a slow handler must not
        # starve it, or the server reaps us at 3x this interval.
        try:
            while True:
                await asyncio.sleep(interval_s)
                if ws.closed:
                    return
                await ws.send_str(json.dumps({"op": "heartbeat", "d": {}}))
        except asyncio.CancelledError:
            raise
        except Exception:
            return  # connection is gone; the read loop will notice

    async def _handle_event(
        self, ws: aiohttp.ClientWebSocketResponse, d: dict, generation: int
    ) -> None:
        event = Event.from_frame(d)
        if not event.id:
            return
        if event.id in self._in_flight:
            return  # never dispatch an id whose handler is still in flight
        if event.id in self._seen:
            # Already ran to completion — possibly on a prior connection whose
            # ack got dropped when it died mid-flight, and this is that same
            # event redelivered. Don't run the handler again; a duplicate ack
            # of a real event is harmless (gateway.go: "still fine"), and
            # skipping it here would leave the server redelivering forever.
            await self._ack(ws, event.id, generation)
            return

        if event.type == EVENT_BACKLOG_OVERFLOWED:
            # An event, not a problem — it goes to the log and the hook, never
            # to a handler (SDK-28). NOT acked: it has no durable row
            # (`gateway.go`'s drain generates it at delivery), so acking it
            # would earn `ack_unknown_event` right back.
            self._logger.warning(
                "backlog overflowed: dropped=%s resume_sequence=%s",
                event.data.get("dropped_count"),
                event.data.get("resume_sequence"),
            )
            self._on_problem(event)
            self._mark_seen(event.id)
            return

        if event.type != EVENT_COMMAND_INVOKED:
            # Unknown event type: ignored, never fatal (CONTRACT-V1 §3, §9) —
            # the first additive type must not break the fleet. Unlike
            # backlog.overflowed this is presumed durable, so it is acked to
            # keep the stream moving rather than redelivered forever.
            self._logger.debug("ignoring unknown event type %r", event.type)
            self._mark_seen(event.id)
            await self._ack(ws, event.id, generation)
            return

        task = asyncio.create_task(self._run_handler(ws, event, generation))
        self._in_flight[event.id] = task

    async def _run_handler(
        self, ws: aiohttp.ClientWebSocketResponse, event: Event, generation: int
    ) -> None:
        try:
            await self._dispatch(event)
        finally:
            self._in_flight.pop(event.id, None)
            self._mark_seen(event.id)
            # Across a reconnect the handler still finishes, but its ack is
            # dropped — redelivery on the new connection covers it (SDK-27).
            if generation == self._generation:
                await self._ack(ws, event.id, generation)

    async def _ack(
        self, ws: aiohttp.ClientWebSocketResponse, event_id: str, generation: int
    ) -> None:
        if generation != self._generation or ws.closed:
            return
        try:
            await ws.send_str(json.dumps({"op": "ack", "d": {"event_id": event_id}}))
        except Exception:
            pass  # the connection died under us; redelivery covers it

    def _mark_seen(self, event_id: str) -> None:
        self._seen[event_id] = None
        if len(self._seen) > self._seen_limit:
            self._seen.pop(next(iter(self._seen)))

    def _mark_dropped(self) -> None:
        # Only a connection that had actually said `hello` counts as a drop —
        # a failed first dial has nothing to reconnect FROM.
        if self._ever_hello:
            self._drop_time = time.monotonic()

    def _on_hello(self, session_id: object) -> None:
        session_id_str = session_id if isinstance(session_id, str) else ""
        now = time.monotonic()
        if not self._ever_hello:
            self._ever_hello = True
            self.first_connected_at = now
            if self._reporter is not None:
                self._reporter.connected(
                    bot=self._bot_name,
                    session_id=session_id_str,
                    command_count=self._command_count,
                )
        else:
            duration = now - self._drop_time if self._drop_time is not None else 0.0
            if self._reporter is not None:
                self._reporter.reconnected(duration_s=duration)

    async def _sleep_backoff(self, stop: asyncio.Event, *, reason: str = "network error") -> bool:
        """Escalating backoff, 1s -> 60s cap, full jitter, unbounded."""
        delay = min(self._backoff_cap, self._backoff_base * (2**self._backoff_n))
        self._backoff_n += 1
        delay = self._jitter() * delay
        if self._reporter is not None:
            self._reporter.reconnecting(reason=reason, delay_s=delay)
        return await self._interruptible_sleep(delay, stop)

    async def _short_wait(self, stop: asyncio.Event, *, reason: str = "network error") -> bool:
        """ONE jittered wait, not escalating."""
        lo, hi = self._short_wait_range
        delay = lo + self._jitter() * (hi - lo)
        if self._reporter is not None:
            self._reporter.reconnecting(reason=reason, delay_s=delay)
        return await self._interruptible_sleep(delay, stop)

    async def _interruptible_sleep(self, delay: float, stop: asyncio.Event) -> bool:
        """Returns True if `stop` fired during the wait — a SIGINT must never
        sit behind this sleep."""
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
            return True
        except asyncio.TimeoutError:
            return False
