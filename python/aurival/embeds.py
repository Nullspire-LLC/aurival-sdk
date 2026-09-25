"""Discord-shaped `Embed` and `Button` builders (owner ruling: the call shape
must feel like discord.py — `Embed(...).add_field(...)`, `Button("Pacific")`).

Every cap is enforced client-side at construction/mutation time, refusing with
`ValueError(<cap sentence>)` — the same sentences the server sends back as
`invalid_request`, defined in `caps.py`. A raw `dict` passed where a builder is
expected is validated to the same sentences; it is never a bypass.
"""

from __future__ import annotations

import dataclasses
import re
import unicodedata
from datetime import datetime, timezone
from typing import Union

from .caps import (
    BUTTON_STYLES,
    CAP_AUTHOR_NAME_TOO_LONG,
    CAP_AUTHOR_URL_WITHOUT_NAME,
    CAP_BAD_BUTTON_STYLE,
    CAP_BUTTON_ID_TOO_LONG,
    CAP_BUTTON_MISSING_LABEL,
    CAP_DESCRIPTION_TOO_LONG,
    CAP_DUPLICATE_BUTTON_ID,
    CAP_EMBED_FOOTER_TEXT_REQUIRED,
    CAP_EMBED_URL_WITHOUT_TITLE,
    CAP_EMBEDS_TOO_LONG,
    CAP_FIELD_NAME_TOO_LONG,
    CAP_FIELD_VALUE_TOO_LONG,
    CAP_FOOTER_TEXT_TOO_LONG,
    CAP_IMAGE_URL_NOT_HTTPS,
    CAP_IMAGE_URL_TOO_LONG,
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
    MAX_AUTHOR_NAME_LENGTH,
    MAX_BUTTON_EMOJI_RUNES,
    MAX_BUTTON_ID_LENGTH,
    MAX_BUTTONS,
    MAX_DESCRIPTION_LENGTH,
    MAX_EMBED_FIELDS,
    MAX_EMBED_TOTAL_LENGTH,
    MAX_EMBEDS,
    MAX_FIELD_NAME_LENGTH,
    MAX_FIELD_VALUE_LENGTH,
    MAX_FOOTER_TEXT_LENGTH,
    MAX_IMAGE_URL_RUNES,
    MAX_LABEL_RUNES,
    MAX_LINK_URL_RUNES,
    MAX_TITLE_LENGTH,
)
from .cooldown import (
    LINK_BUTTON_CANNOT_HAVE_COOLDOWN,
    UNSET,
    Cooldown,
    CooldownSpec,
    validate_button_cooldown,
)

_EMBED_KNOWN_KEYS = {
    "title",
    "description",
    "color",
    "url",
    "author",
    "thumbnail",
    "image",
    "fields",
    "footer",
    "timestamp",
}
_BUTTON_KNOWN_KEYS = {"id", "label", "style", "emoji", "url"}


def _slugify(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return (slug or "button")[:MAX_BUTTON_ID_LENGTH].strip("-") or "button"


def _require_https(url: str, sentence: str = CAP_IMAGE_URL_NOT_HTTPS) -> None:
    """One https check, two sentences. AMENDMENT-06 §11 asks every new url
    field to reuse this helper; §5 asks a link mistake to be answered with the
    link sentence rather than the image one, because a button target is not an
    image. The sentence is therefore the caller's choice: image urls
    (`thumbnail`, `image`, `author.icon`, `footer.icon`) keep the default,
    link urls pass `CAP_LINK_URL_NOT_HTTPS`."""
    if not url.startswith("https://"):
        raise ValueError(sentence)


def _require_link_url(url: str) -> None:
    """A link target: https, and bounded. The cap counts runes, matching the
    server, and python's `len()` over a `str` already counts code points."""
    _require_https(url, CAP_LINK_URL_NOT_HTTPS)
    if len(url) > MAX_LINK_URL_RUNES:
        raise ValueError(CAP_LINK_URL_TOO_LONG)


def _require_image_url(url: str) -> None:
    """`image.url`/`thumbnail.url` only — https, then the new
    `MAX_IMAGE_URL_RUNES` bound. `author.icon` and `footer.icon` stay
    uncapped and keep calling `_require_https` directly."""
    _require_https(url)
    if len(url) > MAX_IMAGE_URL_RUNES:
        raise ValueError(CAP_IMAGE_URL_TOO_LONG)


_ZWJ = "\u200d"
_VARIATION_TEXT = "\ufe0e"
_VARIATION_EMOJI = "\ufe0f"
_KEYCAP = "\u20e3"


def _is_regional_indicator(ch: str) -> bool:
    return 0x1F1E6 <= ord(ch) <= 0x1F1FF


def _is_skin_tone(ch: str) -> bool:
    return 0x1F3FB <= ord(ch) <= 0x1F3FF


def _is_tag_char(ch: str) -> bool:
    return 0xE0020 <= ord(ch) <= 0xE007F


def _is_keycap_base(ch: str) -> bool:
    return ch.isascii() and (ch.isdigit() or ch in "#*")


def _is_pictographic(ch: str) -> bool:
    """The unicode symbol classes, floored at 0x80 so ASCII punctuation cannot
    pass, widened by the two blocks that carry the emoji the classes miss.

    The floor is the server's deliberate deviation, ported rather than
    reasoned about again: `+`, `<`, `=`, `|` and `~` are all Sm, so a naive
    class test would render a pill with a plus sign in the emoji slot."""
    r = ord(ch)
    if r < 0x80:
        return False
    if 0x2600 <= r <= 0x27BF or 0x1F000 <= r <= 0x1FAFF:
        return True
    return unicodedata.category(ch) in ("So", "Sm")


def _is_single_emoji(value: str) -> bool:
    """A port of the server's `validEmoji` (`backend-go/internal/botapi/emoji.go`),
    rule for rule.

    AMENDMENT-06 §3 asks for exactly one grapheme cluster, and neither side has
    a segmenter: python's standard library has no grapheme segmentation at all,
    and the server refused to add a Go module for one because a package
    addition is an owner gate. The server's hand-rolled approximation is
    therefore the authority, and this mirrors it rather than inventing a third
    rule — an SDK that disagreed with the server about what an emoji is would
    refuse a legal send, which §3 forbids, or teach a bot author a rule the
    next client over does not share.
    """
    if not value:
        return False
    # The outer bound, before the runes are looked at individually. A flag is
    # two, a keycap three, and the longest family in common use is seven;
    # anything past this is a paste, not an emoji.
    if len(value) > MAX_BUTTON_EMOJI_RUNES:
        return False
    first = value[0]
    # A flag is exactly two regional indicators and nothing else: one is half a
    # flag, four is two flags.
    if _is_regional_indicator(first):
        return len(value) == 2 and _is_regional_indicator(value[1])
    # A keycap's base is the one place an ASCII rune is legal, and only when
    # the enclosing mark actually follows. A bare "1" is a digit.
    if _is_keycap_base(first):
        if len(value) == 2:
            return value[1] == _KEYCAP
        if len(value) == 3:
            return value[1] == _VARIATION_EMOJI and value[2] == _KEYCAP
        return False
    if not _is_pictographic(first):
        return False
    # Exactly one base. A later pictographic rune is legal only when the rune
    # before it was a joiner, which is what makes a family one emoji and two
    # dice two emoji.
    prev = first
    for ch in value[1:]:
        if ch in (_ZWJ, _VARIATION_TEXT, _VARIATION_EMOJI) or _is_skin_tone(ch) or _is_tag_char(ch):
            pass
        elif _is_regional_indicator(ch):
            return False
        elif _is_pictographic(ch):
            if prev != _ZWJ:
                return False
        else:
            return False
        prev = ch
    # A sequence that ends on a joiner is joined to nothing.
    return prev != _ZWJ


def _require_emoji(emoji: str) -> None:
    """An empty string is refused rather than read as absence: a
    present-but-blank field is a value the bot author meant that says nothing,
    and `emoji=None` is how a button says it has none."""
    if not _is_single_emoji(emoji):
        raise ValueError(CAP_INVALID_BUTTON_EMOJI)


class Embed:
    """A Discord-shaped embed. Chainable methods each return `self`."""

    def __init__(
        self,
        title: str | None = None,
        description: str | None = None,
        color: str | None = None,
        url: str | None = None,
    ) -> None:
        self._extra: dict[str, object] = {}
        self._title: str | None = None
        self._description: str | None = None
        self._url: str | None = None
        # `title` is assigned first on purpose: the url is refused when there
        # is no title to attach the tap to, so `Embed(title=..., url=...)` has
        # to see the title already set.
        self.title = title
        self.description = description
        self.color = color
        self.url = url
        self.author: dict[str, object] | None = None
        self.thumbnail: dict[str, object] | None = None
        self.image: dict[str, object] | None = None
        self.fields: list[dict[str, object]] = []
        self.footer: dict[str, object] | None = None
        self.timestamp: str | None = None

    @property
    def title(self) -> str | None:
        return self._title

    @title.setter
    def title(self, value: str | None) -> None:
        if value is not None and len(value) > MAX_TITLE_LENGTH:
            raise ValueError(CAP_TITLE_TOO_LONG)
        if not value and self._url is not None:
            raise ValueError(CAP_EMBED_URL_WITHOUT_TITLE)
        self._title = value

    @property
    def url(self) -> str | None:
        return self._url

    @url.setter
    def url(self, value: str | None) -> None:
        """AMENDMENT-06 §5: the url makes the title tappable, so without a
        title there is nothing to attach it to and the whole field would be
        silently dropped. Empty means absent, matching the wire's
        `omitempty` — only a real url has to earn a title."""
        if not value:
            self._url = None
            return
        _require_link_url(value)
        if not self._title:
            raise ValueError(CAP_EMBED_URL_WITHOUT_TITLE)
        self._url = value

    @property
    def description(self) -> str | None:
        return self._description

    @description.setter
    def description(self, value: str | None) -> None:
        if value is not None and len(value) > MAX_DESCRIPTION_LENGTH:
            raise ValueError(CAP_DESCRIPTION_TOO_LONG)
        self._description = value

    def add_field(self, name: str, value: str, inline: bool = False) -> Embed:
        if len(self.fields) >= MAX_EMBED_FIELDS:
            raise ValueError(CAP_TOO_MANY_FIELDS)
        if len(name) > MAX_FIELD_NAME_LENGTH:
            raise ValueError(CAP_FIELD_NAME_TOO_LONG)
        if len(value) > MAX_FIELD_VALUE_LENGTH:
            raise ValueError(CAP_FIELD_VALUE_TOO_LONG)
        self.fields.append({"name": name, "value": value, "inline": inline})
        return self

    def set_author(self, name: str, icon: str | None = None, url: str | None = None) -> Embed:
        if len(name) > MAX_AUTHOR_NAME_LENGTH:
            raise ValueError(CAP_AUTHOR_NAME_TOO_LONG)
        if icon is not None:
            _require_https(icon)
        if url:
            _require_link_url(url)
            if not name:
                raise ValueError(CAP_AUTHOR_URL_WITHOUT_NAME)
        author: dict[str, object] = {"name": name}
        if icon is not None:
            author["icon"] = icon
        if url:
            author["url"] = url
        self.author = author
        return self

    def set_thumbnail(self, url: str) -> Embed:
        _require_image_url(url)
        self.thumbnail = {"url": url}
        return self

    def set_image(self, url: str) -> Embed:
        _require_image_url(url)
        self.image = {"url": url}
        return self

    def set_footer(self, text: str, icon: str | None = None) -> Embed:
        """The icon is an image url, so it carries the image sentence and no
        length cap, exactly like `thumbnail`, `image` and `author.icon`
        (AMENDMENT-06 §2). An icon with no text would render a floating glyph
        on a line with nothing to say, so it is refused."""
        if len(text) > MAX_FOOTER_TEXT_LENGTH:
            raise ValueError(CAP_FOOTER_TEXT_TOO_LONG)
        if icon is not None:
            _require_https(icon)
            if not text:
                raise ValueError(CAP_EMBED_FOOTER_TEXT_REQUIRED)
        footer: dict[str, object] = {"text": text}
        if icon is not None:
            footer["icon"] = icon
        self.footer = footer
        return self

    def set_timestamp(self, value: datetime | str) -> Embed:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            value = value.astimezone(timezone.utc)
            self.timestamp = value.strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            self.timestamp = value
        return self

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = dict(self._extra)
        if self.title is not None:
            d["title"] = self.title
        if self.description is not None:
            d["description"] = self.description
        if self.color is not None:
            d["color"] = self.color
        if self.url is not None:
            d["url"] = self.url
        if self.author is not None:
            d["author"] = self.author
        if self.thumbnail is not None:
            d["thumbnail"] = self.thumbnail
        if self.image is not None:
            d["image"] = self.image
        if self.fields:
            d["fields"] = self.fields
        if self.footer is not None:
            d["footer"] = self.footer
        if self.timestamp is not None:
            d["timestamp"] = self.timestamp
        return d

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Embed:
        title = data.get("title")
        description = data.get("description")
        color = data.get("color")
        url = data.get("url")
        embed = cls(
            title=title if isinstance(title, str) else None,
            description=description if isinstance(description, str) else None,
            color=color if isinstance(color, str) else None,
            url=url if isinstance(url, str) else None,
        )
        author = data.get("author")
        if isinstance(author, dict):
            name = author.get("name")
            icon = author.get("icon")
            author_url = author.get("url")
            embed.set_author(
                str(name) if name is not None else "",
                str(icon) if isinstance(icon, str) else None,
                str(author_url) if isinstance(author_url, str) else None,
            )
        thumbnail = data.get("thumbnail")
        if isinstance(thumbnail, dict) and isinstance(thumbnail.get("url"), str):
            embed.set_thumbnail(str(thumbnail["url"]))
        image = data.get("image")
        if isinstance(image, dict) and isinstance(image.get("url"), str):
            embed.set_image(str(image["url"]))
        fields = data.get("fields")
        if isinstance(fields, list):
            for f in fields:
                if isinstance(f, dict):
                    embed.add_field(
                        str(f.get("name", "")),
                        str(f.get("value", "")),
                        bool(f.get("inline", False)),
                    )
        footer = data.get("footer")
        if isinstance(footer, dict):
            footer_text = footer.get("text")
            footer_icon = footer.get("icon")
            if isinstance(footer_text, str) or isinstance(footer_icon, str):
                embed.set_footer(
                    footer_text if isinstance(footer_text, str) else "",
                    footer_icon if isinstance(footer_icon, str) else None,
                )
        timestamp = data.get("timestamp")
        if isinstance(timestamp, str):
            embed.set_timestamp(timestamp)
        embed._extra = {k: v for k, v in data.items() if k not in _EMBED_KNOWN_KEYS}
        return embed


class Button:
    """A Discord-shaped button. `Button("Pacific")` derives an id from the
    label; pass `id=` to pin one explicitly. A link pill is built through
    `Button.link(...)`, never by passing `style="link"` without a url.

    `cooldown` (AMENDMENT-08 §3) is tri-state: leave it unset to inherit
    whatever the card (`send(..., button_cooldown=)`) or the bot
    (`Bot(button_cooldown=)`) has, pass `None` to disable a cooldown for this
    one button, or pass a `Cooldown` to use it — precedence is button > card
    > bot default. Bounded to 60 seconds, validated here at attachment time.
    A link button can never carry one: it never round-trips to the SDK, so
    there is nothing to throttle."""

    def __init__(
        self,
        label: str,
        id: str | None = None,
        style: str = "primary",
        emoji: str | None = None,
        url: str | None = None,
        cooldown: CooldownSpec = UNSET,
    ) -> None:
        if not label:
            raise ValueError(CAP_BUTTON_MISSING_LABEL)
        if len(label) > MAX_LABEL_RUNES:
            raise ValueError(CAP_LABEL_TOO_LONG)
        if style not in BUTTON_STYLES:
            raise ValueError(CAP_BAD_BUTTON_STYLE)
        # Empty means absent, matching the wire's `omitempty`; a link button
        # with an empty url is therefore a link button with no url at all.
        resolved_url = url or None
        if style == "link":
            if resolved_url is None:
                raise ValueError(CAP_LINK_BUTTON_MISSING_URL)
        elif resolved_url is not None:
            raise ValueError(CAP_URL_ON_NON_LINK_BUTTON)
        if resolved_url is not None:
            _require_link_url(resolved_url)
        if id is not None:
            if len(id) > MAX_BUTTON_ID_LENGTH:
                raise ValueError(CAP_BUTTON_ID_TOO_LONG)
            resolved_id = id
        else:
            resolved_id = _slugify(label)
        if emoji is not None:
            _require_emoji(emoji)
        if isinstance(cooldown, Cooldown):
            # A link button never reaches the SDK for a press (AMENDMENT-08
            # §7), so a cooldown on one can never do anything — refused here,
            # not silently ignored.
            if style == "link":
                raise ValueError(LINK_BUTTON_CANNOT_HAVE_COOLDOWN)
            validate_button_cooldown(cooldown)
        self.label = label
        self.style = style
        self.id = resolved_id
        self.emoji = emoji
        self.url = resolved_url
        self.cooldown: CooldownSpec = cooldown
        self._extra: dict[str, object] = {}

    @classmethod
    def link(
        cls, label: str, url: str, id: str | None = None, emoji: str | None = None
    ) -> Button:
        """The sanctioned way to build a link pill (AMENDMENT-06 §11). A tap
        opens the url on the device and stops there: no event comes back, and
        the row is never marked used. The label stays required and the id is
        still slugged from it, exactly as for an action button. No
        `cooldown` parameter here on purpose — see `Button`'s docstring."""
        return cls(label, id=id, style="link", emoji=emoji, url=url)

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = dict(self._extra)
        d["id"] = self.id
        d["label"] = self.label
        d["style"] = self.style
        if self.emoji is not None:
            d["emoji"] = self.emoji
        if self.url is not None:
            d["url"] = self.url
        return d

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Button:
        label = data.get("label")
        style = data.get("style")
        button_id = data.get("id")
        emoji = data.get("emoji")
        url = data.get("url")
        btn = cls(
            label=str(label) if label is not None else "",
            id=str(button_id) if isinstance(button_id, str) else None,
            style=str(style) if isinstance(style, str) else "primary",
            emoji=emoji if isinstance(emoji, str) else None,
            url=url if isinstance(url, str) else None,
        )
        btn._extra = {k: v for k, v in data.items() if k not in _BUTTON_KNOWN_KEYS}
        return btn


@dataclasses.dataclass(frozen=True)
class ButtonUsed:
    button: str
    user: str
    at: str

    def to_dict(self) -> dict[str, object]:
        return {"button": self.button, "user": self.user, "at": self.at}

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> ButtonUsed:
        return cls(
            button=str(data.get("button", "")),
            user=str(data.get("user", "")),
            at=str(data.get("at", "")),
        )


EmbedLike = Union[Embed, "dict[str, object]"]
ButtonLike = Union[Button, "dict[str, object]"]


def serialise_embeds(embeds: list[EmbedLike] | None) -> list[dict[str, object]]:
    """Validate and serialise a list of `Embed` builders or raw dicts to
    shape (a). A raw dict is validated to the same cap sentences as a builder
    — it is never a bypass. Empty/`None` returns `[]` (the caller omits it).

    `MAX_EMBED_FIELDS` (6) is a per-message cap, summed across every embed's
    fields (AMENDMENT-05 §2) — a single embed's `.add_field` already refuses
    its own 7th field, but two embeds of 4 and 3 fields must also be refused
    here, at the combined total. `MAX_EMBED_TOTAL_LENGTH` (6000) is the same
    kind of whole-message cap, summed across every embed's title,
    description, field name and value, author name and footer text — not the
    message `text` itself."""
    if not embeds:
        return []
    if len(embeds) > MAX_EMBEDS:
        raise ValueError(CAP_TOO_MANY_EMBEDS)
    result: list[dict[str, object]] = []
    total_fields = 0
    total_length = 0
    for e in embeds:
        if isinstance(e, Embed):
            d = e.to_dict()
        elif isinstance(e, dict):
            d = Embed.from_dict(e).to_dict()
        else:
            raise TypeError(f"embeds entries must be Embed or dict, got {type(e)!r}")
        fields = d.get("fields")
        total_fields += len(fields) if isinstance(fields, list) else 0
        if total_fields > MAX_EMBED_FIELDS:
            raise ValueError(CAP_TOO_MANY_FIELDS)
        title = d.get("title")
        total_length += len(title) if isinstance(title, str) else 0
        description = d.get("description")
        total_length += len(description) if isinstance(description, str) else 0
        if isinstance(fields, list):
            for f in fields:
                if isinstance(f, dict):
                    name = f.get("name")
                    total_length += len(name) if isinstance(name, str) else 0
                    value = f.get("value")
                    total_length += len(value) if isinstance(value, str) else 0
        author = d.get("author")
        if isinstance(author, dict):
            author_name = author.get("name")
            total_length += len(author_name) if isinstance(author_name, str) else 0
        footer = d.get("footer")
        if isinstance(footer, dict):
            footer_text = footer.get("text")
            total_length += len(footer_text) if isinstance(footer_text, str) else 0
        if total_length > MAX_EMBED_TOTAL_LENGTH:
            raise ValueError(CAP_EMBEDS_TOO_LONG)
        result.append(d)
    return result


def resolve_buttons(buttons: list[ButtonLike] | None) -> list[Button]:
    """Validate a list of `Button` builders or raw dicts to shape (a)'s
    within-message rules — cap, duplicate id — and return the resolved
    `Button` objects (not yet serialised). `serialise_buttons` is this plus
    `.to_dict()`; this half exists on its own so a caller that needs the
    resolved `.id`/`.cooldown` (AMENDMENT-08's card-cooldown lookup table)
    doesn't have to re-run resolution against the serialised dicts."""
    if not buttons:
        return []
    if len(buttons) > MAX_BUTTONS:
        raise ValueError(CAP_TOO_MANY_BUTTONS)
    result: list[Button] = []
    seen_ids: set[str] = set()
    for b in buttons:
        if isinstance(b, Button):
            btn = b
        elif isinstance(b, dict):
            btn = Button.from_dict(b)
        else:
            raise TypeError(f"buttons entries must be Button or dict, got {type(b)!r}")
        if btn.id in seen_ids:
            raise ValueError(CAP_DUPLICATE_BUTTON_ID)
        seen_ids.add(btn.id)
        result.append(btn)
    return result


def serialise_buttons(buttons: list[ButtonLike] | None) -> list[dict[str, object]]:
    """Same rules as `serialise_embeds`, plus a within-message duplicate-id
    refusal (CONTRACT-V1: a button id must be unique within a message)."""
    return [btn.to_dict() for btn in resolve_buttons(buttons)]
