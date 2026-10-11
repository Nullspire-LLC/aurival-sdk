"""The shared form vectors (AMENDMENT-10 §3a), bot side.

Parsing a human's typed answer is the server's job; these rows are what the
server hands a bot. So for every row this checks the two things a bot can get
wrong: the field spec is accepted by the matching `Field` constructor and goes
out as the wire spec, and the answer text the server would send arrives through
the real gateway decode as the right Python value, with `raw_values` holding
the exact JSON text (`12.50` stays `12.50`).

The file is `sdk/testdata/form_vectors.json`, the same data backend-go and the
JS SDK run. It is read by path, never copied.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from test_forms import StubHttp, form_frame, receive_events

from aurival import Field, FormContext, FormValueError, define_form
from aurival.events import context_for

VECTORS_PATH = Path(__file__).resolve().parents[2] / "testdata" / "form_vectors.json"

# Hard-coded so a truncated or emptied file fails instead of passing on less.
EXPECTED_FIELD_ROWS = 63
EXPECTED_FIELD_ROWS_WITH_JSON = 31
EXPECTED_FIELD_ROWS_WITH_CODE = 32
EXPECTED_FORM_ROWS = 2

VECTORS: dict[str, Any] = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
FIELD_ROWS: list[dict[str, Any]] = VECTORS["fields"]
FORM_ROWS: list[dict[str, Any]] = VECTORS["forms"]

ACCESSOR = {
    "string": "str",
    "paragraph": "str",
    "email": "str",
    "url": "str",
    "phone": "str",
    "select": "choice",
    "integer": "int",
    "decimal": "decimal",
    "boolean": "bool",
}


def test_the_vector_path_resolves_into_sdk_testdata() -> None:
    assert VECTORS_PATH.name == "form_vectors.json"
    assert VECTORS_PATH.parent.name == "testdata"
    assert VECTORS_PATH.parent.parent == Path(__file__).resolve().parents[2]
    assert VECTORS_PATH.is_file()


def test_the_file_has_every_row() -> None:
    assert len(FIELD_ROWS) == EXPECTED_FIELD_ROWS
    assert len({r["id"] for r in FIELD_ROWS}) == EXPECTED_FIELD_ROWS
    with_json = [r for r in FIELD_ROWS if "json" in r["expect"]]
    with_code = [r for r in FIELD_ROWS if "code" in r["expect"]]
    assert len(with_json) == EXPECTED_FIELD_ROWS_WITH_JSON
    assert len(with_code) == EXPECTED_FIELD_ROWS_WITH_CODE
    assert len(with_json) + len(with_code) == EXPECTED_FIELD_ROWS
    assert len(FORM_ROWS) == EXPECTED_FORM_ROWS


def build_field(spec: dict[str, Any], label: str = "Label") -> Field:
    """The row's spec through the matching public constructor. A decimal's
    bounds are exact text in the file, so they go in as `Decimal`s."""
    kwargs = {k: v for k, v in spec.items() if k != "type"}
    if spec["type"] == "decimal":
        for key in ("min", "max"):
            if key in kwargs:
                kwargs[key] = Decimal(kwargs[key])
    constructor = getattr(Field, spec["type"])
    field: Field = constructor(label, **kwargs)
    return field


def assert_wire_matches_spec(wire: dict[str, Any], spec: dict[str, Any], label: str) -> None:
    assert wire["id"] == "f"
    assert wire["type"] == spec["type"]
    assert wire["label"] == label
    expected_keys = {"id", "type", "label"} | (set(spec) - {"type"})
    # A boolean's prefill is optional on the wire, and `required: true` is the
    # default so it is never written.
    assert set(wire) <= expected_keys | {"value"}, (set(wire), expected_keys)
    for key, value in spec.items():
        if key == "type":
            continue
        if spec["type"] == "decimal" and key in ("min", "max"):
            assert Decimal(str(wire[key])) == Decimal(value), (key, wire[key], value)
        else:
            assert wire[key] == value, (key, wire[key], value)


@pytest.mark.parametrize("row", FIELD_ROWS, ids=[r["id"] for r in FIELD_ROWS])
def test_every_row_spec_is_accepted_and_serialises_to_the_wire_spec(row: dict[str, Any]) -> None:
    field = build_field(row["spec"])
    assert_wire_matches_spec(field.to_dict("f"), row["spec"], "Label")


def expected_python(kind: str, text: str) -> object:
    """What the accessor must return for the JSON `text` the server sent."""
    if text == "null":
        return None
    if kind == "decimal":
        return Decimal(text)
    return json.loads(text)


async def test_every_expected_value_decodes_through_the_gateway_to_the_right_python_value() -> None:
    rows = [r for r in FIELD_ROWS if "json" in r["expect"]]
    frames = [
        form_frame({"f": r["expect"]["json"]}, event_id=f"evt_{r['id']}", button="b") for r in rows
    ]
    events = await receive_events(frames)
    assert len(events) == len(rows)
    by_id = {e.id: e for e in events}
    failures: list[str] = []
    for row in rows:
        kind = row["spec"]["type"]
        text = row["expect"]["json"]
        ctx = context_for(by_id[f"evt_{row['id']}"], http=StubHttp())  # type: ignore[arg-type]
        assert isinstance(ctx, FormContext)
        got = getattr(ctx.values, ACCESSOR[kind])("f")
        want = expected_python(kind, text)
        if kind == "decimal" and want is not None:
            ok = isinstance(got, Decimal) and got == want and str(got) == str(want)
            # `12.50` keeps its scale: the exponent is part of the answer.
            ok = ok and got.as_tuple() == want.as_tuple()  # type: ignore[union-attr]
        else:
            ok = got == want and type(got) is type(want)
        if not ok:
            failures.append(f"{row['id']}: {kind} {text!r} -> {got!r}, wanted {want!r}")
        if ctx.raw_values != {"f": text}:
            failures.append(f"{row['id']}: raw_values {ctx.raw_values!r}, wanted {text!r}")
    assert not failures, "\n".join(failures)


async def test_the_reserialised_fallback_reproduces_every_expected_text_where_it_can() -> None:
    # Not the primary path (the socket captures the real text), but when a
    # context is built from an already-decoded event it must agree for every
    # row whose text a re-encoder can reproduce: all but strings Go escapes.
    from aurival.forms import reserialise_value

    for row in FIELD_ROWS:
        text = row["expect"].get("json")
        if text is None:
            continue
        decoded = json.loads(text, parse_float=Decimal)
        assert reserialise_value(decoded) == text, row["id"]


async def test_the_decimal_vectors_that_a_float_would_flatten_stay_exact() -> None:
    rows = {r["id"]: r for r in FIELD_ROWS}
    (event,) = await receive_events(
        [form_frame({"f": rows["dec-1"]["expect"]["json"]}, event_id="e", button="b")]
    )
    ctx = context_for(event, http=StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx, FormContext)
    assert ctx.values.decimal("f") == Decimal("12.50")
    assert str(ctx.values.decimal("f")) == "12.50"
    assert ctx.raw_values["f"] == "12.50"
    assert float(ctx.values.decimal("f") or 0) == 12.5  # a float would print 12.5


@pytest.mark.parametrize("row", FORM_ROWS, ids=[r["id"] for r in FORM_ROWS])
async def test_every_form_row_builds_and_its_expected_values_decode(row: dict[str, Any]) -> None:
    fields = {
        spec["id"]: build_field({k: v for k, v in spec.items() if k != "id"}, label=spec["id"])
        for spec in row["fields"]
    }
    form = define_form(id="vector_form", title="Vector form", fields=fields)
    assert [f["id"] for f in form.to_dict()["fields"]] == [s["id"] for s in row["fields"]]  # type: ignore[index, union-attr]

    texts: dict[str, str] = row["expect"]["values"]
    (event,) = await receive_events([form_frame(texts, event_id="e", button="vector_form")])
    ctx = context_for(event, http=StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx, FormContext)
    assert ctx.raw_values == texts
    for name, text in texts.items():
        kind = next(s["type"] for s in row["fields"] if s["id"] == name)
        got = getattr(ctx.values, ACCESSOR[kind])(name)
        assert got == expected_python(kind, text), (row["id"], name)
    # A key the form never declared is not in the answers.
    undeclared = [k for k in row["values"] if k not in fields]
    for name in undeclared:
        assert name not in ctx.values
        with pytest.raises(FormValueError):
            ctx.values.str(name)
