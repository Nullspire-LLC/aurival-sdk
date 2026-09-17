"""Discord-shaped `Embed`/`Button` builders (0.5.0): the chain produces shape
(a) key for key, every cap sentence is refused by name (client-side and for a
raw dict — never a bypass), `ctx.send`/`ctx.reply` serialise and omit empty
arrays, `Message` decodes `embeds`/`buttons`/`button_used` with `null` and
absent treated identically (AMENDMENT-05 §3), and `ButtonContext.ack()` hits
the interactions endpoint.

AMENDMENT-06 adds the link pill, the button emoji, the footer icon and the two
tappable urls on an embed. Every one of them is omitted from the wire when
absent, so a card built without them marshals byte for byte as it did in 0.4.0.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from aurival.caps import (
    CAP_AUTHOR_URL_WITHOUT_NAME,
    CAP_BAD_BUTTON_STYLE,
    CAP_BUTTON_ID_TOO_LONG,
    CAP_BUTTON_MISSING_LABEL,
    CAP_DESCRIPTION_TOO_LONG,
    CAP_DUPLICATE_BUTTON_ID,
    CAP_EMBED_FOOTER_TEXT_REQUIRED,
    CAP_EMBED_URL_WITHOUT_TITLE,
    CAP_IMAGE_URL_NOT_HTTPS,
    CAP_INVALID_BUTTON_EMOJI,
    CAP_LABEL_TOO_LONG,
    CAP_LINK_BUTTON_MISSING_URL,
    CAP_LINK_URL_NOT_HTTPS,
    CAP_LINK_URL_TOO_LONG,
    CAP_TITLE_TOO_LONG,
    CAP_TOO_MANY_BUTTONS,
    CAP_TOO_MANY_EMBEDS,
    CAP_TOO_MANY_FIELDS,
    CAP_URL_ON_NON_LINK_BUTTON,
    EMPTY_MESSAGE,
    MAX_BUTTON_EMOJI_RUNES,
    MAX_BUTTON_ID_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    MAX_EMBED_FIELDS,
    MAX_EMBEDS,
    MAX_LABEL_RUNES,
    MAX_LINK_URL_RUNES,
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


# --- AMENDMENT-06: link pills, emoji, footer icon, tappable urls ----------


def test_a_link_button_carries_its_url() -> None:
    assert Button.link("Full lineup", "https://aurival.com/lineup").to_dict() == {
        "id": "full-lineup",
        "label": "Full lineup",
        "style": "link",
        "url": "https://aurival.com/lineup",
    }
    notes = Button.link("Notes", "https://example.com/n", id="notes", emoji="\N{MEMO}")
    assert notes.to_dict() == {
        "id": "notes",
        "label": "Notes",
        "style": "link",
        "emoji": "\N{MEMO}",
        "url": "https://example.com/n",
    }


def test_a_link_button_without_a_url_is_refused() -> None:
    """`Button.link` is the sanctioned door (AMENDMENT-06 §11); reaching the
    constructor with `style="link"` and no url is refused there too, so the
    back way in cannot produce a pill that opens nothing."""
    with pytest.raises(ValueError, match=CAP_LINK_BUTTON_MISSING_URL):
        Button("Docs", style="link")
    with pytest.raises(ValueError, match=CAP_LINK_BUTTON_MISSING_URL):
        Button("Docs", style="link", url="")
    with pytest.raises(ValueError, match=CAP_LINK_BUTTON_MISSING_URL):
        serialise_buttons([{"label": "Docs", "style": "link"}])


def test_a_url_on_a_non_link_button_is_refused() -> None:
    with pytest.raises(ValueError, match=CAP_URL_ON_NON_LINK_BUTTON):
        Button("Remind me", url="https://aurival.com/x")
    with pytest.raises(ValueError, match=CAP_URL_ON_NON_LINK_BUTTON):
        serialise_buttons([{"label": "Remind me", "style": "primary", "url": "https://a.com"}])


def test_a_link_url_must_be_https_and_bounded() -> None:
    with pytest.raises(ValueError, match=CAP_LINK_URL_NOT_HTTPS):
        Button.link("Docs", "http://insecure.example/docs")
    with pytest.raises(ValueError, match=CAP_LINK_URL_TOO_LONG):
        Button.link("Docs", "https://a.example/" + "x" * MAX_LINK_URL_RUNES)


# One truth table, ported case for case from the server's own
# `TestValidEmoji` (`backend-go/internal/botapi/emoji_test.go`), so the two
# SDKs and the server are all graded against the same list. AMENDMENT-06 §3
# makes the server authoritative and permits an SDK to be looser, never
# stricter; this port lands on all 33 exactly, so there is nothing to excuse.
_EMOJI_TRUTH_TABLE = [
    # The four the amendment names as must-pass.
    ("a plain pictograph", "\N{GAME DIE}", True),
    ("a zwj family", "\N{MAN}\u200d\N{WOMAN}\u200d\N{GIRL}", True),
    ("a flag", "\U0001F1F8\U0001F1EA", True),
    ("a keycap", "1\ufe0f\u20e3", True),
    # The must-fail set.
    ("two pictographs", "\N{GAME DIE}\N{GAME DIE}", False),
    ("plain letters", "ab", False),
    ("a shortcode", ":dice:", False),
    ("the empty string", "", False),
    ("an ascii plus", "+", False),
    ("a bare digit", "1", False),
    ("half a flag", "\U0001F1F8", False),
    ("two flags", "\U0001F1F8\U0001F1EA\U0001F1F8\U0001F1EA", False),
    # Skin tone and variation selectors ride along with one base.
    ("a skin tone modifier", "\N{THUMBS UP SIGN}\U0001F3FD", True),
    ("the emoji variation selector", "\N{HEAVY BLACK HEART}\ufe0f", True),
    ("the text variation selector", "\N{HEAVY BLACK HEART}\ufe0e", True),
    ("a zwj family with a skin tone", "\N{MAN}\U0001F3FB\u200d\N{COOKING}", True),
    # A tag sequence flag: a pictographic base, tag characters, the cancel tag.
    (
        "a tag sequence flag",
        "\N{WAVING BLACK FLAG}\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F",
        True,
    ),
    # A keycap without its enclosing mark, and a mark with no base.
    ("a digit with a variation selector but no keycap", "1\ufe0f", False),
    ("a hash keycap", "#\u20e3", True),
    ("a star keycap", "*\ufe0f\u20e3", True),
    ("a keycap mark with no base", "\u20e3", False),
    # The ASCII symbol classes. `Sm` admits every one of these, which is
    # exactly why the pictographic test floors at 0x80.
    ("an ascii less-than", "<", False),
    ("an ascii equals", "=", False),
    ("an ascii pipe", "|", False),
    ("an ascii tilde", "~", False),
    ("an ascii dollar", "$", False),
    # Non-ascii symbols that ARE legal under the deliberately permissive rule.
    ("an arrow", "\N{RIGHTWARDS ARROW}", True),
    ("a copyright sign", "\N{COPYRIGHT SIGN}", True),
    # Joiner hygiene and the outer bound.
    ("a trailing joiner", "\N{MAN}\u200d", False),
    ("a leading joiner", "\u200d\N{MAN}", False),
    ("a pictograph glued to a regional indicator", "\N{GAME DIE}\U0001F1F8", False),
    ("an overlong paste", "\N{GAME DIE}\u200d" * MAX_BUTTON_EMOJI_RUNES, False),
    ("prose after a pictograph", "\N{GAME DIE} go", False),
]


@pytest.mark.parametrize(
    ("emoji", "accepted"),
    [(case[1], case[2]) for case in _EMOJI_TRUTH_TABLE],
    ids=[case[0] for case in _EMOJI_TRUTH_TABLE],
)
def test_the_emoji_rule_matches_the_server(emoji: str, accepted: bool) -> None:
    """§3 makes the server authoritative and grants the SDK a looser check,
    never a stricter one, because neither side has a grapheme segmenter and a
    refusal the server would not make costs a bot author a legal send."""
    if accepted:
        assert Button("Remind me", emoji=emoji).to_dict()["emoji"] == emoji
    else:
        with pytest.raises(ValueError, match=CAP_INVALID_BUTTON_EMOJI):
            Button("Remind me", emoji=emoji)


def test_the_emoji_rune_bound_is_checked_before_the_rune_rules() -> None:
    """A legal family sequence repeated past the bound is refused on length,
    so the bound itself is pinned rather than one string that happens to
    exceed it."""
    long = "\N{MAN}"
    while len(long) <= MAX_BUTTON_EMOJI_RUNES:
        long += "\u200d\N{WOMAN}"
    with pytest.raises(ValueError, match=CAP_INVALID_BUTTON_EMOJI):
        Button("Remind me", emoji=long)


def test_the_emoji_does_not_count_toward_the_label_cap() -> None:
    """§3: folding the emoji into the 24-character label count would make the
    cap mean two things."""
    assert Button("x" * MAX_LABEL_RUNES, emoji="\N{ALARM CLOCK}").label == "x" * MAX_LABEL_RUNES


def test_an_emoji_only_button_is_refused() -> None:
    """§3 keeps the label required: a pill with no words is unreadable to a
    screen reader. Without this the empty label silently slugged to "button"."""
    with pytest.raises(ValueError, match=re.escape(CAP_BUTTON_MISSING_LABEL)):
        Button("", emoji="\N{ALARM CLOCK}")
    with pytest.raises(ValueError, match=re.escape(CAP_BUTTON_MISSING_LABEL)):
        Button("")
    with pytest.raises(ValueError, match=re.escape(CAP_BUTTON_MISSING_LABEL)):
        serialise_buttons([{"id": "remind", "emoji": "\N{ALARM CLOCK}"}])


def test_a_footer_carries_an_icon() -> None:
    embed = Embed(title="Set").set_footer("set by deepcuts", "https://cdn.aurival.com/dc.png")
    assert embed.to_dict()["footer"] == {
        "text": "set by deepcuts",
        "icon": "https://cdn.aurival.com/dc.png",
    }


def test_a_footer_icon_is_an_image_url_and_needs_text() -> None:
    """§2: the icon is an image url, so it keeps the image sentence byte for
    byte and earns no length cap; an icon with no text would render a floating
    glyph on a line with nothing to say."""
    with pytest.raises(ValueError, match=CAP_IMAGE_URL_NOT_HTTPS):
        Embed().set_footer("set by deepcuts", "http://insecure.example/dc.png")
    with pytest.raises(ValueError, match=CAP_EMBED_FOOTER_TEXT_REQUIRED):
        Embed().set_footer("", "https://cdn.aurival.com/dc.png")
    with pytest.raises(ValueError, match=CAP_EMBED_FOOTER_TEXT_REQUIRED):
        serialise_embeds([{"footer": {"icon": "https://cdn.aurival.com/dc.png"}}])


def test_an_embed_url_makes_the_title_tappable() -> None:
    embed = Embed(title="Tonight's set", url="https://aurival.com/spaces/deepcuts")
    assert embed.to_dict() == {
        "title": "Tonight's set",
        "url": "https://aurival.com/spaces/deepcuts",
    }
    assert serialise_embeds([{"title": "T", "url": "https://aurival.com/s"}]) == [
        {"title": "T", "url": "https://aurival.com/s"}
    ]


def test_an_embed_url_needs_a_title_to_attach_to() -> None:
    with pytest.raises(ValueError, match=CAP_EMBED_URL_WITHOUT_TITLE):
        Embed(url="https://aurival.com/s")
    with pytest.raises(ValueError, match=CAP_EMBED_URL_WITHOUT_TITLE):
        serialise_embeds([{"url": "https://aurival.com/s"}])
    with pytest.raises(ValueError, match=CAP_EMBED_URL_WITHOUT_TITLE):
        embed = Embed(title="T", url="https://aurival.com/s")
        embed.title = None
    with pytest.raises(ValueError, match=CAP_LINK_URL_NOT_HTTPS):
        Embed(title="T", url="http://insecure.example/s")


def test_an_author_url_makes_the_author_line_tappable() -> None:
    embed = Embed(title="Set").set_author(
        "Deep Cuts", "https://cdn.aurival.com/dc.png", "https://aurival.com/u/deepcuts"
    )
    assert embed.to_dict()["author"] == {
        "name": "Deep Cuts",
        "icon": "https://cdn.aurival.com/dc.png",
        "url": "https://aurival.com/u/deepcuts",
    }


def test_an_author_url_needs_an_author_name() -> None:
    with pytest.raises(ValueError, match=CAP_AUTHOR_URL_WITHOUT_NAME):
        Embed().set_author("", url="https://aurival.com/u/deepcuts")
    with pytest.raises(ValueError, match=CAP_AUTHOR_URL_WITHOUT_NAME):
        serialise_embeds([{"author": {"url": "https://aurival.com/u/deepcuts"}}])
    with pytest.raises(ValueError, match=CAP_LINK_URL_NOT_HTTPS):
        Embed().set_author("Deep Cuts", url="http://insecure.example/u")


def test_a_card_without_the_new_fields_serialises_exactly_as_before() -> None:
    """AMENDMENT-06 §9: every new field is omitted when absent, so a 0.4.0-era
    card marshals byte for byte as it did — no `"url": null`, no `"emoji":
    null`, no key it did not have."""
    embed = (
        Embed(title="Trivia round 4", description="Which ocean is the deepest?", color="#3E6E8E")
        .set_author("Quizbot", "https://cdn.aurival.com/q.png")
        .set_thumbnail("https://cdn.aurival.com/t.png")
        .add_field("Players", "6", inline=True)
        .set_footer("Answer within 30s")
    )
    assert embed.to_dict() == {
        "title": "Trivia round 4",
        "description": "Which ocean is the deepest?",
        "color": "#3E6E8E",
        "author": {"name": "Quizbot", "icon": "https://cdn.aurival.com/q.png"},
        "thumbnail": {"url": "https://cdn.aurival.com/t.png"},
        "fields": [{"name": "Players", "value": "6", "inline": True}],
        "footer": {"text": "Answer within 30s"},
    }
    assert serialise_buttons([Button("Pacific")]) == [
        {"id": "pacific", "label": "Pacific", "style": "primary"}
    ]


# --- the sentences are this document's, character for character -----------

_AMENDMENT_06 = Path(__file__).resolve().parents[3] / "docs/engineering/bot-api/AMENDMENT-06.md"

_SENTENCE_CONSTANTS = {
    "link_url_not_https": CAP_LINK_URL_NOT_HTTPS,
    "link_url_too_long": CAP_LINK_URL_TOO_LONG,
    "link_button_missing_url": CAP_LINK_BUTTON_MISSING_URL,
    "url_on_non_link_button": CAP_URL_ON_NON_LINK_BUTTON,
    "invalid_button_emoji": CAP_INVALID_BUTTON_EMOJI,
    "embed_url_without_title": CAP_EMBED_URL_WITHOUT_TITLE,
    "author_url_without_name": CAP_AUTHOR_URL_WITHOUT_NAME,
    "embed_footer_text_required": CAP_EMBED_FOOTER_TEXT_REQUIRED,
}


def _amendment_06_section_5() -> str:
    """`sdk/` is copied wholesale to the public mirror, tests included, and
    `docs/engineering/` does not exist there. A missing amendment is a skip,
    not a failure — the mirror's CI must stay green."""
    if not _AMENDMENT_06.exists():
        pytest.skip(f"AMENDMENT-06 is not in this checkout ({_AMENDMENT_06}); mirror copy")
    text = _AMENDMENT_06.read_text(encoding="utf-8")
    start = text.index("## 5.")
    return text[start : text.index("## 6.", start)]


def test_the_eight_new_sentences_match_the_amendment() -> None:
    section = _amendment_06_section_5()
    rows = dict(re.findall(r"^\| `([a-z_]+)` \| `(.+?)` \|$", section, re.MULTILINE))
    assert set(rows) == set(_SENTENCE_CONSTANTS), rows
    for code, sentence in rows.items():
        # The one sentence that names a number renders it from the constant:
        # the server's template test refuses a digit literal in a template.
        expected = sentence.replace("{max}", str(MAX_LINK_URL_RUNES))
        assert _SENTENCE_CONSTANTS[code] == expected, code


def test_the_button_style_sentence_changed() -> None:
    """§5: `link` joins the styles, so the style sentence changes everywhere at
    once."""
    assert CAP_BAD_BUTTON_STYLE in _amendment_06_section_5()


def test_the_link_deferral_sentence_is_gone() -> None:
    """`link_button_not_supported` is retired with the code that produced it
    (§5). Deliberately outside the amendment-file skip: the mirror ships `sdk/`
    without `docs/engineering/`, and this guard is worth keeping live there."""
    package = Path(__file__).resolve().parents[1] / "aurival"
    for source in package.glob("*.py"):
        assert "link buttons are not supported in v1" not in source.read_text(encoding="utf-8")


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
