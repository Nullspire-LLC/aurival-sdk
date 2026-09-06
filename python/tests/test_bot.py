"""What `bot.py` owns: shutdown grace, the rate-limited sync, dispatch and the
error hook. The socket and the key file have their own suites."""

from __future__ import annotations

import asyncio
import pathlib
import time
from typing import Any

import pytest

from aurival import bot as bot_module
from aurival.bot import Bot
from aurival.errors import RateLimited, SyncRateLimited
from aurival.events import Event


def _event(command: str = "ping", event_id: str = "evt_1") -> Event:
    return Event(
        id=event_id,
        type="command.invoked",
        created_at="2026-09-05T00:00:00Z",
        sequence=1,
        data={
            "command": command,
            "arguments": "",
            "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
            "sender": {"object": "user", "id": "usr_1", "handle": "gustav", "name": "Gustav"},
            "message": "msg_1",
        },
    )


class _StubHttp:
    """Enough of HttpClient for dispatch. Records what was sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.sync_calls: list[list[dict[str, str]]] = []
        self.sync_raises: list[BaseException] = []
        self.listed = 0

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_2"}

    async def sync_commands(self, bot: str, commands: list[dict[str, str]]) -> dict:
        self.sync_calls.append(commands)
        if self.sync_raises:
            raise self.sync_raises.pop(0)
        return {"object": "list", "data": []}

    async def list_commands(self, bot: str) -> dict:
        self.listed += 1
        return {"object": "list", "data": []}


# --- SDK-32: shutdown waits, bounded, for handlers still running -------------


async def test_shutdown_waits_for_an_inflight_handler() -> None:
    finished = asyncio.Event()
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.command("slow")
    async def slow(ctx: Any) -> None:
        await asyncio.sleep(0.3)
        finished.set()

    started = asyncio.Event()

    async def dispatch() -> None:
        started.set()
        await bot._dispatch(_event(command="slow"))

    task = asyncio.create_task(dispatch())
    await started.wait()
    await asyncio.sleep(0.05)  # let _dispatch register itself

    began = time.monotonic()
    await bot._drain_handlers()
    waited = time.monotonic() - began

    assert finished.is_set(), "shutdown did not wait for the handler to finish"
    assert waited >= 0.2, f"shutdown returned after {waited:.3f}s — it did not wait"
    await task


async def test_shutdown_gives_up_after_the_grace_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bounded, not unbounded — a handler that never returns must not hang exit."""
    monkeypatch.setattr(bot_module, "SHUTDOWN_GRACE_SECONDS", 0.2)
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    finished = False

    @bot.command("forever")
    async def forever(ctx: Any) -> None:
        nonlocal finished
        await asyncio.sleep(30)
        finished = True

    started = asyncio.Event()

    async def dispatch() -> None:
        started.set()
        await bot._dispatch(_event(command="forever"))

    task = asyncio.create_task(dispatch())
    await started.wait()
    await asyncio.sleep(0.05)

    began = time.monotonic()
    await bot._drain_handlers()
    waited = time.monotonic() - began

    # BOTH bounds. `< 1.0` alone would pass on a drain that returned instantly,
    # which is the half of SDK-32 this test exists for.
    assert waited >= 0.15, f"it did not wait the grace window at all ({waited:.3f}s)"
    assert waited < 1.0, f"it waited {waited:.3f}s for a handler that never returns"
    assert not finished, "the handler somehow completed — the test proves nothing"
    task.cancel()


# --- SDK-35: a rate-limited sync does NOT take the bot offline ---------------


async def test_sync_rate_limited_connects_anyway_and_retries_in_the_background(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    slept: list[float] = []

    async def fake_sleep(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr(bot_module.asyncio, "sleep", fake_sleep)

    http = _StubHttp()
    http.sync_raises = [
        SyncRateLimited(
            type="rate_limit_error",
            code="sync_rate_limited",
            message="slow down",
            doc_url="https://bots.aurival.com/docs/errors#sync_rate_limited",
            request_id="req_1",
            retry_after=7.0,
            status=429,
        )
    ]
    bot = Bot()

    @bot.command("ping")
    async def ping(ctx: Any) -> None: ...

    # It RETURNS rather than raising: the bot connects with the server's current
    # set. Raising here is the crash loop ERRORS-V1 §5 names.
    task = await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert task is not None, "a rate-limited sync must not take the bot offline"
    await task

    assert slept == [7.0], f"it did not honour Retry-After: {slept}"
    assert len(http.sync_calls) == 2, "the sync was never retried in the background"
    assert "command sync landed" in capsys.readouterr().out


async def test_a_clean_sync_starts_no_background_task() -> None:
    http = _StubHttp()
    bot = Bot()

    @bot.command("ping")
    async def ping(ctx: Any) -> None: ...

    assert await bot._sync_commands(http, "bot_1") is None  # type: ignore[arg-type]
    assert http.sync_calls == [[{"name": "ping", "description": ""}]]


async def test_a_generic_rate_limit_also_connects_anyway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`rate_limited` exhausting the http lane's own retries lands here too, and
    the answer is the same: connect, retry behind the socket. Offline is worse."""

    async def fake_sleep(delay: float) -> None: ...

    monkeypatch.setattr(bot_module.asyncio, "sleep", fake_sleep)
    http = _StubHttp()
    http.sync_raises = [
        RateLimited(
            type="rate_limit_error",
            code="rate_limited",
            message="slow down",
            doc_url="https://bots.aurival.com/docs/errors#rate_limited",
            request_id="req_1",
            retry_after=1.0,
            status=429,
        )
    ]
    bot = Bot()
    task = await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert task is not None
    await task


# --- SDK-16: a handler exception never takes the bot down --------------------


async def test_a_raising_handler_reaches_the_error_hook_and_the_bot_survives() -> None:
    seen: list[tuple[BaseException, object]] = []
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.command("boom")
    async def boom(ctx: Any) -> None:
        raise RuntimeError("handler blew up")

    @bot.on_error
    async def on_error(error: BaseException, ctx: object) -> None:
        seen.append((error, ctx))

    await bot._dispatch(_event(command="boom"))  # must not raise

    assert len(seen) == 1
    assert isinstance(seen[0][0], RuntimeError)
    assert seen[0][1] is not None, "the hook gets the context the handler had"


async def test_an_error_hook_that_raises_is_swallowed() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.command("boom")
    async def boom(ctx: Any) -> None:
        raise RuntimeError("handler blew up")

    @bot.on_error
    def on_error(error: BaseException, ctx: object) -> None:
        raise ValueError("the hook is broken too")

    await bot._dispatch(_event(command="boom"))  # still must not raise


async def test_a_sync_error_hook_is_accepted() -> None:
    seen: list[BaseException] = []
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.command("boom")
    async def boom(ctx: Any) -> None:
        raise RuntimeError("boom")

    @bot.on_error
    def on_error(error: BaseException, ctx: object) -> None:
        seen.append(error)

    await bot._dispatch(_event(command="boom"))
    assert len(seen) == 1


# --- SDK-29: no local validation, and the server's normalisation is mirrored --


async def test_a_capitalised_registration_answers_the_lowercased_wire_name() -> None:
    """The server lowercases and trims before it validates (commands.go), so
    `Ping` syncs as `ping` and the handler must still be found."""
    called = asyncio.Event()
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("  Ping  ")
    async def ping(ctx: Any) -> None:
        called.set()

    await bot._dispatch(_event(command="ping"))
    assert called.is_set()


async def test_the_name_is_sent_as_written_not_normalised() -> None:
    """Normalising locally would be validation by another door. The server is
    the validator and it answers with the message that names the fix."""
    http = _StubHttp()
    bot = Bot()

    @bot.command("Ping")
    async def ping(ctx: Any) -> None: ...

    await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert http.sync_calls == [[{"name": "Ping", "description": ""}]]


async def test_an_unregistered_command_is_ignored() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]
    await bot._dispatch(_event(command="nothing-registered"))  # must not raise


async def test_a_non_command_event_never_reaches_a_handler() -> None:
    """`backlog.overflowed` is operational and goes to the log and the hook,
    never to a handler (SDK-28)."""
    called = asyncio.Event()
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.command("ping")
    async def ping(ctx: Any) -> None:
        called.set()

    overflow = Event(
        id="evt_2",
        type="backlog.overflowed",
        created_at="2026-09-05T00:00:00Z",
        sequence=0,
        data={"dropped_count": 412, "resume_sequence": 9781},
    )
    await bot._dispatch(overflow)
    assert not called.is_set()


# --- SDK-33: the seed is not reachable from Bot ------------------------------


def test_bot_has_no_key_material_attribute() -> None:
    bot = Bot()
    for name in ("seed", "key", "_seed", "_key", "private_key", "token", "_token"):
        assert not hasattr(bot, name), f"Bot.{name} exists — the seed lives in MachineKey alone"


# --- the wiring: start() actually calls the drain -----------------------------


async def test_start_drains_handlers_before_returning(monkeypatch: pytest.MonkeyPatch) -> None:
    """The drain above is only worth anything if `start()` reaches it. Stubbed
    down to the wiring, so this fails if the call is dropped from the finally."""
    drained: list[bool] = []
    http = _StubHttp()

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *exc: object) -> None: ...

    class _KeyFile:
        def __init__(self, path: object = None) -> None: ...

        def load(self) -> tuple[object, object]:
            return (object(), type("M", (), {"bot": "bot_1"})())

        def save(self, *a: object) -> None: ...

    class _Socket:
        def __init__(self, *a: object, **kw: object) -> None: ...

        async def run(self, stop: asyncio.Event) -> None:
            return None

    monkeypatch.setattr(bot_module.aiohttp, "ClientSession", lambda *a, **k: _Session())
    monkeypatch.setattr(bot_module, "KeyFile", _KeyFile)
    monkeypatch.setattr(bot_module, "Auth", lambda *a, **k: object())
    monkeypatch.setattr(bot_module, "HttpClient", lambda *a, **k: http)
    monkeypatch.setattr(bot_module, "Socket", _Socket)
    monkeypatch.setattr(bot_module, "resolve_host", lambda: bot_module.DEFAULT_HOST)

    bot = Bot()

    async def record() -> None:
        drained.append(True)

    monkeypatch.setattr(bot, "_drain_handlers", record)
    await bot.start()

    assert drained == [True], "start() returned without draining in-flight handlers"


# --- the public surface the JS package mirrors (SDK-7) ------------------------


def test_every_error_class_is_exported_from_the_package() -> None:
    """A name missing from `aurival.__all__` becomes a permanent asymmetry with
    the JS package: adding an export later is free, removing one is a break."""
    import re

    import aurival
    from aurival import errors

    source = pathlib.Path(errors.__file__).read_text()
    declared = set(re.findall(r"^class ([A-Za-z0-9_]+)\(", source, re.M))
    assert declared, "the error module declares no classes — this test read the wrong file"

    missing = sorted(declared - set(aurival.__all__))
    assert not missing, f"error classes not exported from `aurival`: {missing}"

    unbound = sorted(n for n in aurival.__all__ if not hasattr(aurival, n))
    assert not unbound, f"named in __all__ but not importable: {unbound}"


# --- footgun A: a fatal bye that reads like a designed stop, not a crash ----


def test_run_exits_cleanly_on_session_superseded(monkeypatch: pytest.MonkeyPatch) -> None:
    """`socket.run()` already printed the friendly line before this exception
    ever reaches `run()` — this must be a quiet `sys.exit(1)`, no traceback."""
    from aurival.errors import SessionSuperseded

    bot = Bot()

    async def fake_start() -> None:
        raise SessionSuperseded(
            type="invalid_request_error",
            code="session_superseded",
            message="bye: session_superseded",
            doc_url="https://bots.aurival.com/docs/errors#session_superseded",
            request_id=None,
        )

    monkeypatch.setattr(bot, "start", fake_start)
    with pytest.raises(SystemExit) as exc_info:
        bot.run()
    assert exc_info.value.code == 1


def test_run_exits_cleanly_on_bot_suspended(monkeypatch: pytest.MonkeyPatch) -> None:
    from aurival.errors import BotSuspended

    bot = Bot()

    async def fake_start() -> None:
        raise BotSuspended(
            type="permission_error",
            code="bot_suspended",
            message="bye: bot_suspended",
            doc_url="https://bots.aurival.com/docs/errors#bot_suspended",
            request_id=None,
        )

    monkeypatch.setattr(bot, "start", fake_start)
    with pytest.raises(SystemExit) as exc_info:
        bot.run()
    assert exc_info.value.code == 1


def test_run_still_raises_other_fatal_byes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every other fatal bye (e.g. key_revoked) must keep raising exactly as
    today — only the two named footguns get the quiet exit."""
    from aurival.errors import KeyRevoked

    bot = Bot()

    async def fake_start() -> None:
        raise KeyRevoked(
            type="authentication_error",
            code="key_revoked",
            message="this key was revoked.",
            doc_url="https://bots.aurival.com/docs/errors#key_revoked",
            request_id=None,
        )

    monkeypatch.setattr(bot, "start", fake_start)
    with pytest.raises(KeyRevoked):
        bot.run()


# --- footgun B: silent duplicate-command overwrite and zero-command connect -


def test_duplicate_command_registration_warns_and_later_wins() -> None:
    import io

    from aurival.status import StatusReporter

    stream = io.StringIO()
    bot = Bot()
    bot._status = StatusReporter(stream=stream)

    @bot.command("ping")
    async def first(ctx: Any) -> None: ...

    @bot.command("ping")
    async def second(ctx: Any) -> None: ...

    out = stream.getvalue()
    assert 'aurival: command "ping" registered twice, the later definition wins' in out
    assert bot._registered["ping"].handler is second


def test_no_duplicate_warning_for_distinct_command_names() -> None:
    import io

    from aurival.status import StatusReporter

    stream = io.StringIO()
    bot = Bot()
    bot._status = StatusReporter(stream=stream)

    @bot.command("ping")
    async def first(ctx: Any) -> None: ...

    @bot.command("pong")
    async def second(ctx: Any) -> None: ...

    assert stream.getvalue() == ""


async def test_start_warns_when_zero_commands_are_registered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io

    from aurival.status import StatusReporter

    http = _StubHttp()

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *exc: object) -> None: ...

    class _KeyFile:
        def __init__(self, path: object = None) -> None: ...

        def load(self) -> tuple[object, object]:
            return (object(), type("M", (), {"bot": "bot_1"})())

        def save(self, *a: object) -> None: ...

    class _Socket:
        def __init__(self, *a: object, **kw: object) -> None: ...

        async def run(self, stop: asyncio.Event) -> None:
            return None

    monkeypatch.setattr(bot_module.aiohttp, "ClientSession", lambda *a, **k: _Session())
    monkeypatch.setattr(bot_module, "KeyFile", _KeyFile)
    monkeypatch.setattr(bot_module, "Auth", lambda *a, **k: object())
    monkeypatch.setattr(bot_module, "HttpClient", lambda *a, **k: http)
    monkeypatch.setattr(bot_module, "Socket", _Socket)
    monkeypatch.setattr(bot_module, "resolve_host", lambda: bot_module.DEFAULT_HOST)

    stream = io.StringIO()
    bot = Bot()
    bot._status = StatusReporter(stream=stream)

    await bot.start()

    assert (
        "aurival: no commands registered, this bot will connect and wait forever. "
        "Add @bot.command(...) before run()." in stream.getvalue()
    )


async def test_start_does_not_warn_when_commands_are_registered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import io

    from aurival.status import StatusReporter

    http = _StubHttp()

    class _Session:
        async def __aenter__(self) -> _Session:
            return self

        async def __aexit__(self, *exc: object) -> None: ...

    class _KeyFile:
        def __init__(self, path: object = None) -> None: ...

        def load(self) -> tuple[object, object]:
            return (object(), type("M", (), {"bot": "bot_1"})())

        def save(self, *a: object) -> None: ...

    class _Socket:
        def __init__(self, *a: object, **kw: object) -> None: ...

        async def run(self, stop: asyncio.Event) -> None:
            return None

    monkeypatch.setattr(bot_module.aiohttp, "ClientSession", lambda *a, **k: _Session())
    monkeypatch.setattr(bot_module, "KeyFile", _KeyFile)
    monkeypatch.setattr(bot_module, "Auth", lambda *a, **k: object())
    monkeypatch.setattr(bot_module, "HttpClient", lambda *a, **k: http)
    monkeypatch.setattr(bot_module, "Socket", _Socket)
    monkeypatch.setattr(bot_module, "resolve_host", lambda: bot_module.DEFAULT_HOST)

    stream = io.StringIO()
    bot = Bot()
    bot._status = StatusReporter(stream=stream)

    @bot.command("ping")
    async def ping(ctx: Any) -> None: ...

    await bot.start()

    assert "no commands registered" not in stream.getvalue()
