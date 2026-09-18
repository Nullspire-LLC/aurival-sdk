"""AMENDMENT-08 §4/§5: the once-per-window command notice, the `on_cooldown`
hooks (per-command beats bot-level), and the button path's automatic
cooldown ack, including the silent swallow of `button_already_used`/
`not_found` (§11 D15). `test_cooldown.py` covers the `Cooldown` primitive
itself; this file covers what `bot.py` does with a refusal.
"""

from __future__ import annotations

import json
from typing import Any

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aurival import http as http_module
from aurival.bot import Bot
from aurival.caps import COOLDOWN_COMMAND_NOTICE
from aurival.cooldown import Cooldown, CooldownTable
from aurival.errors import ButtonAlreadyUsed, NotFound, RateLimited
from aurival.events import Event


def _command_event(command: str = "roll", event_id: str = "evt_1", user: str = "usr_1") -> Event:
    return Event(
        id=event_id,
        type="command.invoked",
        created_at="2026-09-05T00:00:00Z",
        sequence=1,
        data={
            "command": command,
            "arguments": "",
            "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
            "sender": {"object": "user", "id": user, "handle": "gustav", "name": "Gustav"},
            "message": "msg_1",
        },
    )


def _button_event(
    *,
    message_id: str = "msg_1",
    button: str = "go",
    user: str = "usr_1",
    interaction: str = "evt_btn_1",
    event_id: str = "evt_btn_1",
) -> Event:
    return Event(
        id=event_id,
        type="button.pressed",
        created_at="2026-09-05T00:00:00Z",
        sequence=1,
        data={
            "chat": "chat_1",
            "user": {"object": "user", "id": user, "handle": "gustav", "name": "Gustav"},
            "message": message_id,
            "button": button,
            "interaction": interaction,
        },
    )


class _StubHttp:
    """Enough of `HttpClient` for dispatch: `request` (what `ctx.reply` uses),
    `ack_interaction` (records calls, can be told to raise), and a real
    `CooldownTable` since the button path reads/writes it."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.acks: list[dict[str, Any]] = []
        self.cooldowns = CooldownTable()
        self._ack_raises: list[BaseException] = []

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_reply"}

    async def set_typing(self, chat: str, is_typing: bool) -> dict:
        self.sent.append({"method": "TYPING", "chat": chat, "is_typing": is_typing})
        return {}

    async def ack_interaction(
        self,
        interaction: str,
        text: str | None = None,
        *,
        embeds: object = None,
        buttons: object = None,
        cooldown_retry_after_ms: int | None = None,
    ) -> dict:
        self.acks.append(
            {
                "interaction": interaction,
                "text": text,
                "cooldown_retry_after_ms": cooldown_retry_after_ms,
            }
        )
        if self._ack_raises:
            raise self._ack_raises.pop(0)
        return {}


def _err(cls: type, code: str = "button_already_used") -> BaseException:
    return cls(
        type="invalid_request_error",
        code=code,
        message="nope",
        doc_url=f"https://bots.aurival.com/docs/errors#{code}",
        request_id="req_1",
    )


# --- command notice: fixed sentence, once per bucket per window ------------


async def test_a_refused_command_sends_the_fixed_notice_once() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    called = []

    @bot.command("roll", cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Any) -> None:
        called.append(1)

    await bot._dispatch(_command_event())  # consumes the token, handler runs
    await bot._dispatch(_command_event())  # refused

    assert called == [1], "a refused invocation must never reach the handler"
    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert len(replies) == 1
    assert replies[0]["body"]["text"] == "Slow down. Try /roll again in 5 s."


async def test_the_notice_sentence_is_byte_for_byte_exact() -> None:
    assert COOLDOWN_COMMAND_NOTICE == "Slow down. Try /{name} again in {n} s."


async def test_only_one_notice_per_bucket_per_window_even_across_many_refusals() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("roll", cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Any) -> None: ...

    for _ in range(5):
        await bot._dispatch(_command_event())

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert len(replies) == 1, "silence for the rest of the window, not one notice per refusal"


async def test_ceil_rounds_the_seconds_in_the_notice_up() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("roll", cooldown=Cooldown(1, 5.5))
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert replies[0]["body"]["text"] == "Slow down. Try /roll again in 6 s."


# --- hooks: per-command replaces, suppresses, and beats bot-level ----------


async def test_a_per_command_hook_replaces_the_fixed_notice() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[float] = []

    async def on_cooldown(ctx: Any, retry_after: float) -> None:
        seen.append(retry_after)

    @bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=on_cooldown)
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    assert len(seen) == 1
    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert replies == [], "the fixed notice must not also fire once a hook is registered"


async def test_a_no_op_hook_leaves_the_bot_silent() -> None:
    """A hook that does nothing means the bot sends nothing — the SDK must
    not fall back to the fixed sentence just because the hook was a no-op."""
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    async def on_cooldown(ctx: Any, retry_after: float) -> None:
        pass

    @bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=on_cooldown)
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert replies == []


async def test_per_command_hook_beats_bot_level_hook() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    per_command_seen: list[float] = []
    bot_level_seen: list[float] = []

    async def per_command(ctx: Any, retry_after: float) -> None:
        per_command_seen.append(retry_after)

    @bot.on_cooldown
    async def bot_level(ctx: Any, retry_after: float) -> None:
        bot_level_seen.append(retry_after)

    @bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=per_command)
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    assert per_command_seen == [pytest.approx(5.0, abs=0.05)]
    assert bot_level_seen == [], "only one hook may ever run"


async def test_bot_level_hook_runs_when_the_command_has_no_hook_of_its_own() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[float] = []

    @bot.on_cooldown
    async def bot_level(ctx: Any, retry_after: float) -> None:
        seen.append(retry_after)

    @bot.command("roll", cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    assert len(seen) == 1
    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert replies == []


async def test_command_returns_the_handler_unchanged_with_no_on_cooldown_attribute() -> None:
    """There is no `@roll.on_cooldown` decorator (AMENDMENT-08 §4, seat
    ruling): the kwarg and `@bot.on_cooldown` are the only two doors, and
    `command()` must not attach anything to the function it decorates."""
    bot = Bot()

    async def roll(ctx: Any) -> None: ...

    decorated = bot.command("roll", cooldown=Cooldown(1, 5.0))(roll)

    assert decorated is roll, "command() must return the handler object unchanged"
    assert not hasattr(decorated, "on_cooldown"), (
        "the handler must carry no .on_cooldown attribute — this is not a real door"
    )


async def test_a_raising_hook_reaches_on_error_and_the_bot_stays_up() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    hooked: list[BaseException] = []

    @bot.on_error
    async def on_error(exc: BaseException, ctx: Any) -> None:
        hooked.append(exc)

    async def on_cooldown(ctx: Any, retry_after: float) -> None:
        raise RuntimeError("hook blew up")

    @bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=on_cooldown)
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())  # must not raise

    assert len(hooked) == 1
    assert isinstance(hooked[0], RuntimeError)


async def test_a_sync_hook_is_accepted() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[float] = []

    def on_cooldown(ctx: Any, retry_after: float) -> None:
        seen.append(retry_after)

    @bot.command("roll", cooldown=Cooldown(1, 5.0), on_cooldown=on_cooldown)
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())
    await bot._dispatch(_command_event())

    assert len(seen) == 1


# --- distinct buckets get distinct notices ---------------------------------


async def test_distinct_users_each_get_their_own_notice() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("roll", cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event(user="usr_1"))
    await bot._dispatch(_command_event(user="usr_1"))  # refused, notice #1
    await bot._dispatch(_command_event(user="usr_2"))  # different bucket: passes
    await bot._dispatch(_command_event(user="usr_2"))  # refused, notice #2

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert len(replies) == 2


# --- button path: cooldown ack --------------------------------------------


async def test_a_refused_button_press_sends_a_cooldown_ack_and_never_reaches_the_handler() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user"))
    bot._http = http  # type: ignore[assignment]
    called = []

    @bot.on("button.pressed")
    async def on_press(ctx: Any) -> None:
        called.append(1)

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))

    assert called == [1], "the second, refused press must never reach the handler"
    assert len(http.acks) == 1
    assert http.acks[0]["interaction"] == "int_2"
    assert http.acks[0]["cooldown_retry_after_ms"] is not None
    assert http.acks[0]["cooldown_retry_after_ms"] >= 1
    assert http.acks[0]["text"] is None, "a cooldown ack carries no text/embeds/buttons"


async def test_cooldown_retry_after_ms_rounds_up_to_a_whole_millisecond() -> None:
    # Force a fractional retry_after by using a real clock via a tiny cooldown
    # and checking twice back-to-back — the remaining time is `per` minus a
    # sub-millisecond elapsed, so ceil must round it up to at least 1ms and
    # never down to 0.
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 0.05, "user"))
    bot._http = http  # type: ignore[assignment]

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))

    assert http.acks[0]["cooldown_retry_after_ms"] >= 1


async def test_button_already_used_is_swallowed_silently_on_the_cooldown_ack() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user"))
    bot._http = http  # type: ignore[assignment]
    hooked: list[BaseException] = []

    @bot.on_error
    async def on_error(exc: BaseException, ctx: Any) -> None:
        hooked.append(exc)

    http._ack_raises = [_err(ButtonAlreadyUsed, "button_already_used")]

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))  # must not raise

    assert hooked == [], "button_already_used on the SDK's own ack must never reach on_error"


async def test_not_found_is_swallowed_silently_on_the_cooldown_ack() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user"))
    bot._http = http  # type: ignore[assignment]
    hooked: list[BaseException] = []

    @bot.on_error
    async def on_error(exc: BaseException, ctx: Any) -> None:
        hooked.append(exc)

    http._ack_raises = [_err(NotFound, "not_found")]

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))  # must not raise

    assert hooked == [], "not_found on the SDK's own ack must never reach on_error"


async def test_every_other_status_on_the_cooldown_ack_goes_through_the_normal_error_path() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user"))
    bot._http = http  # type: ignore[assignment]
    hooked: list[BaseException] = []

    @bot.on_error
    async def on_error(exc: BaseException, ctx: Any) -> None:
        hooked.append(exc)

    http._ack_raises = [
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

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))  # must not raise

    assert len(hooked) == 1
    assert isinstance(hooked[0], RateLimited), (
        "anything other than the two named codes must reach on_error"
    )


async def test_a_pass_within_the_default_button_cooldown_reaches_the_handler_with_no_ack() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user"))
    bot._http = http  # type: ignore[assignment]
    called = []

    @bot.on("button.pressed")
    async def on_press(ctx: Any) -> None:
        called.append(1)

    await bot._dispatch(_button_event())

    assert called == [1]
    assert http.acks == [], "a passing press must not get an automatic cooldown ack"


async def test_a_disabled_default_button_cooldown_never_acks_or_refuses() -> None:
    http = _StubHttp()
    bot = Bot(button_cooldown=None)
    bot._http = http  # type: ignore[assignment]
    called = []

    @bot.on("button.pressed")
    async def on_press(ctx: Any) -> None:
        called.append(1)

    for i in range(3):
        await bot._dispatch(_button_event(event_id=f"evt_{i}", interaction=f"int_{i}"))

    assert called == [1, 1, 1]
    assert http.acks == []


# --- deterministic timing (injected clock, no real sleeping) --------------


class _Clock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


async def test_a_new_window_gets_a_fresh_notice() -> None:
    clock = _Clock()
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("roll", cooldown=Cooldown(1, 5.0, clock=clock))
    async def roll(ctx: Any) -> None: ...

    await bot._dispatch(_command_event())  # passes
    await bot._dispatch(_command_event())  # refused, notice #1
    clock.advance(5.0)  # window rolls over
    await bot._dispatch(_command_event())  # passes again
    await bot._dispatch(_command_event())  # refused, notice #2

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert len(replies) == 2, "a new window must earn a fresh notice, not stay silent forever"


async def test_button_ack_retry_after_ms_is_a_deterministic_ceil() -> None:
    clock = _Clock()
    http = _StubHttp()
    bot = Bot(button_cooldown=Cooldown(1, 5.0, "user", clock=clock))
    bot._http = http  # type: ignore[assignment]

    await bot._dispatch(_button_event(event_id="evt_1", interaction="int_1"))  # passes, t=0
    clock.advance(1.0005)  # remaining = 5.0 - 1.0005 = 3.9995s -> 3999.5ms -> ceil 4000
    await bot._dispatch(_button_event(event_id="evt_2", interaction="int_2"))  # refused

    assert http.acks[0]["cooldown_retry_after_ms"] == 4000


# --- the wire: the ack body is exactly {"cooldown": {"retry_after_ms": N}} -


class FakeAuth:
    async def token(self) -> str:
        return "tok-1"

    async def refresh(self) -> str:
        return "tok-1"


class _Capture:
    def __init__(self) -> None:
        self.raw: bytes | None = None
        self.calls = 0

    def handler(self):
        async def h(request: web.Request) -> web.Response:
            self.calls += 1
            self.raw = await request.read()
            return web.Response(status=204)

        return h

    @property
    def body(self) -> dict:
        assert self.raw is not None, "the server was never called"
        return json.loads(self.raw) if self.raw else {}


async def test_the_cooldown_ack_wire_body_is_exactly_retry_after_ms() -> None:
    cap = _Capture()
    app = web.Application()
    app.router.add_post("/v1/interactions/{interaction}/ack", cap.handler())
    server = TestServer(app)
    await server.start_server()
    session = aiohttp.ClientSession()
    try:
        host = str(server.make_url("")).rstrip("/")
        client = http_module.HttpClient(session, host, auth=FakeAuth())
        await client.ack_interaction("int_1", cooldown_retry_after_ms=1234)
    finally:
        await session.close()
        await server.close()

    assert cap.calls == 1
    assert cap.body == {"cooldown": {"retry_after_ms": 1234}}
    assert "text" not in cap.body
    assert "embeds" not in cap.body
    assert "buttons" not in cap.body


# --- signature assertions ---------------------------------------------------


def test_bot_on_cooldown_exists_as_a_bound_method() -> None:
    bot = Bot()
    assert callable(bot.on_cooldown)


def test_cooldown_command_notice_uses_name_and_n_placeholders() -> None:
    assert "{name}" in COOLDOWN_COMMAND_NOTICE
    assert "{n}" in COOLDOWN_COMMAND_NOTICE
