"""Card forms (AMENDMENT-10): typed field constructors, the form definition a
`Button.form` carries, and the typed accessors a `form.submitted` handler reads
its answers through.

Everything a bot sends is validated here, before the round trip, to the caps in
`caps.py`; the server parses again and is the authority. A validation failure
is a `ValueError` whose message starts with a pointer-like path to the offending
property (`integer.min: ...`, `fields.seats.label: ...`), the same exception
type `embeds.py` raises for its caps.

Answers come back typed: integers and decimals are JSON numbers, booleans are
`true`/`false`, an unanswered optional field is `null`. `FormValues` reads them
through accessors (`.int`, `.decimal`, `.str`, `.bool`, `.choice`) that refuse a
mismatched type with `FormValueError` instead of handing back something that
only looks right. Decimals are parsed from the JSON text with `Decimal`, so
`12.50` keeps its scale and no value ever passes through a binary float.
"""

from __future__ import annotations

import dataclasses
import json
import re
from collections.abc import Iterator, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import NoReturn

from .caps import (
    CAP_BUTTON_ID_TOO_LONG,
    DEFAULT_DECIMAL_SCALE,
    EMAIL_MAX_LENGTH,
    FORM_SUBMISSIONS,
    MAX_BUTTON_ID_LENGTH,
    MAX_DECIMAL_ABS,
    MAX_DECIMAL_SCALE,
    MAX_FORM_FIELD_ID_LENGTH,
    MAX_FORM_FIELD_LABEL_RUNES,
    MAX_FORM_FIELDS,
    MAX_FORM_PLACEHOLDER_RUNES,
    MAX_FORM_SUBMIT_LABEL_RUNES,
    MAX_FORM_TITLE_RUNES,
    MAX_OPTION_LABEL_RUNES,
    MAX_OPTION_VALUE_LENGTH,
    MAX_SAFE_INTEGER,
    MAX_SELECT_OPTIONS,
    MIN_DECIMAL_SCALE,
    MIN_FORM_FIELDS,
    MIN_SELECT_OPTIONS,
    PARAGRAPH_DEFAULT_MAX_LENGTH,
    PARAGRAPH_MAX_LENGTH_CAP,
    STRING_DEFAULT_MAX_LENGTH,
    STRING_MAX_LENGTH_CAP,
    URL_MAX_LENGTH,
)
from .errors import AurivalError

# Class bodies below define methods named `int`, `str` and `bool`; a class-scope
# name wins over the builtin in annotations, so the annotations use these.
_Int = int
_Str = str
_Bool = bool

_ID_RE = re.compile(r"^[a-z0-9_]+$")

FIELD_KINDS = (
    "string",
    "paragraph",
    "integer",
    "decimal",
    "email",
    "url",
    "phone",
    "select",
    "boolean",
)

_LENGTH_KINDS = frozenset({"string", "paragraph", "email", "url", "phone"})

# AMENDMENT-10 §1 "Allowed properties per type", as the set of optional
# properties each kind accepts besides `id`, `type` and `label`.
_ALLOWED: dict[str, frozenset[str]] = {
    "string": frozenset({"placeholder", "required", "value", "min_length", "max_length"}),
    "paragraph": frozenset({"placeholder", "required", "value", "min_length", "max_length"}),
    "email": frozenset({"placeholder", "required", "value", "min_length", "max_length"}),
    "url": frozenset({"placeholder", "required", "value", "min_length", "max_length"}),
    "phone": frozenset({"placeholder", "required", "value", "min_length", "max_length"}),
    "integer": frozenset({"placeholder", "required", "value", "min", "max"}),
    "decimal": frozenset({"placeholder", "required", "value", "min", "max", "scale"}),
    "select": frozenset({"required", "value", "options"}),
    "boolean": frozenset({"value"}),
}

_LENGTH_DEFAULT_MAX: dict[str, int | None] = {
    "string": STRING_DEFAULT_MAX_LENGTH,
    "paragraph": PARAGRAPH_DEFAULT_MAX_LENGTH,
    "email": EMAIL_MAX_LENGTH,
    "url": URL_MAX_LENGTH,
    "phone": None,
}
_LENGTH_CAP: dict[str, int | None] = {
    "string": STRING_MAX_LENGTH_CAP,
    "paragraph": PARAGRAPH_MAX_LENGTH_CAP,
    "email": EMAIL_MAX_LENGTH,
    "url": URL_MAX_LENGTH,
    "phone": None,
}


class FormValueError(AurivalError, ValueError):
    """A `form.submitted` accessor refused: the field is not in the answers, or
    its stored value is not the type the accessor reads."""


def _fail(path: str, sentence: str) -> NoReturn:
    raise ValueError(f"{path}: {sentence}")


def _is_plain_int(v: object) -> bool:
    # `bool` is an `int` subclass in Python — `isinstance(True, int)` is True —
    # so a stray boolean would silently become 0 or 1. A bool is never an int.
    return isinstance(v, int) and not isinstance(v, bool)


def _to_decimal(v: object, path: str) -> Decimal:
    """Any finite number a bot may hand us as an exact `Decimal`. A float goes
    through its shortest repr (never binary arithmetic), a str is parsed as
    decimal text, a bool is refused."""
    if isinstance(v, bool):
        _fail(path, "must be a number, not a boolean")
    if isinstance(v, Decimal):
        d = v
    elif isinstance(v, int):
        d = Decimal(v)
    elif isinstance(v, float):
        d = Decimal(repr(v))
    elif isinstance(v, str):
        try:
            d = Decimal(v.strip())
        except InvalidOperation:
            _fail(path, "must be a number")
    else:
        _fail(path, "must be a number")
    if not d.is_finite():
        _fail(path, "must be a finite number")
    if abs(d) > MAX_DECIMAL_ABS:
        _fail(path, f"must be between -{MAX_DECIMAL_ABS} and {MAX_DECIMAL_ABS}")
    return d


def _decimal_places(d: Decimal) -> int:
    exponent = d.as_tuple().exponent
    assert isinstance(exponent, int)
    return max(0, -exponent)


def _decimal_to_wire(d: Decimal, path: str) -> int | float:
    """A JSON number for `d` that a JSON parser reads back as the same value.
    Whole numbers go out as ints. Anything else goes out as a double, and is
    refused here if the double does not round-trip to exactly `d` — a bound or
    prefill must never be silently altered on its way to the server."""
    if d == d.to_integral_value():
        return int(d)
    f = float(d)
    if Decimal(repr(f)) != d:
        _fail(path, "has more digits than a JSON number can carry exactly")
    return f


@dataclasses.dataclass(frozen=True)
class Field:
    """One form field. Build it with the typed constructors
    (`Field.string(...)`, `Field.integer(...)` and so on); each takes exactly
    the properties its type allows, so a property that type does not allow is
    a `TypeError` at the call. The field's id is the key it is given in
    `define_form(fields={...})`."""

    kind: str
    label: str
    placeholder: str | None = None
    required: bool = True
    value: object = None
    min_length: int | None = None
    max_length: int | None = None
    minimum: int | Decimal | None = None
    maximum: int | Decimal | None = None
    scale: int | None = None
    options: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        _validate_field(self)

    # -- constructors ------------------------------------------------------

    @staticmethod
    def string(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
    ) -> Field:
        """Single-line text. `max_length` defaults to 100, capped at 200."""
        return Field("string", label, placeholder, required, value, min_length, max_length)

    @staticmethod
    def paragraph(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
    ) -> Field:
        """Multi-line text. `max_length` defaults to 1000, capped at 4000."""
        return Field("paragraph", label, placeholder, required, value, min_length, max_length)

    @staticmethod
    def integer(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: int | None = None,
        min: int | None = None,
        max: int | None = None,
    ) -> Field:
        """A whole number within +-(2^53 - 1). Booleans are not integers."""
        return Field(
            "integer",
            label,
            placeholder,
            required,
            value,
            minimum=min,
            maximum=max,
        )

    @staticmethod
    def decimal(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: int | float | Decimal | str | None = None,
        min: int | float | Decimal | str | None = None,
        max: int | float | Decimal | str | None = None,
        scale: int = DEFAULT_DECIMAL_SCALE,
    ) -> Field:
        """A decimal number with at most `scale` places (0 to 6, default 2),
        absolute value at most 1e12. Bounds and prefill take an int, float,
        `Decimal` or numeric string; they are held as exact `Decimal`s."""
        return Field(
            "decimal",
            label,
            placeholder,
            required,
            value,
            minimum=None if min is None else _to_decimal(min, "decimal.min"),
            maximum=None if max is None else _to_decimal(max, "decimal.max"),
            scale=scale,
        )

    @staticmethod
    def email(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
    ) -> Field:
        """An email address, at most 254 characters."""
        return Field("email", label, placeholder, required, value, min_length, max_length)

    @staticmethod
    def url(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
    ) -> Field:
        """An http or https link, at most 2048 characters."""
        return Field("url", label, placeholder, required, value, min_length, max_length)

    @staticmethod
    def phone(
        label: str,
        *,
        placeholder: str | None = None,
        required: bool = True,
        value: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
    ) -> Field:
        """A phone number. It arrives as a string, never a number, so a leading
        zero survives."""
        return Field("phone", label, placeholder, required, value, min_length, max_length)

    @staticmethod
    def select(
        label: str,
        *,
        options: Sequence[Mapping[str, str] | tuple[str, str]],
        required: bool = True,
        value: str | None = None,
    ) -> Field:
        """A choice among 2 to 10 options, each `{"value": ..., "label": ...}`
        (or a `(value, label)` pair). The answer is the option's `value`."""
        pairs: list[tuple[str, str]] = []
        for i, option in enumerate(options):
            if isinstance(option, tuple):
                if len(option) != 2:
                    _fail(f"select.options[{i}]", "must be a (value, label) pair")
                pairs.append((option[0], option[1]))
            elif isinstance(option, Mapping):
                extra = set(option) - {"value", "label"}
                if extra:
                    _fail(f"select.options[{i}].{sorted(extra)[0]}", "is not a known property")
                pairs.append((option.get("value", ""), option.get("label", "")))
            else:
                _fail(f"select.options[{i}]", "must be a mapping or a (value, label) pair")
        return Field("select", label, None, required, value, options=tuple(pairs))

    @staticmethod
    def boolean(label: str, *, value: bool = False) -> Field:
        """A yes/no switch. Always answered (default off), so it takes no
        `required` and no `placeholder`."""
        return Field("boolean", label, None, True, value)

    # -- wire ---------------------------------------------------------------

    def to_dict(self, field_id: str) -> dict[str, object]:
        """The wire object of AMENDMENT-10 §1: snake_case, with the id and type
        first. Only what was set is present."""
        d: dict[str, object] = {"id": field_id, "type": self.kind, "label": self.label}
        allowed = _ALLOWED[self.kind]
        if self.placeholder is not None:
            d["placeholder"] = self.placeholder
        if "required" in allowed and not self.required:
            d["required"] = False
        if self.min_length is not None:
            d["min_length"] = self.min_length
        if self.max_length is not None:
            d["max_length"] = self.max_length
        if self.minimum is not None:
            d["min"] = self._number_wire(self.minimum, "min")
        if self.maximum is not None:
            d["max"] = self._number_wire(self.maximum, "max")
        if self.scale is not None:
            d["scale"] = self.scale
        if self.options:
            d["options"] = [{"value": v, "label": lab} for v, lab in self.options]
        if self.value is not None:
            d["value"] = (
                self._number_wire(self.value, "value")
                if self.kind == "decimal" and isinstance(self.value, Decimal)
                else self.value
            )
        return d

    def _number_wire(self, v: object, prop: str) -> object:
        if isinstance(v, Decimal):
            return _decimal_to_wire(v, f"{self.kind}.{prop}")
        return v

    @staticmethod
    def from_dict(data: Mapping[str, object]) -> Field:
        """Rebuild a field from its wire object (a raw dict a caller passed in
        place of a `Form`). Every property is checked against the allowed-
        properties table, so a raw dict is never a way around the caps."""
        field_id = data.get("id", "")
        kind = data.get("type")
        where = f"fields.{field_id}"
        if not isinstance(kind, str) or kind not in FIELD_KINDS:
            _fail(f"{where}.type", f"must be one of {', '.join(FIELD_KINDS)}")
        label = data.get("label")
        if not isinstance(label, str):
            _fail(f"{where}.label", "is required")
        props = {k: v for k, v in data.items() if k not in ("id", "type", "label")}
        for key in props:
            if key not in _ALLOWED[kind]:
                _fail(f"{where}.{key}", f"is not allowed on a {kind} field")
        options = props.pop("options", ())
        pairs: list[tuple[str, str]] = []
        if options:
            if not isinstance(options, Sequence) or isinstance(options, str):
                _fail(f"{where}.options", "must be a list")
            for i, option in enumerate(options):
                if not isinstance(option, Mapping):
                    _fail(f"{where}.options[{i}]", "must be an object")
                pairs.append((option.get("value", ""), option.get("label", "")))
        if "options" in _ALLOWED[kind] and not pairs:
            _fail(f"{where}.options", "is required")
        kwargs: dict[str, object] = {
            "placeholder": props.get("placeholder"),
            "required": props.get("required", True),
            "value": props.get("value"),
            "min_length": props.get("min_length"),
            "max_length": props.get("max_length"),
            "scale": props.get("scale"),
            "options": tuple(pairs),
        }
        if kind == "boolean" and kwargs["value"] is None:
            kwargs["value"] = False
        minimum, maximum = props.get("min"), props.get("max")
        if kind == "decimal":
            minimum = None if minimum is None else _to_decimal(minimum, f"{where}.min")
            maximum = None if maximum is None else _to_decimal(maximum, f"{where}.max")
            if kwargs["scale"] is None:
                kwargs["scale"] = DEFAULT_DECIMAL_SCALE
        return Field(kind, label, minimum=minimum, maximum=maximum, **kwargs)  # type: ignore[arg-type]


def _validate_field(f: Field) -> None:
    kind = f.kind
    if kind not in FIELD_KINDS:
        _fail("type", f"must be one of {', '.join(FIELD_KINDS)}")
    p = kind
    if not isinstance(f.label, str) or not 1 <= len(f.label) <= MAX_FORM_FIELD_LABEL_RUNES:
        _fail(f"{p}.label", f"must be 1 to {MAX_FORM_FIELD_LABEL_RUNES} characters")
    if f.placeholder is not None and (
        not isinstance(f.placeholder, str) or len(f.placeholder) > MAX_FORM_PLACEHOLDER_RUNES
    ):
        _fail(f"{p}.placeholder", f"must be a string of at most {MAX_FORM_PLACEHOLDER_RUNES}")
    if not isinstance(f.required, bool):
        _fail(f"{p}.required", "must be true or false")
    allowed = _ALLOWED[kind]
    if "placeholder" not in allowed and f.placeholder is not None:
        _fail(f"{p}.placeholder", f"is not allowed on a {kind} field")
    if "required" not in allowed and not f.required:
        _fail(f"{p}.required", f"is not allowed on a {kind} field")
    if f.scale is not None and "scale" not in allowed:
        _fail(f"{p}.scale", f"is not allowed on a {kind} field")
    if (f.min_length is not None or f.max_length is not None) and kind not in _LENGTH_KINDS:
        _fail(f"{p}.min_length", f"min_length and max_length are not allowed on a {kind} field")
    if (f.minimum is not None or f.maximum is not None) and "min" not in allowed:
        _fail(f"{p}.min", f"min and max are not allowed on a {kind} field")
    if f.options and kind != "select":
        _fail(f"{p}.options", f"is not allowed on a {kind} field")

    if kind in _LENGTH_KINDS:
        _validate_length_field(f)
    elif kind == "integer":
        _validate_integer_field(f)
    elif kind == "decimal":
        _validate_decimal_field(f)
    elif kind == "select":
        _validate_select_field(f)
    else:
        if not isinstance(f.value, bool):
            _fail("boolean.value", "must be true or false")


def _validate_length_field(f: Field) -> None:
    kind = f.kind
    for prop, v in (("min_length", f.min_length), ("max_length", f.max_length)):
        if v is not None and (not _is_plain_int(v) or v < 0):
            _fail(f"{kind}.{prop}", "must be a whole number of at least 0")
    cap = _LENGTH_CAP[kind]
    if f.max_length is not None:
        if f.max_length < 1:
            _fail(f"{kind}.max_length", "must be at least 1")
        if cap is not None and f.max_length > cap:
            _fail(f"{kind}.max_length", f"must be at most {cap}")
    effective_max = f.max_length if f.max_length is not None else _LENGTH_DEFAULT_MAX[kind]
    min_length = f.min_length or 0
    if effective_max is not None and min_length > effective_max:
        _fail(f"{kind}.min_length", f"must not exceed max_length ({effective_max})")
    if f.value is not None:
        if not isinstance(f.value, str):
            _fail(f"{kind}.value", "must be a string")
        if len(f.value) < min_length or (effective_max is not None and len(f.value) > effective_max):
            _fail(f"{kind}.value", "is outside the field's length bounds")


def _validate_integer_field(f: Field) -> None:
    for prop, v in (("min", f.minimum), ("max", f.maximum), ("value", f.value)):
        if v is None:
            continue
        if not _is_plain_int(v) or not isinstance(v, int):
            _fail(f"integer.{prop}", "must be a whole number (a boolean is not one)")
        if abs(v) > MAX_SAFE_INTEGER:
            _fail(f"integer.{prop}", f"must be within +-{MAX_SAFE_INTEGER}")
    lo, hi, v = f.minimum, f.maximum, f.value
    if lo is not None and hi is not None and lo > hi:
        _fail("integer.min", "must not exceed max")
    if isinstance(v, int) and not isinstance(v, bool):
        if lo is not None and v < lo or hi is not None and v > hi:
            _fail("integer.value", "is outside the field's min and max")


def _validate_decimal_field(f: Field) -> None:
    scale = f.scale
    if scale is None or not _is_plain_int(scale) or not MIN_DECIMAL_SCALE <= scale <= MAX_DECIMAL_SCALE:
        _fail("decimal.scale", f"must be a whole number from {MIN_DECIMAL_SCALE} to {MAX_DECIMAL_SCALE}")
    lo = None if f.minimum is None else _to_decimal(f.minimum, "decimal.min")
    hi = None if f.maximum is None else _to_decimal(f.maximum, "decimal.max")
    if lo is not None and hi is not None and lo > hi:
        _fail("decimal.min", "must not exceed max")
    if f.value is not None:
        value = _to_decimal(f.value, "decimal.value")
        if _decimal_places(value) > scale:
            _fail("decimal.value", f"has more than {scale} decimal places")
        if lo is not None and value < lo or hi is not None and value > hi:
            _fail("decimal.value", "is outside the field's min and max")
        # Held as the exact Decimal from here on; the frozen dataclass allows
        # this one normalising write because the constructor is the only door.
        object.__setattr__(f, "value", value)
    for prop, bound in (("min", lo), ("max", hi)):
        if bound is not None:
            _decimal_to_wire(bound, f"decimal.{prop}")
            object.__setattr__(f, "minimum" if prop == "min" else "maximum", bound)
    if isinstance(f.value, Decimal):
        _decimal_to_wire(f.value, "decimal.value")


def _validate_select_field(f: Field) -> None:
    options = f.options
    if not MIN_SELECT_OPTIONS <= len(options) <= MAX_SELECT_OPTIONS:
        _fail(
            "select.options",
            f"must have {MIN_SELECT_OPTIONS} to {MAX_SELECT_OPTIONS} options",
        )
    seen: set[str] = set()
    for i, (value, label) in enumerate(options):
        where = f"select.options[{i}]"
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= MAX_OPTION_VALUE_LENGTH
            or not _ID_RE.match(value)
        ):
            _fail(
                f"{where}.value",
                f"must be 1 to {MAX_OPTION_VALUE_LENGTH} characters from a-z, 0-9 and _",
            )
        if not isinstance(label, str) or not 1 <= len(label) <= MAX_OPTION_LABEL_RUNES:
            _fail(f"{where}.label", f"must be 1 to {MAX_OPTION_LABEL_RUNES} characters")
        if value in seen:
            _fail(f"{where}.value", "must be unique within the field")
        seen.add(value)
    if f.value is not None and f.value not in seen:
        _fail("select.value", "must be one of the option values")


def _check_id(path: str, value: object, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or not _ID_RE.match(value)
    ):
        _fail(path, f"must be 1 to {maximum} characters from a-z, 0-9 and _")
    return value


class Form:
    """A form a button opens. Build it with `define_form(...)`; hand it to
    `Button.form(label=..., form=...)` and to `bot.on_form(form, handler)`.
    `id` is the button's id and the key a submission is routed by."""

    def __init__(
        self,
        *,
        id: str,
        title: str,
        fields: Mapping[str, Field],
        submit_label: str | None = None,
        submission: str = "per_user",
    ) -> None:
        if not isinstance(id, str) or not id:
            _fail("id", "a form id is required")
        if len(id) > MAX_BUTTON_ID_LENGTH:
            raise ValueError(f"id: {CAP_BUTTON_ID_TOO_LONG}")
        if not isinstance(title, str) or not 1 <= len(title) <= MAX_FORM_TITLE_RUNES:
            _fail("title", f"must be 1 to {MAX_FORM_TITLE_RUNES} characters")
        if submit_label is not None and (
            not isinstance(submit_label, str)
            or not 1 <= len(submit_label) <= MAX_FORM_SUBMIT_LABEL_RUNES
        ):
            _fail("submit_label", f"must be 1 to {MAX_FORM_SUBMIT_LABEL_RUNES} characters")
        if submission not in FORM_SUBMISSIONS:
            _fail("submission", f"must be one of {', '.join(FORM_SUBMISSIONS)}")
        if not isinstance(fields, Mapping) or not MIN_FORM_FIELDS <= len(fields) <= MAX_FORM_FIELDS:
            _fail("fields", f"a form has {MIN_FORM_FIELDS} to {MAX_FORM_FIELDS} fields")
        for field_id, field in fields.items():
            _check_id(f"fields.{field_id}", field_id, MAX_FORM_FIELD_ID_LENGTH)
            if not isinstance(field, Field):
                _fail(f"fields.{field_id}", "must be a Field")
        self.id = id
        self.title = title
        self.submit_label = submit_label
        self.submission = submission
        self.fields: dict[str, Field] = dict(fields)

    def to_dict(self) -> dict[str, object]:
        """The `form` object of the button wire shape: fields as an ordered
        array, each with its id."""
        d: dict[str, object] = {"title": self.title}
        if self.submit_label is not None:
            d["submit_label"] = self.submit_label
        if self.submission != "per_user":
            d["submission"] = self.submission
        d["fields"] = [f.to_dict(fid) for fid, f in self.fields.items()]
        return d

    @classmethod
    def from_dict(cls, form_id: str, data: Mapping[str, object]) -> Form:
        """Rebuild (and so re-validate) a `form` wire object under button id
        `form_id`. Unknown top-level keys are refused: bots never set the
        server-written ones."""
        extra = set(data) - {"title", "submit_label", "submission", "fields"}
        if extra:
            _fail(sorted(extra)[0], "is not a known form property")
        raw_fields = data.get("fields")
        if not isinstance(raw_fields, Sequence) or isinstance(raw_fields, str):
            _fail("fields", "must be a list")
        fields: dict[str, Field] = {}
        for i, raw in enumerate(raw_fields):
            if not isinstance(raw, Mapping):
                _fail(f"fields[{i}]", "must be an object")
            field_id = _check_id(f"fields[{i}].id", raw.get("id"), MAX_FORM_FIELD_ID_LENGTH)
            if field_id in fields:
                _fail(f"fields[{i}].id", "must be unique within the form")
            fields[field_id] = Field.from_dict(raw)
        title = data.get("title")
        submit_label = data.get("submit_label")
        submission = data.get("submission", "per_user")
        return cls(
            id=form_id,
            title=title if isinstance(title, str) else "",
            fields=fields,
            submit_label=submit_label if isinstance(submit_label, str) else None,
            submission=submission if isinstance(submission, str) else "",
        )


def define_form(
    *,
    id: str,
    title: str,
    fields: Mapping[str, Field],
    submit_label: str | None = None,
    submission: str = "per_user",
) -> Form:
    """Declare a form: `fields` maps each field id to its `Field`, in the order
    the sheet shows them. `submission="once"` closes the form for everyone after
    the first accepted answer."""
    return Form(
        id=id, title=title, fields=fields, submit_label=submit_label, submission=submission
    )


# --- answers ---------------------------------------------------------------


class FormValues:
    """The typed answers of one submission. Every declared field is present;
    an unanswered optional one is `None`. Read them through the accessors, which
    refuse a mismatched type with `FormValueError`; `[]`/`get` return what is
    stored (a `Decimal` for a decimal, an `int` for an integer)."""

    def __init__(self, values: Mapping[str, object]) -> None:
        self._values: dict[str, object] = dict(values)

    def _lookup(self, name: _Str) -> object:
        if name not in self._values:
            raise FormValueError(f"form has no value for field {name!r}")
        return self._values[name]

    def int(self, name: _Str) -> _Int | None:
        """An integer answer; `None` if left blank. A boolean is never an int."""
        v = self._lookup(name)
        if v is None:
            return None
        if _is_plain_int(v):
            assert isinstance(v, int)
            return v
        if isinstance(v, Decimal) and v.is_finite() and v == v.to_integral_value():
            return int(v)
        raise FormValueError(f"field {name!r} is not an integer: {type(v).__name__}")

    def decimal(self, name: _Str) -> Decimal | None:
        """A decimal answer as an exact `Decimal` (`12.50` keeps its scale); a
        whole number reads as `Decimal('3')`. `None` if left blank."""
        v = self._lookup(name)
        if v is None:
            return None
        if isinstance(v, bool):
            raise FormValueError(f"field {name!r} is not a number: bool")
        if isinstance(v, Decimal):
            return v
        if isinstance(v, int):
            return Decimal(v)
        if isinstance(v, float):
            return Decimal(repr(v))
        raise FormValueError(f"field {name!r} is not a number: {type(v).__name__}")

    def str(self, name: _Str) -> _Str | None:
        """A text answer (string, paragraph, email, url, phone); `None` if blank."""
        v = self._lookup(name)
        if v is None:
            return None
        if isinstance(v, _Str):
            return v
        raise FormValueError(f"field {name!r} is not text: {type(v).__name__}")

    def bool(self, name: _Str) -> _Bool:
        """A switch answer. Never `None`: a boolean field is always answered."""
        v = self._lookup(name)
        if isinstance(v, _Bool):
            return v
        raise FormValueError(f"field {name!r} is not a boolean: {type(v).__name__}")

    def choice(self, name: _Str) -> _Str | None:
        """A select answer: the chosen option's `value`; `None` if blank."""
        v = self._lookup(name)
        if v is None:
            return None
        if isinstance(v, _Str):
            return v
        raise FormValueError(f"field {name!r} is not a choice: {type(v).__name__}")

    def get(self, name: _Str, default: object = None) -> object:
        return self._values.get(name, default)

    def __getitem__(self, name: _Str) -> object:
        return self._lookup(name)

    def __contains__(self, name: object) -> _Bool:
        return name in self._values

    def __iter__(self) -> Iterator[_Str]:
        return iter(self._values)

    def __len__(self) -> _Int:
        return len(self._values)

    def keys(self) -> list[_Str]:
        return list(self._values)

    def __repr__(self) -> _Str:
        return f"FormValues({self._values!r})"


# --- exact JSON text of each value -----------------------------------------

_DECODER = json.JSONDecoder()
_WS = " \t\n\r"


def _skip_ws(s: str, i: int) -> int:
    while i < len(s) and s[i] in _WS:
        i += 1
    return i


def _members(s: str, i: int) -> dict[str, tuple[int, int]]:
    """Source span of every member value of the JSON object starting at `s[i]`.
    A repeated key keeps its last span, as `json.loads` keeps its last value."""
    if s[i] != "{":
        raise ValueError("not an object")
    i = _skip_ws(s, i + 1)
    spans: dict[str, tuple[int, int]] = {}
    if s[i] == "}":
        return spans
    while True:
        key, i = _DECODER.raw_decode(s, i)
        if not isinstance(key, str):
            raise ValueError("object key is not a string")
        i = _skip_ws(s, i)
        if s[i] != ":":
            raise ValueError("expected a colon")
        i = _skip_ws(s, i + 1)
        _, end = _DECODER.raw_decode(s, i)
        spans[key] = (i, end)
        i = _skip_ws(s, end)
        if s[i] == ",":
            i = _skip_ws(s, i + 1)
            continue
        if s[i] == "}":
            return spans
        raise ValueError("expected a comma or a closing brace")


def extract_raw_values(frame_text: str, path: Sequence[str] = ("d", "data", "values")) -> dict[str, str] | None:
    """The exact JSON text of each member of the object at `path` inside the
    gateway frame's source text, byte for byte as the server wrote it
    (`12.50` stays `12.50`). `None` when the text does not have that shape."""
    try:
        start = _skip_ws(frame_text, 0)
        for key in path:
            spans = _members(frame_text, start)
            if key not in spans:
                return None
            start = spans[key][0]
        return {k: frame_text[a:b] for k, (a, b) in _members(frame_text, start).items()}
    except (ValueError, IndexError):
        return None


def reserialise_value(v: object) -> str:
    """Best-effort JSON text of an already-decoded value, for an event that did
    not come off the socket (no source text to capture). Exact for the shapes
    the server emits except where Go's encoder escapes differently."""
    if isinstance(v, Decimal):
        return format(v, "f")
    return json.dumps(v, ensure_ascii=False)


def decode_form_frame(
    text: str, fallback: dict[str, object]
) -> tuple[dict[str, object], dict[str, str] | None]:
    """Decode one `form.submitted` gateway frame the way AMENDMENT-10 §8 asks:
    JSON floats become `Decimal`, parsed from their text, and the exact text of
    each answer is captured. Called by the socket for this event type only, so
    no other event's float decode changes. A frame that does not re-decode
    keeps the plain decode (`fallback`) and no raw text."""
    try:
        frame = json.loads(text, parse_float=Decimal)
    except (ValueError, TypeError):
        return fallback, None
    d = frame.get("d") if isinstance(frame, dict) else None
    if not isinstance(d, dict):
        return fallback, None
    return d, extract_raw_values(text)
