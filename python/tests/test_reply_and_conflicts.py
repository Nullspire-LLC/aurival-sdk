"""BA-R27's `reply_to`, S11's conflict warnings, and S7's key-file message.

Three behaviours that all share one property: the SDK is the only thing that can
tell the developer, and until now none of them did.
"""

from __future__ import annotations

import logging
import pathlib
from typing import Any

import pytest

from aurival import auth
from aurival import bot as bot_module
from aurival.bot import Bot
from aurival.errors import KeyRevoked, RateLimited
from aurival.events import Context, Event


def _event(*, message: str | None = "msg_1") -> Event:
    data: dict[str, object] = {
        "command": "ping",
        "arguments": "",
        "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
        "sender": {"object": "user", "id": "usr_1", "handle": "gustav", "name": "Gustav"},
    }
    if message is not None:
        data["message"] = message
    return Event(
        id="evt_1", type="command.invoked", created_at="2026-09-05T00:00:00Z", sequence=1, data=data
    )


class _RecordingHttp:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_2"}


# --- BA-R27: ctx.reply quotes the invoking message --------------------------


async def test_reply_quotes_the_invoking_message() -> None:
    """The owner ruling, reversing SDK-30. `reply_to` is the id the event
    carried, in the same wire form botview.go:245 sent it."""
    http = _RecordingHttp()
    ctx = Context.from_event(_event(message="msg_abc"), http=http)  # type: ignore[arg-type]

    await ctx.reply("pong")

    assert len(http.sent) == 1
    body = http.sent[0]["body"]
    assert body["reply_to"] == "msg_abc", (
        "ctx.reply() must quote the message that invoked the command (BA-R27). A reply that "
        "floats free in a busy chat is what reply-to exists to fix"
    )
    assert body["chat"] == "chat_1"
    assert body["text"] == "pong"


async def test_reply_omits_reply_to_entirely_when_the_event_carried_no_message() -> None:
    """THE KEY IS ABSENT, NOT null.

    `reply_to` is validated as a decodable `msg_…` and anything else answers
    `not_found` (server.go:943-953) — an explicit null included. So an event
    with no message id must produce a body with no `reply_to` key at all; a
    `None` here would turn every reply to such an event into a 404 about a
    message the developer never mentioned.
    """
    http = _RecordingHttp()
    ctx = Context.from_event(_event(message=None), http=http)  # type: ignore[arg-type]

    await ctx.reply("pong")

    body = http.sent[0]["body"]
    assert "reply_to" not in body, (
        f"reply_to is present as {body.get('reply_to')!r} with no message id to quote. The "
        "server 404s a reply_to it cannot decode, null included, so the key must be omitted"
    )


async def test_reply_still_carries_an_idempotency_key() -> None:
    # Guarding the thing the reply_to change sits next to: SDK-30's other half
    # survived the reversal of its first half.
    http = _RecordingHttp()
    ctx = Context.from_event(_event(), http=http)  # type: ignore[arg-type]
    await ctx.reply("pong")
    assert http.sent[0]["idempotency_key"]


# --- S11: conflicts are surfaced, one line per shadowed chat ----------------


class _SyncHttp:
    """Returns one sync response, then records nothing else."""

    def __init__(self, response: dict, raises: BaseException | None = None) -> None:
        self._response = response
        self._raises = raises
        self.calls = 0

    async def sync_commands(self, bot: str, commands: list[dict[str, str]]) -> dict:
        self.calls += 1
        if self._raises is not None:
            exc, self._raises = self._raises, None
            raise exc
        return self._response


async def test_a_conflict_is_reported_once_per_chat(caplog: pytest.LogCaptureFixture) -> None:
    """The developer whose command silently never fires is the named consumer
    of `conflicts` (CONTRACT-V1 §2). Both SDKs dropped it."""
    http = _SyncHttp(
        {
            "object": "list",
            "data": [
                {
                    "object": "command",
                    "name": "ping",
                    "description": "",
                    "conflicts": ["chat_aaa", "chat_bbb"],
                },
                {"object": "command", "name": "help", "description": "", "conflicts": []},
            ],
        }
    )
    bot = Bot()
    with caplog.at_level(logging.WARNING, logger="aurival"):
        await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    shadowed = [w for w in warnings if "shadowed" in w]
    assert len(shadowed) == 2, f"want one line per shadowed chat, got {warnings}"
    # THE CHAT HAS TO BE NAMED. "some command is shadowed somewhere" is not a
    # diagnosis — the whole value is knowing which chat to go look at.
    assert any("chat_aaa" in w for w in shadowed), shadowed
    assert any("chat_bbb" in w for w in shadowed), shadowed
    assert all("ping" in w for w in shadowed), shadowed


async def test_no_conflicts_is_silent(caplog: pytest.LogCaptureFixture) -> None:
    """`[]` is the normal answer for every healthy bot on every start. A warning
    here would be noise on every run and would train the developer to ignore the
    line that matters."""
    http = _SyncHttp(
        {
            "object": "list",
            "data": [{"object": "command", "name": "ping", "description": "", "conflicts": []}],
        }
    )
    bot = Bot()
    with caplog.at_level(logging.WARNING, logger="aurival"):
        await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
    assert not [r for r in caplog.records if "shadowed" in r.getMessage()]


async def test_conflicts_are_reported_from_the_background_retry_too(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bot that started rate limited is exactly the one whose sync landed out
    of sight (SDK-35). Dropping the report on this branch makes the conflict
    silent precisely when nobody was watching."""
    response = {
        "object": "list",
        "data": [
            {"object": "command", "name": "ping", "description": "", "conflicts": ["chat_zzz"]}
        ],
    }
    http = _SyncHttp(
        response,
        raises=RateLimited(
            type="rate_limit_error",
            code="sync_rate_limited",
            message="slow down",
            doc_url="",
            request_id=None,
            retry_after=0.01,
        ),
    )
    bot = Bot()
    with caplog.at_level(logging.WARNING, logger="aurival"):
        task = await bot._sync_commands(http, "bot_1")  # type: ignore[arg-type]
        assert task is not None, "a rate-limited sync must retry in the background"
        await task

    shadowed = [r.getMessage() for r in caplog.records if "shadowed" in r.getMessage()]
    assert len(shadowed) == 1, f"the background retry dropped the conflict report: {shadowed}"
    assert "chat_zzz" in shadowed[0]


async def test_a_malformed_sync_response_does_not_crash_the_start(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Reporting is a diagnostic, never a reason the bot fails to start.
    for payload in ({}, {"data": None}, {"data": ["not a dict"]}, {"data": [{"name": "x"}]}):
        bot = Bot()
        await bot._sync_commands(_SyncHttp(payload), "bot_1")  # type: ignore[arg-type]


# --- S7: the key_revoked message names the file to delete -------------------


async def test_key_revoked_at_startup_names_the_key_file(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DRIVEN THROUGH Bot.start(), not through a rebuilt exception.

    A test that constructs the message it then asserts on proves only that
    f-strings work. This one puts a real key file on disk, makes the socket
    raise `key_revoked` the way a revoked machine really does, and reads what
    reaches the developer.
    """
    key_path = tmp_path / "keys" / "machine.json"
    key_path.parent.mkdir(parents=True)
    key = auth.MachineKey.generate()
    auth.KeyFile(key_path).save(
        key,
        auth.Machine(bot="bot_1", machine="machine_1", host="http://127.0.0.1:1", created="now"),
    )

    revoked = KeyRevoked(
        type="authentication_error",
        code="key_revoked",
        message="This machine's key was revoked.",
        doc_url="https://bots.aurival.com/docs/errors#key_revoked",
        request_id="req_1",
    )

    class _DeadSocket:
        def __init__(self, *a: Any, **k: Any) -> None: ...

        async def run(self, stop: Any) -> None:
            raise revoked

    async def _no_sync(self: Any, http: Any, bot_id: str) -> None:
        return None

    monkeypatch.setattr(bot_module, "Socket", _DeadSocket)
    monkeypatch.setattr(Bot, "_sync_commands", _no_sync)
    monkeypatch.setattr(bot_module, "Auth", lambda *a, **k: _StubAuth())

    bot = Bot(host="http://127.0.0.1:1", key_path=key_path)
    with pytest.raises(KeyRevoked) as caught:
        await bot.start()

    text = str(caught.value)
    assert str(key_path) in text, (
        f"the key_revoked message does not name the key file to delete: {text!r}. The developer "
        "is looking at a process that will not start and the only fix is removing a file whose "
        "path they have never typed"
    )
    # Still the same class, so `except KeyRevoked` keeps working, and still
    # carrying the wire fields rather than a bare re-worded string.
    assert caught.value.code == "key_revoked"
    assert caught.value.doc_url.endswith("#key_revoked")
    assert caught.value.request_id == "req_1"


class _StubAuth:
    bot = "bot_1"

    async def token(self) -> str:
        return "tok"

    async def refresh(self) -> str:
        return "tok"
