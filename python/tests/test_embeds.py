"""Discord-shaped `Embed`/`Button` builders (0.4.0): the chain produces shape
(a) key for key, every cap sentence is refused by name (client-side and for a
raw dict — never a bypass), `ctx.send`/`ctx.reply` serialise and omit empty
arrays, `Message` decodes `embeds`/`buttons`/`button_used` with `null` and
absent treated identically (AMENDMENT-05 §3), and `ButtonContext.ack()` hits
the interactions endpoint.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from aurival.caps import (
    CAP_BAD_BUTTON_STYLE,
    CAP_BUTTON_ID_TOO_LONG,
    CAP_DESCRIPTION_TOO_LONG,
    CAP_DUPLICATE_BUTTON_ID,
    CAP_IMAGE_URL_NOT_HTTPS,
    CAP_LABEL_TOO_LONG,
    CAP_LINK_STYLE_DEFERRED,
    CAP_TITLE_TOO_LONG,
    CAP_TOO_MANY_BUTTONS,
    CAP_TOO_MANY_EMBEDS,
    CAP_TOO_MANY_FIELDS,
    EMPTY_MESSAGE,
    MAX_BUTTON_ID_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    MAX_EMBED_FIELDS,
    MAX_EMBEDS,
    MAX_LABEL_RUNES,
    MAX_TITLE_LENGTH,
)
from aurival.embeds import Button, ButtonUsed, Embed, serialise_buttons, serialise_embeds
from aurival.events import ButtonContext, Chat, Context, Event, User, _message_from_wire


def _event(event_type: str, data: dict[str, object], event_id: str = "evt_1") -> Event:
    return Event(
        id=event_id, type=event_type, created_at="2026-09-05T00:00:00Z", sequence=1, data=data
    )


def _command_event(*, message: str | None = "msg_1", chat: str = "chat_1") -> Event:
    data: dict[str, object] = {
        "command": "ping",
        "arguments": "",
        "chat": {"object": "chat", "id": chat, "type": "direct", "name": None},
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
        self.acked: list[str] = []

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        self.sent.append({"method": method, "path": path, **kwargs})
        return {"object": "message", "id": "msg_2"}

    async def send_message(
        self,
        chat: str,
        text: str,
        *,
        idempotency_key: str,
        mentions=None,
        embeds=None,
        buttons=None,
    ) -> dict:
        self.sent.append(
            {
                "method": "POST",
                "path": "/v1/messages",
                "body": {"chat": chat, "text": text},
                "embeds": embeds,
                "buttons": buttons,
            }
        )
        return {"object": "message", "id": "msg_new"}

    async def ack_interaction(self, interaction: str) -> dict:
        self.acked.append(interaction)
        return {}


# --- builders produce shape (a) key for key ---------------------------------


def test_embed_builder_chains() -> None:
    embed = (
        Embed(
            title="Trivia round 4",
            description="Which ocean is the deepest?",
            color="#3E6E8E",
        )
        .set_author("Quizbot", "https://cdn.aurival.com/q.png")
        .set_thumbnail("https://cdn.aurival.com/t.png")
        .set_image("https://cdn.aurival.com/i.png")
        .add_field("Players", "6", inline=True)
        .set_footer("Answer within 30s")
        .set_timestamp(datetime(2026, 9, 17, 18, 4, 0, tzinfo=timezone.utc))
    )
    assert embed.to_dict() == {
        "title": "Trivia round 4",
        "description": "Which ocean is the deepest?",
        "color": "#3E6E8E",
        "author": {"name": "Quizbot", "icon": "https://cdn.aurival.com/q.png"},
        "thumbnail": {"url": "https://cdn.aurival.com/t.png"},
        "image": {"url": "https://cdn.aurival.com/i.png"},
        "fields": [{"name": "Players", "value": "6", "inline": True}],
        "footer": {"text": "Answer within 30s"},
        "timestamp": "2026-09-17T18:04:00Z",
    }


def test_button_defaults_id_from_label_slug() -> None:
    assert Button("Pacific").to_dict() == {"id": "pacific", "label": "Pacific", "style": "primary"}


def test_button_explicit_id_and_style() -> None:
    assert Button("Pacific Ocean!", id="pac", style="secondary").to_dict() == {
        "id": "pac",
        "label": "Pacific Ocean!",
        "style": "secondary",
    }


# --- caps are refused by name, client-side, one case per sentence ----------


def test_caps_are_refused_by_name() -> None:
    with pytest.raises(ValueError, match=CAP_TITLE_TOO_LONG):
        Embed(title="x" * (MAX_TITLE_LENGTH + 1))
    with pytest.raises(ValueError, match=CAP_TITLE_TOO_LONG):
        Embed().title = "x" * (MAX_TITLE_LENGTH + 1)
    with pytest.raises(ValueError, match=CAP_DESCRIPTION_TOO_LONG):
        Embed(description="x" * (MAX_DESCRIPTION_LENGTH + 1))
    with pytest.raises(ValueError, match=CAP_IMAGE_URL_NOT_HTTPS):
        Embed().set_image("http://insecure.example/i.png")
    with pytest.raises(ValueError, match=CAP_IMAGE_URL_NOT_HTTPS):
        Embed().set_thumbnail("http://insecure.example/t.png")
    with pytest.raises(ValueError, match=CAP_IMAGE_URL_NOT_HTTPS):
        Embed().set_author("Quizbot", "http://insecure.example/q.png")
    with pytest.raises(ValueError, match=CAP_TOO_MANY_FIELDS):
        embed = Embed()
        for i in range(MAX_EMBED_FIELDS):
            embed.add_field(str(i), str(i))
        embed.add_field("overflow", "x")
    with pytest.raises(ValueError, match=CAP_LABEL_TOO_LONG):
        Button("x" * (MAX_LABEL_RUNES + 1))
    with pytest.raises(ValueError, match=CAP_BUTTON_ID_TOO_LONG):
        Button("ok", id="x" * (MAX_BUTTON_ID_LENGTH + 1))
    with pytest.raises(ValueError, match=CAP_BAD_BUTTON_STYLE):
        Button("ok", style="rainbow")
    with pytest.raises(ValueError, match=CAP_TOO_MANY_EMBEDS):
        serialise_embeds([Embed() for _ in range(MAX_EMBEDS + 1)])
    with pytest.raises(ValueError, match=CAP_TOO_MANY_BUTTONS):
        serialise_buttons([Button(f"b{i}") for i in range(6)])
    with pytest.raises(ValueError, match=CAP_DUPLICATE_BUTTON_ID):
        serialise_buttons([Button("Pacific"), Button("Pacific Ocean", id="pacific")])


def test_link_style_is_refused() -> None:
    with pytest.raises(ValueError, match=CAP_LINK_STYLE_DEFERRED):
        Button("Docs", style="link")


def test_the_fields_cap_is_per_message_summed_across_embeds() -> None:
    """AMENDMENT-05 §2: the 6-field cap is a message total, not per embed —
    two embeds of 4 and 3 fields (7 total) must be refused even though
    neither embed alone is over the per-embed limit."""
    first = Embed()
    for i in range(4):
        first.add_field(str(i), str(i))
    second = Embed()
    for i in range(3):
        second.add_field(str(i), str(i))
    with pytest.raises(ValueError, match=CAP_TOO_MANY_FIELDS):
        serialise_embeds([first, second])


def test_a_raw_dict_is_validated_like_a_builder() -> None:
    with pytest.raises(ValueError, match=CAP_TITLE_TOO_LONG):
        serialise_embeds([{"title": "x" * (MAX_TITLE_LENGTH + 1)}])
    with pytest.raises(ValueError, match=CAP_IMAGE_URL_NOT_HTTPS):
        serialise_embeds([{"image": {"url": "http://insecure.example/i.png"}}])
    with pytest.raises(ValueError, match=CAP_LABEL_TOO_LONG):
        serialise_buttons([{"label": "x" * (MAX_LABEL_RUNES + 1)}])
    with pytest.raises(ValueError, match=CAP_BAD_BUTTON_STYLE):
        serialise_buttons([{"label": "ok", "style": "rainbow"}])
    with pytest.raises(ValueError, match=CAP_DUPLICATE_BUTTON_ID):
        serialise_buttons([{"id": "a", "label": "A"}, {"id": "a", "label": "A2"}])


# --- send/reply serialise embeds/buttons, omit when empty ------------------


@pytest.mark.asyncio
async def test_send_serialises_embeds_and_buttons() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(), http=http)  # type: ignore[arg-type]
    embed = Embed(title="Trivia")
    button = Button("Pacific")

    await ctx.send("chat_2", "", embeds=[embed], buttons=[button])

    assert len(http.sent) == 1
    call = http.sent[0]
    assert call["body"]["text"] == ""
    assert call["embeds"] == [{"title": "Trivia"}]
    assert call["buttons"] == [{"id": "pacific", "label": "Pacific", "style": "primary"}]


@pytest.mark.asyncio
async def test_send_omits_embeds_and_buttons_when_absent() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(), http=http)  # type: ignore[arg-type]

    await ctx.send("chat_2", "hi")

    assert http.sent[0]["embeds"] == []
    assert http.sent[0]["buttons"] == []


@pytest.mark.asyncio
async def test_reply_carries_embeds() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(message="msg_abc"), http=http)  # type: ignore[arg-type]

    await ctx.reply("", embeds=[Embed(title="Card")])

    assert len(http.sent) == 1
    body = http.sent[0]["body"]
    assert body["reply_to"] == "msg_abc"
    assert body["text"] == ""
    assert body["embeds"] == [{"title": "Card"}]
    assert "buttons" not in body


@pytest.mark.asyncio
async def test_reply_omits_embeds_when_not_given() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(message="msg_abc"), http=http)  # type: ignore[arg-type]

    await ctx.reply("pong")

    assert "embeds" not in http.sent[0]["body"]
    assert "buttons" not in http.sent[0]["body"]


# --- Message decode: unknown-key round trip, embeds/buttons/button_used ----


def test_a_future_embed_key_survives_a_round_trip() -> None:
    data = {
        "title": "Trivia",
        "future_field": {"nested": True},
    }
    assert Embed.from_dict(data).to_dict() == {"title": "Trivia", "future_field": {"nested": True}}


def test_message_decodes_embeds_buttons_and_button_used() -> None:
    wire = {
        "id": "msg_1",
        "text": "",
        "created_at": "2026-09-17T18:04:00Z",
        "embeds": [{"title": "Trivia round 4"}],
        "buttons": [{"id": "pacific", "label": "Pacific", "style": "primary"}],
        "button_used": {"button": "pacific", "user": "usr_g", "at": "2026-09-17T18:04:22Z"},
    }
    msg = _message_from_wire(wire)
    assert len(msg.embeds) == 1 and msg.embeds[0].title == "Trivia round 4"
    assert len(msg.buttons) == 1 and msg.buttons[0].id == "pacific"
    assert msg.button_used == ButtonUsed(button="pacific", user="usr_g", at="2026-09-17T18:04:22Z")


def test_null_and_absent_embed_keys_decode_identically() -> None:
    """AMENDMENT-05 §3: `embeds`/`buttons`/`button_used` are always present on
    the wire and `null` when unused; a 0.3.x-era server omits the key
    entirely. Both must decode to the same `Message`."""
    base = {"id": "msg_1", "text": "hi", "created_at": "2026-09-17T18:04:00Z"}
    null_valued = {**base, "embeds": None, "buttons": None, "button_used": None}
    absent = dict(base)

    null_msg = _message_from_wire(null_valued)
    absent_msg = _message_from_wire(absent)

    assert null_msg == absent_msg == _message_from_wire(base)
    assert null_msg.embeds == []
    assert null_msg.buttons == []
    assert null_msg.button_used is None


# --- ButtonContext is typed, ack() hits the interactions endpoint ----------


def test_button_context_is_typed() -> None:
    http = _RecordingHttp()
    event = _event(
        "button.pressed",
        {
            "interaction": "evt_01J9",
            "chat": "chat_01J9",
            "message": "msg_01J9",
            "button": "pacific",
            "user": {
                "object": "user",
                "id": "usr_g",
                "handle": "wingriddenangel",
                "name": "Gustav",
            },
        },
    )
    from aurival.events import context_for

    ctx = context_for(event, http=http)  # type: ignore[arg-type]

    assert isinstance(ctx, ButtonContext)
    assert ctx.button == "pacific"
    assert ctx.interaction == "evt_01J9"
    assert ctx.user == User(id="usr_g", handle="wingriddenangel", name="Gustav")
    assert ctx.message.id == "msg_01J9"
    assert isinstance(ctx.chat, Chat)
    assert ctx.chat.id == "chat_01J9"


@pytest.mark.asyncio
async def test_button_context_ack_hits_the_interactions_endpoint() -> None:
    http = _RecordingHttp()
    event = _event(
        "button.pressed",
        {
            "interaction": "evt_01J9",
            "chat": "chat_01J9",
            "message": "msg_01J9",
            "button": "pacific",
            "user": {
                "object": "user",
                "id": "usr_g",
                "handle": "wingriddenangel",
                "name": "Gustav",
            },
        },
    )
    from aurival.events import context_for

    ctx = context_for(event, http=http)  # type: ignore[arg-type]
    assert isinstance(ctx, ButtonContext)

    result = await ctx.ack()

    assert result is None
    assert http.acked == ["evt_01J9"]


@pytest.mark.asyncio
async def test_an_embed_only_reply_needs_no_text() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(message="msg_abc"), http=http)  # type: ignore[arg-type]

    await ctx.reply(embeds=[Embed(title="Now playing")])

    body = http.sent[0]["body"]
    assert body["text"] == ""
    assert body["embeds"] == [{"title": "Now playing"}]


@pytest.mark.asyncio
async def test_an_embed_only_send_needs_no_text() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(), http=http)  # type: ignore[arg-type]

    await ctx.send("chat_2", embeds=[Embed(title="Reminder")])

    assert http.sent[0]["body"]["text"] == ""
    assert http.sent[0]["embeds"] == [{"title": "Reminder"}]


@pytest.mark.asyncio
async def test_a_send_with_nothing_in_it_is_refused() -> None:
    http = _RecordingHttp()
    ctx = Context.from_event(_command_event(message="msg_abc"), http=http)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match=EMPTY_MESSAGE):
        await ctx.reply()
    with pytest.raises(ValueError, match=EMPTY_MESSAGE):
        await ctx.send("chat_2")

    assert http.sent == []


def test_an_unknown_event_type_is_still_an_event_context() -> None:
    from aurival.events import EventContext, context_for

    ctx = context_for(_event("some.brand.new.type", {"chat": {"id": "chat_9"}}), http=None)  # type: ignore[arg-type]

    assert isinstance(ctx, EventContext)
