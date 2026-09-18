"""`Cooldown` (AMENDMENT-08): the fixed-window rate primitive itself, its
attachment-time bounds, and the bucket-key scheme that ties a command or a
button press back to the right bucket. `test_cooldown_notice.py` covers the
notice/ack behavior that sits on top of this; this file is the primitive.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from aurival.bot import Bot
from aurival.caps import CAP_COOLDOWN_RETRY_AFTER_INVALID
from aurival.cooldown import (
    BUTTON_COOLDOWN_MAX_SECONDS,
    LINK_BUTTON_CANNOT_HAVE_COOLDOWN,
    PERIOD_GREATER_THAN_ZERO,
    RATE_AT_LEAST_ONE,
    UNSET,
    Cooldown,
    CooldownTable,
    resolve_subject,
    validate_button_cooldown,
)
from aurival.embeds import Button
from aurival.events import Context, Event


class _Clock:
    """An injectable fake clock — `Cooldown(clock=...)` — so a test drives
    time explicitly instead of sleeping."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# --- the algorithm itself -----------------------------------------------


def test_a_single_call_within_rate_passes() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, clock=clock)
    assert cd.check("k") is None


def test_a_call_past_rate_is_refused_with_the_remaining_seconds() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, clock=clock)
    assert cd.check("k") is None
    clock.advance(2.0)
    retry_after = cd.check("k")
    assert retry_after == pytest.approx(3.0)


def test_rate_greater_than_one_admits_that_many_before_refusing() -> None:
    clock = _Clock()
    cd = Cooldown(3, 10.0, clock=clock)
    assert cd.check("k") is None
    assert cd.check("k") is None
    assert cd.check("k") is None
    retry_after = cd.check("k")
    assert retry_after is not None and retry_after == pytest.approx(10.0)


def test_a_refusal_consumes_no_token_and_does_not_extend_the_window() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, clock=clock)
    assert cd.check("k") is None
    clock.advance(1.0)
    first_refusal = cd.check("k")
    clock.advance(1.0)
    second_refusal = cd.check("k")
    assert first_refusal is not None and second_refusal is not None
    # The window never moved: refusal #2's remaining time is exactly one
    # second less than refusal #1's, not reset back to `per`.
    assert first_refusal - second_refusal == pytest.approx(1.0)


def test_window_expiry_resets_the_bucket() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, clock=clock)
    assert cd.check("k") is None
    assert cd.check("k") is not None  # refused, same window
    clock.advance(5.0)  # window has fully elapsed
    assert cd.check("k") is None, "a call at/after the window boundary must pass"


def test_distinct_keys_never_share_a_bucket() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, clock=clock)
    assert cd.check("alice") is None
    assert cd.check("bob") is None, "a different key must not be refused by another key's state"


# --- bucket subjects: user / chat / global -------------------------------


def test_resolve_subject_user_bucket_keys_on_the_user() -> None:
    assert resolve_subject("user", user_id="usr_1", chat_id="chat_1") == "usr_1"
    assert resolve_subject("user", user_id="usr_2", chat_id="chat_1") == "usr_2"


def test_resolve_subject_chat_bucket_keys_on_the_chat() -> None:
    assert resolve_subject("chat", user_id="usr_1", chat_id="chat_1") == "chat_1"
    assert resolve_subject("chat", user_id="usr_2", chat_id="chat_1") == "chat_1"


def test_resolve_subject_global_bucket_is_one_shared_key() -> None:
    assert resolve_subject("global", user_id="usr_1", chat_id="chat_1") == ()
    assert resolve_subject("global", user_id="usr_2", chat_id="chat_2") == ()


def test_each_bucket_kind_is_independently_scoped_through_a_shared_cooldown() -> None:
    """One `Cooldown(1, 5.0, "user")` gives two different users independent
    buckets; one `"chat"` cooldown gives the same chat one shared bucket
    regardless of who calls; one `"global"` cooldown is shared by everyone."""
    clock = _Clock()
    per_user = Cooldown(1, 5.0, "user", clock=clock)
    k1 = resolve_subject(per_user.bucket, user_id="usr_1", chat_id="chat_1")
    k2 = resolve_subject(per_user.bucket, user_id="usr_2", chat_id="chat_1")
    assert per_user.check(k1) is None
    assert per_user.check(k2) is None, "a different user must not share usr_1's bucket"

    clock2 = _Clock()
    per_chat = Cooldown(1, 5.0, "chat", clock=clock2)
    c1 = resolve_subject(per_chat.bucket, user_id="usr_1", chat_id="chat_1")
    c2 = resolve_subject(per_chat.bucket, user_id="usr_2", chat_id="chat_1")
    assert per_chat.check(c1) is None
    assert per_chat.check(c2) is not None, "two users in the same chat share a chat bucket"

    clock3 = _Clock()
    glob = Cooldown(1, 5.0, "global", clock=clock3)
    g1 = resolve_subject(glob.bucket, user_id="usr_1", chat_id="chat_1")
    g2 = resolve_subject(glob.bucket, user_id="usr_2", chat_id="chat_2")
    assert glob.check(g1) is None
    assert glob.check(g2) is not None, "global is one bucket for everyone"


# --- Cooldown's own always-on bounds (rate >= 1, per > 0) ----------------


def test_rate_below_one_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match=RATE_AT_LEAST_ONE):
        Cooldown(0, 5.0)


def test_zero_or_negative_period_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match=PERIOD_GREATER_THAN_ZERO):
        Cooldown(1, 0.0)
    with pytest.raises(ValueError, match=PERIOD_GREATER_THAN_ZERO):
        Cooldown(1, -1.0)


# --- attachment-time bound: buttons capped at 60s, commands unbounded ----


def test_a_button_cooldown_over_sixty_seconds_is_refused_at_attachment() -> None:
    with pytest.raises(ValueError, match=BUTTON_COOLDOWN_MAX_SECONDS):
        validate_button_cooldown(Cooldown(1, 61.0))


def test_a_button_cooldown_at_exactly_sixty_seconds_is_accepted() -> None:
    validate_button_cooldown(Cooldown(1, 60.0))  # must not raise


def test_validate_button_cooldown_is_a_no_op_for_none() -> None:
    validate_button_cooldown(None)  # must not raise


def test_command_cooldowns_are_unbounded() -> None:
    """AMENDMENT-08 D13: a command cooldown never reaches the wire, so
    nothing caps it — an hour-long period is legitimate and only
    `Cooldown.__init__`'s own rate/per floor applies."""
    Cooldown(1, 3600.0)  # must not raise
    Cooldown(1, 86400.0 * 30)  # must not raise


def test_bot_command_accepts_an_unbounded_cooldown() -> None:
    bot = Bot()

    @bot.command("roll", cooldown=Cooldown(1, 999999.0))
    async def roll(ctx: Any) -> None: ...

    assert bot._registered["roll"].cooldown is not None
    assert bot._registered["roll"].cooldown.per == 999999.0


# --- attachment-time bound at each of the three button surfaces ----------


def test_bot_button_cooldown_over_cap_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match=BUTTON_COOLDOWN_MAX_SECONDS):
        Bot(button_cooldown=Cooldown(1, 61.0))


def test_button_cooldown_over_cap_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match=BUTTON_COOLDOWN_MAX_SECONDS):
        Button("Go", cooldown=Cooldown(1, 61.0))


def test_a_link_button_refuses_any_cooldown() -> None:
    with pytest.raises(ValueError, match=LINK_BUTTON_CANNOT_HAVE_COOLDOWN):
        Button("Open", style="link", url="https://example.com", cooldown=Cooldown(1, 5.0))


def test_button_link_classmethod_carries_no_cooldown_parameter() -> None:
    sig = inspect.signature(Button.link)
    assert "cooldown" not in sig.parameters


# --- bot-default button cooldown: present with zero configuration --------


def test_bot_has_a_default_button_cooldown_with_no_configuration() -> None:
    bot = Bot()
    default = bot._button_cooldown_default
    assert isinstance(default, Cooldown)
    assert default.rate == 1
    assert default.per == 2.0
    assert default.bucket == "user"


def test_bot_button_cooldown_none_disables_the_default() -> None:
    bot = Bot(button_cooldown=None)
    assert bot._button_cooldown_default is None


def test_bot_button_cooldown_accepts_a_custom_cooldown() -> None:
    custom = Cooldown(5, 30.0, "chat")
    bot = Bot(button_cooldown=custom)
    assert bot._button_cooldown_default is custom


# --- tri-state at Button(cooldown=): unset / None / Cooldown -------------


def test_button_cooldown_defaults_to_unset() -> None:
    btn = Button("Go")
    assert btn.cooldown is UNSET


def test_button_cooldown_none_is_stored_as_none() -> None:
    btn = Button("Go", cooldown=None)
    assert btn.cooldown is None


def test_button_cooldown_stores_the_cooldown_instance() -> None:
    cd = Cooldown(1, 5.0)
    btn = Button("Go", cooldown=cd)
    assert btn.cooldown is cd


# --- send(button_cooldown=)/reply(button_cooldown=): the third bound surface -


class _RecordingHttp:
    """Just enough of `HttpClient` for `ctx.send`/`ctx.reply`: `request` and
    `send_message` record what was actually posted, and a real
    `CooldownTable` since a successful send/reply writes into it."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.cooldowns = CooldownTable()

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_new"}

    async def send_message(self, chat: str, text: str, **kwargs: Any) -> dict:
        self.sent.append({"method": "POST", "path": "/v1/messages", "chat": chat, **kwargs})
        return {"object": "message", "id": "msg_new"}


def _command_ctx(http: _RecordingHttp) -> Context:
    event = Event(
        id="evt_1",
        type="command.invoked",
        created_at="2026-09-05T00:00:00Z",
        sequence=1,
        data={
            "command": "roll",
            "arguments": "",
            "chat": {"object": "chat", "id": "chat_1", "type": "direct", "name": None},
            "sender": {"object": "user", "id": "usr_1", "handle": "gustav", "name": "Gustav"},
            "message": "msg_1",
        },
    )
    return Context.from_event(event, http=http)  # type: ignore[arg-type]


async def test_send_button_cooldown_over_cap_is_refused_before_the_round_trip() -> None:
    http = _RecordingHttp()
    ctx = _command_ctx(http)
    with pytest.raises(ValueError, match=BUTTON_COOLDOWN_MAX_SECONDS):
        await ctx.send(
            "chat_2", "hi", buttons=[Button("Go")], button_cooldown=Cooldown(1, 61.0)
        )
    assert http.sent == [], "a refused attachment must never reach the wire"


async def test_reply_button_cooldown_over_cap_is_refused_before_the_round_trip() -> None:
    http = _RecordingHttp()
    ctx = _command_ctx(http)
    with pytest.raises(ValueError, match=BUTTON_COOLDOWN_MAX_SECONDS):
        await ctx.reply("hi", buttons=[Button("Go")], button_cooldown=Cooldown(1, 61.0))
    assert http.sent == []


async def test_send_records_the_card_and_flows_through_to_a_button_press() -> None:
    """Closes the loop end to end: `send()` writes the table, a later
    `button.pressed` for the returned message id resolves back to the exact
    per-button `Cooldown` that was attached — not a copy, the same object."""
    from aurival.bot import Bot as _Bot

    http = _RecordingHttp()
    ctx = _command_ctx(http)
    button_cd = Cooldown(1, 5.0, "user")

    message = await ctx.send("chat_2", "hi", buttons=[Button("Go", id="go", cooldown=button_cd)])
    assert message.id == "msg_new"

    bot = _Bot()
    bot._http = http  # type: ignore[assignment]
    press_ctx = _FakeButtonCtx("msg_new", "go")
    cooldown, key = bot._resolve_button_cooldown(press_ctx)  # type: ignore[arg-type]
    assert cooldown is button_cd
    assert cooldown.check(key) is None


# --- precedence: button > card > bot default, resolved from CooldownTable -


class _FakeButtonCtx:
    """Just enough surface for `Bot._resolve_button_cooldown`: `.message.id`,
    `.button`, `.user.id`, `.chat.id`."""

    def __init__(
        self, message_id: str, button: str, user_id: str = "usr_1", chat_id: str = "chat_1"
    ):
        self.message = type("M", (), {"id": message_id})()
        self.button = button
        self.user = type("U", (), {"id": user_id})()
        self.chat = type("C", (), {"id": chat_id})()


class _FakeHttp:
    def __init__(self) -> None:
        self.cooldowns = CooldownTable()


def test_precedence_button_beats_card_beats_bot_default() -> None:
    button_cd = Cooldown(9, 9.0, "user")
    card_cd = Cooldown(8, 8.0, "user")
    bot_default = Cooldown(1, 2.0, "user")

    bot = Bot(button_cooldown=bot_default)
    bot._http = _FakeHttp()  # type: ignore[assignment]
    # Card carries card_cd, one button overrides with its own button_cd.
    bot._http.cooldowns.record("msg_1", card_cd, {"go": button_cd, "other": UNSET})

    ctx_override = _FakeButtonCtx("msg_1", "go")
    cd, _key = bot._resolve_button_cooldown(ctx_override)  # type: ignore[arg-type]
    assert cd is button_cd, "the button's own cooldown must win over the card's"

    ctx_inherits_card = _FakeButtonCtx("msg_1", "other")
    cd, _key = bot._resolve_button_cooldown(ctx_inherits_card)  # type: ignore[arg-type]
    assert cd is card_cd, "a button left unset must inherit the card's cooldown"

    ctx_no_record = _FakeButtonCtx("msg_unknown", "go")
    cd, _key = bot._resolve_button_cooldown(ctx_no_record)  # type: ignore[arg-type]
    assert cd is bot_default, "an unrecorded message id must fall through to the bot default"


def test_none_disables_at_the_button_level_even_under_a_card_cooldown() -> None:
    card_cd = Cooldown(8, 8.0, "user")
    bot = Bot()
    bot._http = _FakeHttp()  # type: ignore[assignment]
    bot._http.cooldowns.record("msg_1", card_cd, {"go": None})

    ctx = _FakeButtonCtx("msg_1", "go")
    cd, _key = bot._resolve_button_cooldown(ctx)  # type: ignore[arg-type]
    assert cd is None


def test_none_disables_at_the_card_level() -> None:
    bot = Bot()
    bot._http = _FakeHttp()  # type: ignore[assignment]
    bot._http.cooldowns.record("msg_1", None, {"go": UNSET})

    ctx = _FakeButtonCtx("msg_1", "go")
    cd, _key = bot._resolve_button_cooldown(ctx)  # type: ignore[arg-type]
    assert cd is None


def test_none_disables_at_the_bot_default_level() -> None:
    bot = Bot(button_cooldown=None)
    bot._http = _FakeHttp()  # type: ignore[assignment]
    # No record at all for this message id -> falls through to the (disabled) default.
    ctx = _FakeButtonCtx("msg_unrecorded", "go")
    cd, _key = bot._resolve_button_cooldown(ctx)  # type: ignore[arg-type]
    assert cd is None


# --- (message_id, button_id, user) keying: two cards sharing a button id ---
# do NOT share a bucket, even under cooldown instances with identical shape.


def test_two_cards_with_the_same_button_id_do_not_share_a_bucket() -> None:
    clock = _Clock()
    cd_card_1 = Cooldown(1, 5.0, "user", clock=clock)
    cd_card_2 = Cooldown(1, 5.0, "user", clock=clock)

    bot = Bot()
    bot._http = _FakeHttp()  # type: ignore[assignment]
    bot._http.cooldowns.record("msg_1", None, {"go": cd_card_1})
    bot._http.cooldowns.record("msg_2", None, {"go": cd_card_2})

    ctx1 = _FakeButtonCtx("msg_1", "go")
    ctx2 = _FakeButtonCtx("msg_2", "go")

    cd1, key1 = bot._resolve_button_cooldown(ctx1)  # type: ignore[arg-type]
    cd2, key2 = bot._resolve_button_cooldown(ctx2)  # type: ignore[arg-type]
    assert key1 != key2, "the attachment scope must include the message id"

    assert cd1 is not None and cd1.check(key1) is None
    assert cd2 is not None and cd2.check(key2) is None, (
        "msg_2's 'go' button must not have been consumed by msg_1's press"
    )


def test_the_same_button_id_on_the_same_message_shares_one_bucket_per_user() -> None:
    """The other half of the keying claim: pressing the SAME button on the
    SAME card twice does hit the same bucket."""
    clock = _Clock()
    cd = Cooldown(1, 5.0, "user", clock=clock)
    bot = Bot()
    bot._http = _FakeHttp()  # type: ignore[assignment]
    bot._http.cooldowns.record("msg_1", None, {"go": cd})

    ctx = _FakeButtonCtx("msg_1", "go", user_id="usr_1")
    cooldown, key = bot._resolve_button_cooldown(ctx)  # type: ignore[arg-type]
    assert cooldown is not None
    assert cooldown.check(key) is None
    assert cooldown.check(key) is not None, "a second press in the same window must be refused"


def test_two_different_users_pressing_the_same_button_get_independent_buckets() -> None:
    clock = _Clock()
    cd = Cooldown(1, 5.0, "user", clock=clock)
    bot = Bot()
    bot._http = _FakeHttp()  # type: ignore[assignment]
    bot._http.cooldowns.record("msg_1", None, {"go": cd})

    ctx_a = _FakeButtonCtx("msg_1", "go", user_id="usr_a")
    ctx_b = _FakeButtonCtx("msg_1", "go", user_id="usr_b")
    cd_a, key_a = bot._resolve_button_cooldown(ctx_a)  # type: ignore[arg-type]
    cd_b, key_b = bot._resolve_button_cooldown(ctx_b)  # type: ignore[arg-type]
    assert cd_a is not None and cd_a.check(key_a) is None
    assert cd_b is not None and cd_b.check(key_b) is None


# --- CooldownTable bounding -------------------------------------------------


def test_cooldown_table_evicts_the_oldest_entry_past_capacity() -> None:
    table = CooldownTable(capacity=2)
    table.record("msg_1", None, {})
    table.record("msg_2", None, {})
    table.record("msg_3", None, {})
    assert table.lookup("msg_1") is None, "the oldest record must have been evicted"
    assert table.lookup("msg_2") is not None
    assert table.lookup("msg_3") is not None


def test_cooldown_table_lookup_of_an_unrecorded_message_is_none() -> None:
    table = CooldownTable()
    assert table.lookup("never_recorded") is None


# --- CAP_COOLDOWN_RETRY_AFTER_INVALID is a rendered sentence, not a template -


def test_cap_cooldown_retry_after_invalid_is_byte_for_byte_exact() -> None:
    """The server's own `cooldown_retry_after_invalid` template carries
    `{min}`/`{max}` (Go's catalogue refuses a digit literal there), but both
    SDKs render the bound into the sentence itself — same convention as
    `CAP_LINK_URL_TOO_LONG` renders `2048` instead of keeping `{max}`."""
    assert CAP_COOLDOWN_RETRY_AFTER_INVALID == (
        "a cooldown retry_after_ms is a whole number of milliseconds between 1 and 60000"
    )
    assert "{min}" not in CAP_COOLDOWN_RETRY_AFTER_INVALID
    assert "{max}" not in CAP_COOLDOWN_RETRY_AFTER_INVALID


# --- signature assertions (pinning the public surface) ---------------------


def test_cooldown_signature_is_pinned() -> None:
    sig = inspect.signature(Cooldown.__init__)
    params = list(sig.parameters)
    assert params[:4] == ["self", "rate", "per", "bucket"]
    assert sig.parameters["bucket"].default == "user"


def test_bot_command_signature_carries_cooldown_and_on_cooldown() -> None:
    sig = inspect.signature(Bot.command)
    assert "cooldown" in sig.parameters
    assert "on_cooldown" in sig.parameters
    assert sig.parameters["cooldown"].default is None
    assert sig.parameters["on_cooldown"].default is None


def test_bot_on_cooldown_is_a_decorator_method() -> None:
    bot = Bot()
    assert hasattr(bot, "on_cooldown")

    @bot.on_cooldown
    async def hook(ctx: Any, retry_after: float) -> None: ...

    assert bot._cooldown_hook is hook


def test_bot_constructor_signature_carries_button_cooldown() -> None:
    sig = inspect.signature(Bot.__init__)
    assert "button_cooldown" in sig.parameters


def test_cooldown_hook_signature_is_ctx_retry_after() -> None:
    async def hook(ctx: Any, retry_after: float) -> None: ...

    sig = inspect.signature(hook)
    assert list(sig.parameters) == ["ctx", "retry_after"]
