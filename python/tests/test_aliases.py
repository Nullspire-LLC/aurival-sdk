"""AMENDMENT-09 §2: command aliases.

`aliases=` on registration reaches the sync payload, an alias-typed token
still fires the canonical handler, `ctx.command` stays canonical while
`ctx.invoked_as` carries what was typed, the cooldown bucket is one bucket
across every spelling, and the cooldown notice names the typed token (§13.1)
while `caps.COOLDOWN_COMMAND_NOTICE` itself stays untouched. Modeled on
`test_bot.py` and `test_cooldown_notice.py`'s fixtures.
"""

from __future__ import annotations

from typing import Any

import pytest

from aurival.bot import Bot
from aurival.caps import CAP_TOO_MANY_ALIASES, COOLDOWN_COMMAND_NOTICE, MAX_ALIASES_PER_COMMAND
from aurival.cooldown import Cooldown
from aurival.errors import AurivalError
from aurival.events import Command, Context
from aurival.events import Event


def _command_event(
    command: str = "roll",
    invoked_as: str | None = "roll",
    event_id: str = "evt_1",
    user: str = "usr_1",
) -> Event:
    data: dict[str, Any] = {
        "command": command,
        "arguments": "",
        "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
        "sender": {"object": "user", "id": user, "handle": "gustav", "name": "Gustav"},
        "message": "msg_1",
    }
    if invoked_as is not None:
        data["invoked_as"] = invoked_as
    return Event(
        id=event_id,
        type="command.invoked",
        created_at="2026-09-18T00:00:00Z",
        sequence=1,
        data=data,
    )


class _StubHttp:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.sync_calls: list[list[dict[str, object]]] = []

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_reply"}

    async def set_typing(self, chat: str, is_typing: bool) -> dict:
        return {}

    async def sync_commands(self, bot: str, commands: list[dict[str, object]]) -> dict:
        self.sync_calls.append(commands)
        return {"object": "list", "data": []}


# --- registration reaches the sync payload ----------------------------------


async def test_aliases_on_registration_reach_the_sync_payload() -> None:
    http = _StubHttp()
    bot = Bot()

    @bot.command("roll", "Roll a die", aliases=["r", "dice"])
    async def roll(ctx: Any) -> None: ...

    await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert http.sync_calls == [
        [{"name": "roll", "description": "Roll a die", "aliases": ["r", "dice"]}]
    ]


async def test_aliases_key_is_omitted_from_the_payload_when_empty() -> None:
    """Absent and `[]` mean the same thing on the wire (§2.1) — the SDK omits
    the key entirely rather than sending an empty list, matching how
    `mentions`/`embeds`/`buttons` already omit their own empty collections."""
    http = _StubHttp()
    bot = Bot()

    @bot.command("help")
    async def help_(ctx: Any) -> None: ...

    await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert http.sync_calls == [[{"name": "help", "description": ""}]]
    assert "aliases" not in http.sync_calls[0][0]


async def test_aliases_passed_as_an_explicit_empty_sequence_still_omit_the_key() -> None:
    http = _StubHttp()
    bot = Bot()

    @bot.command("help", aliases=[])
    async def help_(ctx: Any) -> None: ...

    await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert "aliases" not in http.sync_calls[0][0]


# --- the handler fires when the event's invoked_as is an alias -------------


async def test_the_handler_fires_when_invoked_as_is_an_alias() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    called: list[str] = []

    @bot.command("roll", aliases=["r", "dice"])
    async def roll(ctx: Context) -> None:
        called.append(ctx.command)

    # The server resolves the alias before the event is delivered, so
    # `command` is already canonical — dispatch keys on `command`, not on
    # `invoked_as` (§2.4: "command stays canonical, always").
    await bot._dispatch(_command_event(command="roll", invoked_as="r"))

    assert called == ["roll"]


# --- ctx.command is canonical, ctx.invoked_as is the typed token -----------


async def test_ctx_command_is_canonical_and_ctx_invoked_as_is_the_typed_token() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[Context] = []

    @bot.command("roll", aliases=["r"])
    async def roll(ctx: Context) -> None:
        seen.append(ctx)

    await bot._dispatch(_command_event(command="roll", invoked_as="r"))

    assert seen[0].command == "roll"
    assert seen[0].invoked_as == "r"


async def test_a_canonical_call_has_command_equal_to_invoked_as() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[Context] = []

    @bot.command("roll", aliases=["r"])
    async def roll(ctx: Context) -> None:
        seen.append(ctx)

    await bot._dispatch(_command_event(command="roll", invoked_as="roll"))

    assert seen[0].command == seen[0].invoked_as == "roll"


async def test_invoked_as_falls_back_to_command_when_the_wire_omits_it() -> None:
    """A pre-deploy backend sends no `invoked_as` key at all (§2.1's absence
    rule predates this amendment's producer). `Context.from_event` must not
    raise or leave the field empty — it falls back to the canonical
    `command`."""
    ctx = Context.from_event(
        _command_event(command="roll", invoked_as=None), http=None  # type: ignore[arg-type]
    )
    assert ctx.command == "roll"
    assert ctx.invoked_as == "roll"


# --- one cooldown bucket across all spellings -------------------------------


async def test_one_cooldown_bucket_across_all_spellings() -> None:
    """Two different aliases inside the window: the second is refused, same
    as if the same spelling had been typed twice (§3: the bucket is keyed on
    the canonical command, not on the typed token)."""
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    called: list[str] = []

    @bot.command("roll", aliases=["r", "dice"], cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Context) -> None:
        called.append(ctx.invoked_as)

    await bot._dispatch(_command_event(command="roll", invoked_as="r", event_id="evt_1"))
    await bot._dispatch(_command_event(command="roll", invoked_as="dice", event_id="evt_2"))

    assert called == ["r"], "the second spelling must be refused, not treated as a fresh command"
    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert len(replies) == 1, "one notice for the one bucket, regardless of which alias tripped it"


# --- the cooldown notice names the typed token ------------------------------


async def test_the_cooldown_notice_names_the_typed_token() -> None:
    http = _StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]

    @bot.command("roll", aliases=["r"], cooldown=Cooldown(1, 5.0))
    async def roll(ctx: Context) -> None: ...

    await bot._dispatch(_command_event(command="roll", invoked_as="r", event_id="evt_1"))
    await bot._dispatch(_command_event(command="roll", invoked_as="r", event_id="evt_2"))

    replies = [c for c in http.sent if c["path"] == "/v1/messages"]
    assert replies[0]["body"]["text"] == "Slow down. Try /r again in 5 s."


def test_cooldown_command_notice_constant_is_unchanged() -> None:
    """§13.1: only the rendered sentence changes; the template constant
    itself stays byte-identical to AMENDMENT-08 §4's."""
    assert COOLDOWN_COMMAND_NOTICE == "Slow down. Try /{name} again in {n} s."


# --- both string overloads of command() still work unchanged ---------------


async def test_command_with_only_a_name_still_works() -> None:
    bot = Bot()

    @bot.command("ping")
    async def ping(ctx: Any) -> None: ...

    assert bot._registered["ping"].command == Command(name="ping", description="")


async def test_command_with_a_positional_description_still_works() -> None:
    bot = Bot()

    @bot.command("ping", "Replies pong")
    async def ping(ctx: Any) -> None: ...

    assert bot._registered["ping"].command == Command(name="ping", description="Replies pong")


# --- more than 3 aliases raises with CAP_TOO_MANY_ALIASES -------------------


def test_more_than_three_aliases_raises_with_the_cap_sentence() -> None:
    bot = Bot()
    assert MAX_ALIASES_PER_COMMAND == 3

    with pytest.raises(AurivalError, match=r"a command declares at most 3 aliases"):

        @bot.command("roll", aliases=["r", "dice", "d", "cube"])
        async def roll(ctx: Any) -> None: ...


def test_exactly_three_aliases_is_accepted() -> None:
    bot = Bot()

    @bot.command("roll", aliases=["r", "dice", "d"])
    async def roll(ctx: Any) -> None: ...

    assert bot._registered["roll"].command.aliases == ("r", "dice", "d")


def test_the_too_many_aliases_message_matches_the_caps_constant_exactly() -> None:
    bot = Bot()
    with pytest.raises(AurivalError) as exc_info:

        @bot.command("roll", aliases=["a", "b", "c", "d"])
        async def roll(ctx: Any) -> None: ...

    assert str(exc_info.value) == CAP_TOO_MANY_ALIASES
