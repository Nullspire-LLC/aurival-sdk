"""Generic (non-`command.invoked`) events: registration on `Bot`, the context
class each event family gets (BA-R68), and the three ack cases the socket now
has to pick between (R2). `command.invoked` dispatch itself is unchanged and stays
covered by `test_bot.py`; this file only adds the new surface.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from aurival import http
from aurival.bot import Bot
from aurival.errors import AurivalError
from aurival.events import (
    BotContext,
    Context,
    Event,
    EventContext,
    MemberContext,
    MemberPage,
    ReactionContext,
    User,
    context_for,
    mention,
)
from aurival.socket import Socket


def _event(event_type: str, data: dict, event_id: str = "evt_1") -> Event:
    return Event(
        id=event_id, type=event_type, created_at="2026-09-05T00:00:00Z", sequence=1, data=data
    )


class _StubHttp:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def list_members(self, chat: str, cursor: str | None = None) -> dict:
        self.calls.append(("list_members", chat, cursor))
        return {
            "object": "list",
            "data": [{"id": "usr_1", "handle": "a", "name": "A"}],
            "has_more": False,
            "next_cursor": None,
        }

    async def set_typing(self, chat: str, is_typing: bool) -> dict:
        self.calls.append(("set_typing", chat, is_typing))
        return {}

    async def edit_message(
        self,
        msg: str,
        text: str | None = None,
        *,
        embeds: object = http.OMITTED,
        buttons: object = http.OMITTED,
        for_user: object = http.OMITTED,
    ) -> dict:
        # AMENDMENT-07 §2 widened the real method; this stub mirrors it so the
        # delegation test keeps testing delegation rather than the arity. The
        # body the card parts actually produce is pinned in test_messages.py.
        self.calls.append(("edit_message", msg, text))
        return {"id": msg, "text": text}

    async def delete_message(self, msg: str) -> dict:
        self.calls.append(("delete_message", msg))
        return {}

    async def set_reaction(self, msg: str, emoji: str) -> dict:
        self.calls.append(("set_reaction", msg, emoji))
        return {}

    async def unset_reaction(self, msg: str, emoji: str) -> dict:
        self.calls.append(("unset_reaction", msg, emoji))
        return {}

    async def send_message(
        self,
        chat: str,
        text: str,
        *,
        idempotency_key: str,
        mentions=None,
        embeds=None,
        buttons=None,
        for_user: str | None = None,
    ) -> dict:
        self.calls.append(("send_message", chat, text, mentions, embeds, buttons))
        return {"id": "msg_new"}

    async def ack_interaction(
        self,
        interaction: str,
        text: str | None = None,
        *,
        embeds: object = http.OMITTED,
        buttons: object = http.OMITTED,
        for_user: object = http.OMITTED,
    ) -> dict:
        self.calls.append(("ack_interaction", interaction))
        return {}


# --- R1: registration, decorator and direct call ---------------------------


@pytest.mark.asyncio
async def test_bot_on_decorator_receives_a_populated_context() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]
    seen: list[MemberContext] = []

    @bot.on("member.joined")
    async def handler(ctx: MemberContext) -> None:
        seen.append(ctx)

    await bot._dispatch(
        _event(
            "member.joined",
            {
                "chat": {"object": "chat", "id": "chat_1", "type": "group", "name": "Crew",
                          "member_count": 4},
                "user": {"object": "user", "id": "usr_9", "handle": "newkid", "name": "New Kid"},
            },
        )
    )

    assert len(seen) == 1
    ctx = seen[0]
    assert isinstance(ctx, MemberContext)
    assert ctx.user == User(id="usr_9", handle="newkid", name="New Kid")
    assert ctx.chat is not None
    assert ctx.chat.member_count == 4


@pytest.mark.asyncio
async def test_bot_on_direct_call_registers_too() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]
    called = asyncio.Event()

    async def handler(ctx: MemberContext) -> None:
        called.set()

    bot.on("member.left", handler)
    await bot._dispatch(
        _event(
            "member.left",
            {
                "chat": {"id": "chat_1", "type": "group"},
                "user": {"id": "usr_1", "handle": "x", "name": "X"},
            },
        )
    )
    assert called.is_set()


@pytest.mark.parametrize("event_type", ["command.invoked", "backlog.overflowed"])
def test_on_refuses_the_two_structurally_unregisterable_types(event_type: str) -> None:
    """Only the two types a handler can NEVER run for are refused —
    `command.invoked` (routed through `@bot.command`) and
    `backlog.overflowed` (operational, never reaches a handler). A type that
    merely doesn't exist on the wire yet (`reaction.removed`) is NOT refused
    — see `test_on_accepts_reaction_removed_as_forward_compatible` below."""
    bot = Bot()
    with pytest.raises(AurivalError):
        bot.on(event_type, lambda ctx: None)  # type: ignore[arg-type,return-value]
    with pytest.raises(AurivalError):

        @bot.on(event_type)
        async def handler(ctx: Context) -> None:
            pass


def test_on_accepts_reaction_removed_as_forward_compatible() -> None:
    """Refusing a type that merely doesn't exist YET would be a
    forward-compatibility trap: the day the server starts sending
    `reaction.removed`, every bot that pre-registered a handler for it would
    need a new SDK release just to stop being refused. It registers cleanly,
    even though nothing on the wire triggers it today."""
    bot = Bot()

    @bot.on("reaction.removed")
    async def handler(ctx: EventContext) -> None:
        pass

    assert bot._has_event_handler("reaction.removed")


@pytest.mark.asyncio
async def test_multiple_handlers_on_one_type_run_in_registration_order() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]
    order: list[str] = []

    @bot.on("member.joined")
    async def first(ctx: MemberContext) -> None:
        order.append("first")

    @bot.on("member.joined")
    async def second(ctx: MemberContext) -> None:
        order.append("second")

    await bot._dispatch(
        _event(
            "member.joined",
            {
                "chat": {"id": "chat_1", "type": "group"},
                "user": {"id": "usr_1", "handle": "x", "name": "X"},
            },
        )
    )
    assert order == ["first", "second"]


# --- unknown event type: ignored, bot keeps running -------------------------


@pytest.mark.asyncio
async def test_an_unknown_event_type_is_ignored_not_fatal() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]
    await bot._dispatch(_event("some.future.type", {"whatever": True}))  # must not raise


def test_context_for_an_unknown_type_with_nothing_recognizable_never_raises() -> None:
    ctx = context_for(_event("some.future.type", {"a": 1}), http=_StubHttp())  # type: ignore[arg-type]
    # An unknown type gets `EventContext`, every field optional. `chat` stays
    # a plain `Chat`, never `Chat | None` (0.1.8's typed surface, e.g.
    # `ctx.chat.id`, must keep working) — an unrecognized type just gets an
    # empty one, id `""`.
    assert isinstance(ctx, EventContext)
    assert ctx.chat.id == ""
    assert ctx.sender is None
    assert ctx.user is None
    assert ctx.actor is None
    assert ctx.message is None
    assert ctx.emoji is None


def test_context_for_an_unknown_type_populates_whatever_it_recognizably_carries() -> None:
    """"Ignored, not fatal" means opportunistic, not empty: a future eighth
    event type still hands a developer whatever familiar-shaped fields it
    carries."""
    ctx = context_for(
        _event(
            "future.thing",
            {
                "chat": {"id": "chat_1", "type": "group", "name": None},
                "user": {"id": "usr_1", "handle": "a", "name": "A"},
                "actor": {"id": "usr_2", "handle": "b", "name": "B"},
                "emoji": "\U0001F44D",
                "message": "msg_1",
            },
        ),
        http=_StubHttp(),  # type: ignore[arg-type]
    )
    assert isinstance(ctx, EventContext)
    assert ctx.chat.id == "chat_1"
    assert ctx.user == User(id="usr_1", handle="a", name="A")
    assert ctx.actor == User(id="usr_2", handle="b", name="B")
    assert ctx.emoji == "\U0001F44D"
    assert ctx.message is not None
    assert ctx.message.id == "msg_1"


# --- one context class per event family (BA-R68) ---------------------------


def test_bot_added_builds_a_bot_context_with_the_actor() -> None:
    ctx = context_for(
        _event("bot.added", {
            "chat": {"id": "chat_1", "type": "group", "name": None},
            "actor": {"id": "usr_2", "handle": "owner", "name": "Owner"},
        }),
        http=_StubHttp(),  # type: ignore[arg-type]
    )
    assert isinstance(ctx, BotContext)
    assert ctx.actor == User(id="usr_2", handle="owner", name="Owner")
    # The class carries only what `bot.*` delivers: no `sender`, no `user`,
    # no `emoji`, so autocomplete never offers a field that is always empty.
    assert not hasattr(ctx, "sender")
    assert not hasattr(ctx, "user")
    assert not hasattr(ctx, "emoji")


def test_reaction_added_builds_a_reaction_context() -> None:
    ctx = context_for(
        _event("reaction.added", {
            "chat": {"id": "chat_1", "type": "group", "name": None},
            "message": "msg_77",
            "emoji": "\U0001F44D",
            "sender": {"id": "usr_3", "handle": "liker", "name": "Liker"},
        }),
        http=_StubHttp(),  # type: ignore[arg-type]
    )
    assert isinstance(ctx, ReactionContext)
    assert ctx.emoji == "\U0001F44D"
    assert ctx.message.id == "msg_77"
    assert ctx.sender == User(id="usr_3", handle="liker", name="Liker")


def test_a_known_family_pins_its_fields_even_when_the_frame_is_short() -> None:
    """A guaranteed field is typed as present, so a malformed frame yields an
    empty entity rather than `None` — the same rule `chat` has always had."""
    ctx = context_for(_event("member.joined", {"chat": {"id": "chat_1"}}), http=_StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx, MemberContext)
    assert ctx.user == User(id="", handle="", name="")
    ctx2 = context_for(_event("reaction.added", {}), http=_StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx2, ReactionContext)
    assert ctx2.message.id == ""
    assert ctx2.emoji == ""


def test_command_invoked_still_builds_the_command_context() -> None:
    ctx = context_for(
        _event("command.invoked", {
            "command": "ping",
            "arguments": "",
            "chat": {"id": "chat_1", "type": "direct", "name": None},
            "sender": {"id": "usr_1", "handle": "g", "name": "G"},
            "message": "msg_1",
        }),
        http=_StubHttp(),  # type: ignore[arg-type]
    )
    assert isinstance(ctx, Context)
    assert ctx.sender.handle == "g"
    assert ctx.message.id == "msg_1"


# --- R5: chat.member_count -----------------------------------------------


def test_chat_member_count_defaults_to_none_when_absent() -> None:
    ctx = Context.from_event(
        _event("command.invoked", {
            "command": "ping", "arguments": "",
            "chat": {"id": "chat_1", "type": "direct", "name": None},
            "sender": {"id": "usr_1", "handle": "a", "name": "A"},
            "message": "msg_1",
        }),
        http=_StubHttp(),
    )
    assert ctx.chat is not None
    assert ctx.chat.member_count is None


# --- R10: mention() helper --------------------------------------------------


def test_mention_helper_token_and_entry() -> None:
    user = User(id="usr_5", handle="wingriddenangel", name="Wing")
    m = mention(user)
    assert m.token == "@wingriddenangel"
    assert m.entry == {"user": "usr_5"}
    assert f"hey {m}!" == "hey @wingriddenangel!"


# --- R2: the three ack cases -------------------------------------------------


class _FakeWs:
    def __init__(self) -> None:
        self.closed = False
        self.sent: list[str] = []

    async def send_str(self, s: str) -> None:
        self.sent.append(s)


class _FakeAuth:
    async def token(self) -> str:
        return "tok"

    async def refresh(self) -> str:
        return "tok"


def _socket(dispatch, has_handler) -> Socket:
    return Socket(
        _StubHttp(),  # type: ignore[arg-type]
        _FakeAuth(),  # type: ignore[arg-type]
        dispatch=dispatch,
        on_problem=lambda e: None,
        has_handler=has_handler,
    )


@pytest.mark.asyncio
async def test_ack_case_a_type_with_a_registered_generic_handler_acks_after_the_handler() -> None:
    order: list[str] = []

    async def slow_dispatch(event: Event) -> None:
        order.append("handler-start")
        await asyncio.sleep(0.01)
        order.append("handler-done")

    ws = _FakeWs()
    socket = _socket(slow_dispatch, has_handler=lambda t: True)
    frame = {"object": "event", "id": "evt_a", "type": "member.joined", "sequence": 1,
             "created_at": "2026-09-05T00:00:00Z", "data": {}}
    await socket._handle_event(ws, frame, socket._generation)
    task = socket._in_flight["evt_a"]
    await asyncio.sleep(0)  # let the created task actually start running
    assert order == ["handler-start"]  # ack has not happened yet, handler still running
    await task
    order.append("acked" if ws.sent else "not-acked")
    assert order[-2:] == ["handler-done", "acked"]


@pytest.mark.asyncio
async def test_ack_case_b_no_registered_handler_keeps_ack_and_ignore_behaviour() -> None:
    dispatch_calls: list[Event] = []

    async def dispatch(event: Event) -> None:
        dispatch_calls.append(event)

    ws = _FakeWs()
    socket = _socket(dispatch, has_handler=lambda t: False)
    frame = {"object": "event", "id": "evt_b", "type": "some.future.type", "sequence": 1,
             "created_at": "2026-09-05T00:00:00Z", "data": {}}
    await socket._handle_event(ws, frame, socket._generation)
    assert dispatch_calls == []  # never reaches the dispatch closure
    assert "evt_b" in socket._seen
    assert len(ws.sent) == 1  # acked immediately, synchronously


@pytest.mark.asyncio
async def test_ack_case_c_backlog_overflowed_stays_unacked() -> None:
    async def dispatch(event: Event) -> None:
        raise AssertionError("backlog.overflowed must never reach dispatch")

    ws = _FakeWs()
    socket = _socket(dispatch, has_handler=lambda t: True)  # even if "registered", stays unacked
    frame = {"object": "event", "id": "evt_c", "type": "backlog.overflowed", "sequence": 1,
             "created_at": "2026-09-05T00:00:00Z",
             "data": {"dropped_count": 3, "resume_sequence": 9}}
    await socket._handle_event(ws, frame, socket._generation)
    assert "evt_c" in socket._seen
    assert ws.sent == []  # never acked


# --- R7: Context actions -----------------------------------------------------


def _member_joined_ctx() -> MemberContext:
    ctx = context_for(
        _event("member.joined", {
            "chat": {"id": "chat_1", "type": "group", "name": None},
            "user": {"id": "usr_9", "handle": "newkid", "name": "New Kid"},
        }),
        http=_StubHttp(),  # type: ignore[arg-type]
    )
    assert isinstance(ctx, MemberContext)
    return ctx


@pytest.mark.asyncio
async def test_ctx_typing_sends_true_on_enter_false_on_exit() -> None:
    ctx = _member_joined_ctx()
    http = ctx._http
    async with ctx.typing():
        assert http.calls == [("set_typing", "chat_1", True)]
    assert http.calls == [("set_typing", "chat_1", True), ("set_typing", "chat_1", False)]


@pytest.mark.asyncio
async def test_ctx_typing_sends_false_on_exit_even_on_exception() -> None:
    ctx = _member_joined_ctx()
    http = ctx._http
    with pytest.raises(RuntimeError):
        async with ctx.typing():
            raise RuntimeError("boom")
    assert http.calls == [("set_typing", "chat_1", True), ("set_typing", "chat_1", False)]


@pytest.mark.asyncio
async def test_ctx_edit_delete_react_unreact_delegate_to_http() -> None:
    ctx = _member_joined_ctx()
    await ctx.edit("msg_1", "new text")
    await ctx.delete("msg_1")
    await ctx.react("msg_1", "\U0001F44D")
    await ctx.unreact("msg_1", "\U0001F44D")
    assert ctx._http.calls == [
        ("edit_message", "msg_1", "new text"),
        ("delete_message", "msg_1"),
        ("set_reaction", "msg_1", "\U0001F44D"),
        ("unset_reaction", "msg_1", "\U0001F44D"),
    ]


@pytest.mark.asyncio
async def test_ctx_send_converts_mention_user_and_dict_entries() -> None:
    ctx = _member_joined_ctx()
    target = User(id="usr_5", handle="wing", name="Wing")
    await ctx.send(
        "chat_2", "hi @wing", mentions=[mention(target), target, {"user": "usr_7"}]
    )
    assert ctx._http.calls == [
        (
            "send_message",
            "chat_2",
            "hi @wing",
            [{"user": "usr_5"}, {"user": "usr_5"}, {"user": "usr_7"}],
            [],
            [],
        )
    ]


@pytest.mark.asyncio
async def test_ctx_members_returns_a_single_memberpage_never_auto_loads() -> None:
    ctx = _member_joined_ctx()
    page = await ctx.members()
    assert isinstance(page, MemberPage)
    assert page.users == [User(id="usr_1", handle="a", name="A")]
    assert page.has_more is False
    assert page.next_cursor is None
    assert ctx._http.calls == [("list_members", "chat_1", None)]


@pytest.mark.asyncio
async def test_ctx_members_reads_has_more_and_next_cursor_off_the_envelope() -> None:
    """CONTRACT-V1 §4: `has_more` is the signal, never inferred from a short
    page or from `next_cursor` alone."""
    ctx = _member_joined_ctx()

    async def list_members(chat: str, cursor: str | None = None) -> dict:
        return {
            "object": "list",
            "data": [{"id": "usr_2", "handle": "b", "name": "B"}],
            "has_more": True,
            "next_cursor": "cur_9",
        }

    ctx._http.list_members = list_members  # type: ignore[method-assign]
    page = await ctx.members()
    assert page.has_more is True
    assert page.next_cursor == "cur_9"


@pytest.mark.asyncio
async def test_ctx_members_forces_next_cursor_to_none_when_has_more_is_false() -> None:
    """§2.1: a spec-violating server that sends a cursor alongside
    `has_more: false` must never hand it to the caller — it points at a page
    that, per the envelope's own `has_more`, doesn't exist."""
    ctx = _member_joined_ctx()

    async def list_members(chat: str, cursor: str | None = None) -> dict:
        return {
            "object": "list",
            "data": [{"id": "usr_2", "handle": "b", "name": "B"}],
            "has_more": False,
            "next_cursor": "cur_should_be_dropped",
        }

    ctx._http.list_members = list_members  # type: ignore[method-assign]
    page = await ctx.members()
    assert page.has_more is False
    assert page.next_cursor is None


@pytest.mark.asyncio
async def test_ctx_members_with_explicit_chat_and_cursor() -> None:
    ctx = _member_joined_ctx()
    await ctx.members(chat="chat_9", cursor="cur_1")
    assert ctx._http.calls == [("list_members", "chat_9", "cur_1")]


# --- SDK-16, generic path: a raising handler reaches the error hook, the bot
# survives, and the event still gets acked exactly once (same semantics as
# the untouched command path — test_bot.py:209 — _run_handler never sees the
# exception, so it always reaches its single ack) ---------------------------


@pytest.mark.asyncio
async def test_a_raising_generic_handler_reaches_the_error_hook_and_survives() -> None:
    seen: list[tuple[BaseException, object]] = []
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.on("member.joined")
    async def boom(ctx: MemberContext) -> None:
        raise RuntimeError("handler blew up")

    @bot.on_error
    async def on_error(error: BaseException, ctx: object) -> None:
        seen.append((error, ctx))

    await bot._dispatch(
        _event("member.joined", {
            "chat": {"id": "chat_1", "type": "group", "name": None},
            "user": {"id": "usr_9", "handle": "newkid", "name": "New Kid"},
        })
    )  # must not raise

    assert len(seen) == 1
    assert isinstance(seen[0][0], RuntimeError)


@pytest.mark.asyncio
async def test_a_raising_generic_handler_still_acks_exactly_once_through_the_socket() -> None:
    bot = Bot()
    bot._http = _StubHttp()  # type: ignore[assignment]

    @bot.on("member.joined")
    async def boom(ctx: MemberContext) -> None:
        raise RuntimeError("handler blew up")

    ws = _FakeWs()
    socket = _socket(bot._dispatch, has_handler=bot._has_event_handler)
    frame = {"object": "event", "id": "evt_boom", "type": "member.joined", "sequence": 1,
             "created_at": "2026-09-05T00:00:00Z",
             "data": {"chat": {"id": "chat_1", "type": "group", "name": None},
                       "user": {"id": "usr_9", "handle": "newkid", "name": "New Kid"}}}
    await socket._handle_event(ws, frame, socket._generation)
    task = socket._in_flight["evt_boom"]
    await task  # the raising handler is caught inside _dispatch, task itself completes clean
    assert "evt_boom" in socket._seen
    assert len(ws.sent) == 1  # acked exactly once — no redelivery of a deterministic failure
