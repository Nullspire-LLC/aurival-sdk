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
from datetime import datetime, timezone
from typing import Union

from .caps import (
    BUTTON_STYLES,
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
    MAX_BUTTON_ID_LENGTH,
    MAX_BUTTONS,
    MAX_DESCRIPTION_LENGTH,
    MAX_EMBED_FIELDS,
    MAX_EMBEDS,
    MAX_LABEL_RUNES,
    MAX_TITLE_LENGTH,
)

_EMBED_KNOWN_KEYS = {
    "title",
    "description",
    "color",
    "author",
    "thumbnail",
    "image",
    "fields",
    "footer",
    "timestamp",
}
_BUTTON_KNOWN_KEYS = {"id", "label", "style"}


def _slugify(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return (slug or "button")[:MAX_BUTTON_ID_LENGTH].strip("-") or "button"


def _require_https(url: str) -> None:
    if not url.startswith("https://"):
        raise ValueError(CAP_IMAGE_URL_NOT_HTTPS)


class Embed:
    """A Discord-shaped embed. Chainable methods each return `self`."""

    def __init__(
        self,
        title: str | None = None,
        description: str | None = None,
        color: str | None = None,
    ) -> None:
        self._extra: dict[str, object] = {}
        self._title: str | None = None
        self._description: str | None = None
        self.title = title
        self.description = description
        self.color = color
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
        self._title = value

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
        self.fields.append({"name": name, "value": value, "inline": inline})
        return self

    def set_author(self, name: str, icon: str | None = None) -> Embed:
        if icon is not None:
            _require_https(icon)
        author: dict[str, object] = {"name": name}
        if icon is not None:
            author["icon"] = icon
        self.author = author
        return self

    def set_thumbnail(self, url: str) -> Embed:
        _require_https(url)
        self.thumbnail = {"url": url}
        return self

    def set_image(self, url: str) -> Embed:
        _require_https(url)
        self.image = {"url": url}
        return self

    def set_footer(self, text: str) -> Embed:
        self.footer = {"text": text}
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
        embed = cls(
            title=title if isinstance(title, str) else None,
            description=description if isinstance(description, str) else None,
            color=color if isinstance(color, str) else None,
        )
        author = data.get("author")
        if isinstance(author, dict):
            name = author.get("name")
            icon = author.get("icon")
            embed.set_author(
                str(name) if name is not None else "",
                str(icon) if isinstance(icon, str) else None,
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
        if isinstance(footer, dict) and isinstance(footer.get("text"), str):
            embed.set_footer(str(footer["text"]))
        timestamp = data.get("timestamp")
        if isinstance(timestamp, str):
            embed.set_timestamp(timestamp)
        embed._extra = {k: v for k, v in data.items() if k not in _EMBED_KNOWN_KEYS}
        return embed


class Button:
    """A Discord-shaped button. `Button("Pacific")` derives an id from the
    label; pass `id=` to pin one explicitly."""

    def __init__(self, label: str, id: str | None = None, style: str = "primary") -> None:
        if len(label) > MAX_LABEL_RUNES:
            raise ValueError(CAP_LABEL_TOO_LONG)
        if style == "link":
            raise ValueError(CAP_LINK_STYLE_DEFERRED)
        if style not in BUTTON_STYLES:
            raise ValueError(CAP_BAD_BUTTON_STYLE)
        if id is not None:
            if len(id) > MAX_BUTTON_ID_LENGTH:
                raise ValueError(CAP_BUTTON_ID_TOO_LONG)
            resolved_id = id
        else:
            resolved_id = _slugify(label)
        self.label = label
        self.style = style
        self.id = resolved_id
        self._extra: dict[str, object] = {}

    def to_dict(self) -> dict[str, object]:
        d: dict[str, object] = dict(self._extra)
        d["id"] = self.id
        d["label"] = self.label
        d["style"] = self.style
        return d

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Button:
        label = data.get("label")
        style = data.get("style")
        button_id = data.get("id")
        btn = cls(
            label=str(label) if label is not None else "",
            id=str(button_id) if isinstance(button_id, str) else None,
            style=str(style) if isinstance(style, str) else "primary",
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
    here, at the combined total."""
    if not embeds:
        return []
    if len(embeds) > MAX_EMBEDS:
        raise ValueError(CAP_TOO_MANY_EMBEDS)
    result: list[dict[str, object]] = []
    total_fields = 0
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
        result.append(d)
    return result


def serialise_buttons(buttons: list[ButtonLike] | None) -> list[dict[str, object]]:
    """Same rules as `serialise_embeds`, plus a within-message duplicate-id
    refusal (CONTRACT-V1: a button id must be unique within a message)."""
    if not buttons:
        return []
    if len(buttons) > MAX_BUTTONS:
        raise ValueError(CAP_TOO_MANY_BUTTONS)
    result: list[dict[str, object]] = []
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
        result.append(btn.to_dict())
    return result
