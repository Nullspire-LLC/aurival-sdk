"""AMENDMENT-10 card forms, bot side: the field constructors and their caps, the
wire shape, `Button.form`, the message-level cap, the typed accessors, the
exact-text capture of answers, and a form ack that never carries a cooldown.

The `form.submitted` frames in here go through the real socket
(`run_gateway` + `Socket`), so the Decimal decode and the raw-text capture are
exercised on the path production uses, not on a helper that skips it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from decimal import Decimal
from typing import Any

import pytest
from test_socket import FakeAuth, FakeHttpClient, make_socket, run_gateway, send_hello, wait_until

from aurival import (
    Bot,
    Button,
    Field,
    FormContext,
    FormValueError,
    FormValues,
    define_form,
)
from aurival.cooldown import CooldownTable
from aurival.errors import AurivalError
from aurival.events import Event, context_for

# --- frames ------------------------------------------------------------------


def form_frame(
    values: dict[str, str],
    *,
    event_id: str = "evt_f1",
    button: str = "trip_signup",
    data_extra: str = "",
) -> str:
    """One `form.submitted` event frame as the server writes it: `values` maps
    each field id to the literal JSON text of its value."""
    members = ",".join(f"{json.dumps(k)}:{v}" for k, v in values.items())
    return (
        '{"op":"event","d":{"object":"event","id":"' + event_id + '",'
        '"type":"form.submitted","created_at":"2026-10-08T14:14:03Z","sequence":1,'
        '"data":{"interaction":"int_1","chat":"ch_1","message":"msg_1",'
        '"button":"' + button + '","user":{"id":"u_1","username":"ana"},'
        '"values":{' + members + "}," + data_extra + '"submitted_at":"2026-10-08T14:14:03Z"}}}'
    )


class StubHttp:
    """Enough of `HttpClient` for a context: records acks, holds a real
    cooldown table."""

    def __init__(self) -> None:
        self.acks: list[dict[str, Any]] = []
        self.cooldowns = CooldownTable()

    async def ack_interaction(self, interaction: str, text: str | None = None, **kw: Any) -> dict:
        self.acks.append({"interaction": interaction, "text": text, **kw})
        return {}


async def receive_events(frames: list[str]) -> list[Event]:
    """Send every frame as exact text over a real gateway socket and return the
    events the socket dispatched, in order."""

    async def script(ws, idx, state):  # type: ignore[no-untyped-def]
        await send_hello(ws)
        for text in frames:
            await ws.send_str(text)
        await asyncio.sleep(0.3)

    async with run_gateway(script) as (_state, url):
        sock, dispatched, _ = make_socket(
            FakeHttpClient(url), FakeAuth(), has_handler=lambda t: True
        )
        stop = asyncio.Event()
        task = asyncio.create_task(sock.run(stop))
        try:
            assert await wait_until(lambda: len(dispatched) >= len(frames), timeout=3.0), (
                f"only {len(dispatched)} of {len(frames)} frames were dispatched"
            )
        finally:
            stop.set()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return list(dispatched)


async def receive_form(values: dict[str, str]) -> FormContext:
    (event,) = await receive_events([form_frame(values)])
    ctx = context_for(event, http=StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx, FormContext)
    return ctx


# --- constructors and caps ----------------------------------------------------


def test_the_nine_constructors_build_and_serialise_to_the_wire_shape() -> None:
    options = [{"value": "s", "label": "S"}, {"value": "m", "label": "M"}]
    assert Field.string("Name", min_length=2, max_length=40).to_dict("name") == {
        "id": "name",
        "type": "string",
        "label": "Name",
        "min_length": 2,
        "max_length": 40,
    }
    assert Field.paragraph("Notes", required=False, placeholder="Anything").to_dict("n") == {
        "id": "n",
        "type": "paragraph",
        "label": "Notes",
        "placeholder": "Anything",
        "required": False,
    }
    assert Field.integer("Seats", min=0, max=6, value=2).to_dict("seats") == {
        "id": "seats",
        "type": "integer",
        "label": "Seats",
        "min": 0,
        "max": 6,
        "value": 2,
    }
    assert Field.decimal("Amount", min="0.01", max=10000, scale=2, value="12.50").to_dict(
        "amount"
    ) == {
        "id": "amount",
        "type": "decimal",
        "label": "Amount",
        "min": 0.01,
        "max": 10000,
        "scale": 2,
        "value": 12.5,
    }
    assert Field.email("Email").to_dict("e") == {"id": "e", "type": "email", "label": "Email"}
    assert Field.url("Site", required=False).to_dict("u")["required"] is False
    assert Field.phone("Phone").to_dict("p")["type"] == "phone"
    assert Field.select("Size", options=options, value="m").to_dict("size") == {
        "id": "size",
        "type": "select",
        "label": "Size",
        "options": options,
        "value": "m",
    }
    assert Field.select("Size", options=[("s", "S"), ("m", "M")]).options == (
        ("s", "S"),
        ("m", "M"),
    )
    assert Field.boolean("I can drive").to_dict("d") == {
        "id": "d",
        "type": "boolean",
        "label": "I can drive",
        "value": False,
    }
    assert Field.boolean("I can drive", value=True).to_dict("d")["value"] is True


def test_a_validation_failure_is_a_value_error_with_a_pointer_like_path() -> None:
    with pytest.raises(ValueError, match=r"^integer\.min: must not exceed max"):
        Field.integer("Seats", min=7, max=6)
    with pytest.raises(ValueError, match=r"^string\.label: must be 1 to 45 characters"):
        Field.string("")
    with pytest.raises(ValueError, match=r"^string\.label"):
        Field.string("x" * 46)


def test_disallowed_properties_cannot_be_passed_to_a_constructor() -> None:
    # The allowed-properties table is carried by each constructor's signature.
    with pytest.raises(TypeError):
        Field.select("Size", options=[("s", "S"), ("m", "M")], placeholder="x")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.boolean("Drive", required=False)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.boolean("Drive", placeholder="x")  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.string("Name", min=1)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.integer("Seats", scale=2)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.integer("Seats", min_length=1)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Field.decimal("Amount", options=[])  # type: ignore[call-arg]


def test_a_raw_dict_is_held_to_the_same_table() -> None:
    from aurival.forms import Form

    def form_with(field: dict[str, object]) -> dict[str, object]:
        return {"title": "T", "fields": [field]}

    for bad, where in (
        ({"id": "a", "type": "select", "label": "L", "placeholder": "x",
          "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]}, "placeholder"),
        ({"id": "a", "type": "boolean", "label": "L", "required": False}, "required"),
        ({"id": "a", "type": "string", "label": "L", "min": 1}, "min"),
        ({"id": "a", "type": "string", "label": "L", "fallback": "string"}, "fallback"),
        ({"id": "a", "type": "short", "label": "L"}, "type"),
    ):
        with pytest.raises(ValueError, match=rf"fields\.a\.{where}"):
            Form.from_dict("f", form_with(bad))


@pytest.mark.parametrize(
    ("build", "needle"),
    [
        (lambda: Field.string("N", max_length=201), "string.max_length"),
        (lambda: Field.string("N", max_length=0), "string.max_length"),
        (lambda: Field.string("N", min_length=101), "string.min_length"),
        (lambda: Field.string("N", min_length=5, max_length=4), "string.min_length"),
        (lambda: Field.paragraph("N", max_length=4001), "paragraph.max_length"),
        (lambda: Field.email("N", max_length=255), "email.max_length"),
        (lambda: Field.url("N", max_length=2049), "url.max_length"),
        (lambda: Field.string("N", placeholder="x" * 101), "string.placeholder"),
        (lambda: Field.string("N", value="x" * 101), "string.value"),
        (lambda: Field.string("N", value=5), "string.value"),  # type: ignore[arg-type]
        (lambda: Field.string("N", min_length=True), "string.min_length"),  # type: ignore[arg-type]
        (lambda: Field.integer("N", min=2**53), "integer.min"),
        (lambda: Field.integer("N", max=-(2**53)), "integer.max"),
        (lambda: Field.integer("N", min=1.5), "integer.min"),  # type: ignore[arg-type]
        (lambda: Field.integer("N", value=True), "integer.value"),
        (lambda: Field.integer("N", min=1, value=0), "integer.value"),
        (lambda: Field.integer("N", min=True), "integer.min"),  # type: ignore[arg-type]
        (lambda: Field.decimal("N", scale=7), "decimal.scale"),
        (lambda: Field.decimal("N", scale=-1), "decimal.scale"),
        (lambda: Field.decimal("N", scale=True), "decimal.scale"),  # type: ignore[arg-type]
        (lambda: Field.decimal("N", min=10**12 + 1), "decimal.min"),
        (lambda: Field.decimal("N", max=Decimal("1e13")), "decimal.max"),
        (lambda: Field.decimal("N", min=2, max=1), "decimal.min"),
        (lambda: Field.decimal("N", value="1.234"), "decimal.value"),
        (lambda: Field.decimal("N", value=Decimal("2.100")), "decimal.value"),
        (lambda: Field.decimal("N", min=0, max=1, value=2), "decimal.value"),
        (lambda: Field.decimal("N", value=True), "decimal.value"),
        (lambda: Field.decimal("N", min=float("nan")), "decimal.min"),
        (lambda: Field.decimal("N", min="abc"), "decimal.min"),
        (lambda: Field.select("N", options=[("a", "A")]), "select.options"),
        (lambda: Field.select("N", options=[(f"o{i}", "O") for i in range(11)]), "select.options"),
        (lambda: Field.select("N", options=[("a", "A"), ("a", "B")]), "unique"),
        (lambda: Field.select("N", options=[("A", "A"), ("b", "B")]), "options[0].value"),
        (lambda: Field.select("N", options=[("a" * 33, "A"), ("b", "B")]), "options[0].value"),
        (lambda: Field.select("N", options=[("a", "x" * 46), ("b", "B")]), "options[0].label"),
        (lambda: Field.select("N", options=[("a", ""), ("b", "B")]), "options[0].label"),
        (lambda: Field.select("N", options=[("a", "A"), ("b", "B")], value="c"), "select.value"),
        (lambda: Field.boolean("N", value="yes"), "boolean.value"),  # type: ignore[arg-type]
    ],
)
def test_the_caps_refuse_with_a_path(build: Any, needle: str) -> None:
    with pytest.raises(ValueError, match=re.escape(needle)):
        build()


def test_the_caps_accept_their_boundaries() -> None:
    Field.string("N", max_length=200, min_length=200)
    Field.paragraph("N", max_length=4000)
    Field.email("N", max_length=254)
    Field.url("N", max_length=2048)
    Field.string("x" * 45, placeholder="x" * 100)
    Field.integer("N", min=-(2**53 - 1), max=2**53 - 1)
    Field.decimal("N", min=-(10**12), max=10**12, scale=0)
    Field.decimal("N", scale=6, value="0.000001")
    Field.decimal("N", scale=2, value=Decimal("12.50"))
    Field.select("N", options=[(f"o{i}", "O") for i in range(10)])
    Field.select("N", options=[("a" * 32, "x" * 45), ("b", "B")])


def test_a_decimal_that_a_json_number_cannot_carry_exactly_is_refused() -> None:
    # 18 significant digits: a double would silently change the bound.
    with pytest.raises(ValueError, match="decimal.max"):
        Field.decimal("N", max="999999999999.999999", scale=6)
    # Within double precision the bound goes out as the number it was.
    assert Field.decimal("N", max="12345.678901", scale=6).to_dict("a")["max"] == 12345.678901


def test_decimal_prefill_places_are_checked_with_decimal_not_float() -> None:
    # 0.1 + 0.2 style traps: the float 2.675 has a long binary expansion but
    # its repr is two places, and that is what the bot wrote.
    Field.decimal("N", value=2.675, scale=3)
    with pytest.raises(ValueError, match="decimal.value"):
        Field.decimal("N", value=2.675, scale=2)


# --- form -----------------------------------------------------------------------


def trip_form(**kw: Any) -> Any:
    return define_form(
        id="trip_signup",
        title="Trip sign-up",
        submit_label="Sign up",
        fields={
            "name": Field.string("Name", min_length=2, max_length=40),
            "seats": Field.integer("Seats you can offer", min=0, max=6, required=False),
            "email": Field.email("Email"),
            "size": Field.select(
                "Shirt size",
                options=[("s", "S"), ("m", "M"), ("l", "L"), ("xl", "XL")],
            ),
            "can_drive": Field.boolean("I can drive", value=False),
        },
        **kw,
    )


def test_a_form_serialises_fields_as_an_ordered_array_with_ids() -> None:
    wire = trip_form().to_dict()
    assert wire["title"] == "Trip sign-up"
    assert wire["submit_label"] == "Sign up"
    assert "submission" not in wire
    fields = wire["fields"]
    assert isinstance(fields, list)
    assert [f["id"] for f in fields] == ["name", "seats", "email", "size", "can_drive"]
    assert fields[1] == {
        "id": "seats",
        "type": "integer",
        "label": "Seats you can offer",
        "min": 0,
        "max": 6,
        "required": False,
    }
    assert fields[4]["value"] is False
    assert "required" not in fields[4]


def test_submission_once_goes_on_the_wire() -> None:
    assert trip_form(submission="once").to_dict()["submission"] == "once"


@pytest.mark.parametrize(
    ("kw", "needle"),
    [
        ({"title": ""}, "title"),
        ({"title": "x" * 46}, "title"),
        ({"submit_label": ""}, "submit_label"),
        ({"submit_label": "x" * 25}, "submit_label"),
        ({"submission": "twice"}, "submission"),
        ({"id": ""}, "id"),
        ({"id": "x" * 33}, "button id is at most 32"),
        ({"fields": {}}, "fields"),
        (
            {"fields": {f"f{i}": Field.string("F") for i in range(6)}},
            "fields",
        ),
        ({"fields": {"Name": Field.string("F")}}, "fields.Name"),
        ({"fields": {"a-b": Field.string("F")}}, "fields.a-b"),
        ({"fields": {"a" * 33: Field.string("F")}}, "fields."),
        ({"fields": {"": Field.string("F")}}, "fields."),
        ({"fields": {"a": "not a field"}}, "fields.a"),
    ],
)
def test_form_level_caps(kw: dict[str, Any], needle: str) -> None:
    base: dict[str, Any] = {
        "id": "f",
        "title": "T",
        "fields": {"a": Field.string("A")},
    }
    base.update(kw)
    with pytest.raises(ValueError, match=needle):
        define_form(**base)


def test_a_form_may_have_five_fields_and_ids_up_to_32() -> None:
    define_form(
        id="f" * 32,
        title="x" * 45,
        fields={("a" * 31) + str(i): Field.string("F") for i in range(5)},
        submit_label="x" * 24,
    )


# --- Button.form ----------------------------------------------------------------


def test_button_form_wire_shape() -> None:
    form = trip_form()
    d = Button.form("Sign up", form, emoji="🥾").to_dict()
    assert d["id"] == "trip_signup"
    assert d["style"] == "form"
    assert d["label"] == "Sign up"
    assert d["emoji"] == "🥾"
    assert d["form"] == form.to_dict()
    assert "url" not in d
    assert "cooldown" not in d


def test_button_form_checks_the_label_and_emoji_caps() -> None:
    with pytest.raises(ValueError, match="24"):
        Button.form("x" * 25, trip_form())
    with pytest.raises(ValueError):
        Button.form("", trip_form())
    with pytest.raises(ValueError, match="emoji"):
        Button.form("Go", trip_form(), emoji="abc")


def test_button_form_takes_no_cooldown_and_no_url() -> None:
    with pytest.raises(TypeError):
        Button.form("Go", trip_form(), cooldown=None)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Button.form("Go", trip_form(), url="https://x.example")  # type: ignore[call-arg]


def test_a_cooldown_set_on_a_form_button_afterwards_is_refused_at_attachment() -> None:
    from aurival.cooldown import Cooldown
    from aurival.embeds import serialise_buttons

    btn = Button.form("Go", trip_form())
    btn.cooldown = Cooldown(1, 2.0, "user")
    with pytest.raises(ValueError, match="form button carries no cooldown"):
        serialise_buttons([btn])


def test_raw_form_button_dicts_are_validated_and_refuse_cooldown_and_url() -> None:
    from aurival.embeds import serialise_buttons

    good = Button.form("Go", trip_form()).to_dict()
    assert serialise_buttons([good]) == [good]
    with pytest.raises(ValueError, match="cooldown"):
        serialise_buttons([{**good, "cooldown": {"retry_after_ms": 1}}])
    with pytest.raises(ValueError, match="only a link button carries a url"):
        serialise_buttons([{**good, "url": "https://x.example"}])
    bad_form = {**good, "form": {"title": "T", "fields": [{"id": "a", "type": "short", "label": "L"}]}}
    with pytest.raises(ValueError, match="fields.a.type"):
        serialise_buttons([bad_form])
    with pytest.raises(ValueError, match="form object"):
        serialise_buttons([{k: v for k, v in good.items() if k != "form"}])


def test_at_most_two_form_buttons_per_message() -> None:
    from aurival.embeds import serialise_buttons

    def one(i: int) -> Button:
        return Button.form(
            f"Form {i}",
            define_form(id=f"form_{i}", title="T", fields={"a": Field.string("A")}),
        )

    assert len(serialise_buttons([one(1), one(2)])) == 2
    assert len(serialise_buttons([one(1), one(2), Button("Plain"), Button.link("L", "https://x.example")])) == 4
    with pytest.raises(ValueError, match="at most 2 form buttons"):
        serialise_buttons([one(1), one(2), one(3)])
    with pytest.raises(ValueError, match="unique"):
        serialise_buttons([one(1), one(1)])


def test_a_message_hydrated_from_the_server_never_fails_on_a_form_it_cannot_parse() -> None:
    from aurival.events import _buttons_from_wire

    wire = {
        "id": "f",
        "style": "form",
        "label": "Update Aurival to answer",
        "form": {
            "label": "Sign up",
            "title": "T",
            "fields": [{"id": "a", "type": "future_type", "label": "A", "fallback": "update"}],
        },
    }
    (btn,) = _buttons_from_wire([wire])
    assert btn.style == "form"
    assert btn.to_dict()["form"] == wire["form"]


# --- accessors ------------------------------------------------------------------


def test_accessors_return_typed_values() -> None:
    v = FormValues(
        {
            "name": "Ana",
            "seats": 2,
            "amount": Decimal("12.50"),
            "whole": Decimal("3"),
            "size": "m",
            "can_drive": True,
            "blank": None,
        }
    )
    assert v.str("name") == "Ana"
    assert v.int("seats") == 2
    assert v.decimal("amount") == Decimal("12.50")
    assert str(v.decimal("amount")) == "12.50"
    assert v.decimal("seats") == Decimal("2")
    assert v.int("whole") == 3
    assert v.choice("size") == "m"
    assert v.bool("can_drive") is True
    assert v.int("blank") is None
    assert v.decimal("blank") is None
    assert v.str("blank") is None
    assert v.choice("blank") is None
    assert v["name"] == "Ana"
    assert v.get("nope", 5) == 5
    assert "name" in v
    assert "nope" not in v
    assert v.keys()[0] == "name"
    assert len(v) == 7


def test_a_bool_is_never_an_int_or_a_decimal() -> None:
    v = FormValues({"flag": True, "off": False})
    for name in ("flag", "off"):
        with pytest.raises(FormValueError):
            v.int(name)
        with pytest.raises(FormValueError):
            v.decimal(name)
        with pytest.raises(FormValueError):
            v.str(name)
    assert v.bool("flag") is True


def test_accessors_refuse_a_mismatch_an_undeclared_field_and_a_null_bool() -> None:
    v = FormValues({"n": 2, "s": "x", "d": Decimal("1.5"), "b": True, "nul": None})
    with pytest.raises(FormValueError):
        v.str("n")
    with pytest.raises(FormValueError):
        v.choice("n")
    with pytest.raises(FormValueError):
        v.int("s")
    with pytest.raises(FormValueError):
        v.int("d")  # 1.5 is not integral
    with pytest.raises(FormValueError):
        v.decimal("s")
    with pytest.raises(FormValueError):
        v.bool("n")
    with pytest.raises(FormValueError):
        v.bool("nul")
    for accessor in (v.int, v.decimal, v.str, v.bool, v.choice):
        with pytest.raises(FormValueError, match="'ghost'"):
            accessor("ghost")
    with pytest.raises(FormValueError):
        v["ghost"]


def test_form_value_error_is_both_an_sdk_error_and_a_value_error() -> None:
    assert issubclass(FormValueError, AurivalError)
    assert issubclass(FormValueError, ValueError)


# --- the gateway decode ---------------------------------------------------------


async def test_a_form_event_arrives_with_typed_values_and_exact_text() -> None:
    ctx = await receive_form(
        {
            "name": '"Ana Ribeiro"',
            "seats": "2",
            "amount": "12.50",
            "whole_amount": "3",
            "size": '"m"',
            "can_drive": "true",
            "receipt": "null",
        }
    )
    assert ctx.interaction == "int_1"
    assert ctx.chat.id == "ch_1"
    assert ctx.message.id == "msg_1"
    assert ctx.button == "trip_signup"
    assert ctx.user.id == "u_1"
    assert ctx.user.handle == "ana"
    assert ctx.submitted_at == "2026-10-08T14:14:03Z"
    assert ctx.values.str("name") == "Ana Ribeiro"
    assert ctx.values.int("seats") == 2
    amount = ctx.values.decimal("amount")
    assert amount == Decimal("12.50")
    assert str(amount) == "12.50"
    assert ctx.values.decimal("whole_amount") == Decimal("3")
    assert ctx.values.choice("size") == "m"
    assert ctx.values.bool("can_drive") is True
    assert ctx.values.str("receipt") is None
    assert ctx.raw_values == {
        "name": '"Ana Ribeiro"',
        "seats": "2",
        "amount": "12.50",
        "whole_amount": "3",
        "size": '"m"',
        "can_drive": "true",
        "receipt": "null",
    }


async def test_raw_values_keep_whitespace_escapes_and_nested_look_alikes_exact() -> None:
    # The text "values" inside a string value, escapes Go writes (<), and
    # whitespace around members must not confuse the capture.
    frame = form_frame(
        {"a": '"x \\"values\\": {} \\u003cb\\u003e"', "b": "1.10"},
    ).replace('"values":{', '"values" : { ', 1)
    (event,) = await receive_events([frame])
    assert event.raw_values == {"a": '"x \\"values\\": {} \\u003cb\\u003e"', "b": "1.10"}
    assert event.data["values"] == {"a": 'x "values": {} <b>', "b": Decimal("1.10")}  # type: ignore[comparison-overlap]


async def test_only_form_events_decode_floats_as_decimal() -> None:
    other = (
        '{"op":"event","d":{"object":"event","id":"evt_o1","type":"member.joined",'
        '"created_at":"2026-10-08T14:14:03Z","sequence":2,'
        '"data":{"ratio":1.5,"chat":{"id":"ch_1"},"user":{"id":"u_1"}}}}'
    )
    form = form_frame({"amount": "2.10"}, event_id="evt_f2")
    events = await receive_events([other, form])
    by_id = {e.id: e for e in events}
    ratio = by_id["evt_o1"].data["ratio"]
    assert isinstance(ratio, float) and ratio == 1.5
    assert by_id["evt_o1"].raw_values is None
    amount = by_id["evt_f2"].data["values"]["amount"]  # type: ignore[index]
    assert isinstance(amount, Decimal) and str(amount) == "2.10"


async def test_an_integral_json_number_reads_as_int_and_a_bool_value_is_refused_by_int() -> None:
    ctx = await receive_form({"n": "3", "d": "3.0", "flag": "true", "big": "9007199254740991"})
    assert ctx.values.int("n") == 3
    assert ctx.values.int("d") == 3
    assert ctx.values.int("big") == 9007199254740991
    with pytest.raises(FormValueError):
        ctx.values.int("flag")


async def test_a_context_built_without_socket_text_reserialises_its_raw_values() -> None:
    event = Event(
        id="evt_f9",
        type="form.submitted",
        created_at="",
        sequence=1,
        data={
            "interaction": "int_9",
            "chat": "ch_1",
            "message": "msg_1",
            "button": "b",
            "user": {"id": "u_1", "username": "ana"},
            "values": {"a": Decimal("12.50"), "b": 3, "c": "é", "d": None, "e": True},
            "submitted_at": "t",
        },
    )
    ctx = context_for(event, http=StubHttp())  # type: ignore[arg-type]
    assert isinstance(ctx, FormContext)
    assert ctx.raw_values == {"a": "12.50", "b": "3", "c": '"é"', "d": "null", "e": "true"}


# --- ack ------------------------------------------------------------------------


async def test_a_form_ack_is_a_plain_ack_text_or_a_card_patch_and_never_a_cooldown() -> None:
    from aurival import Embed

    http = StubHttp()
    (event,) = await receive_events([form_frame({"a": '"x"'})])
    ctx = context_for(event, http=http)  # type: ignore[arg-type]
    assert isinstance(ctx, FormContext)

    await ctx.ack()
    await ctx.ack("Saved")
    await ctx.ack(embeds=[Embed(title="Ridge trail", description="11 of 14 spots taken.")])
    assert [a["interaction"] for a in http.acks] == ["int_1", "int_1", "int_1"]
    assert http.acks[1]["text"] == "Saved"
    assert http.acks[2]["embeds"][0]["title"] == "Ridge trail"
    assert all("cooldown_retry_after_ms" not in a for a in http.acks)

    with pytest.raises(TypeError):
        await ctx.ack(cooldown=None)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        await ctx.ack(cooldown_retry_after_ms=1000)  # type: ignore[call-arg]


async def test_dispatch_runs_a_form_handler_with_no_cooldown_check_and_no_auto_ack() -> None:
    http = StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    seen: list[FormContext] = []

    @bot.on("form.submitted")
    async def handler(ctx: FormContext) -> None:
        seen.append(ctx)

    # Two submissions back to back from one user: a button cooldown (default
    # 1 per 2 s per user) would refuse the second; a form must not be throttled.
    events = await receive_events(
        [form_frame({"a": '"x"'}, event_id="e1"), form_frame({"a": '"y"'}, event_id="e2")]
    )
    for e in events:
        await bot._dispatch(e)
    assert [c.values.str("a") for c in seen] == ["x", "y"]
    assert http.acks == []  # the SDK acks nothing for the developer


async def test_on_form_filters_by_form_id_as_decorator_and_as_direct_call() -> None:
    http = StubHttp()
    bot = Bot()
    bot._http = http  # type: ignore[assignment]
    trip = trip_form()
    other = define_form(id="other_form", title="T", fields={"a": Field.string("A")})
    hits: list[str] = []

    @bot.on_form(trip)
    async def on_trip(ctx: FormContext) -> None:
        hits.append("trip:" + ctx.button)

    async def on_other(ctx: FormContext) -> None:
        hits.append("other:" + ctx.button)

    assert bot.on_form(other, on_other) is on_other
    assert on_trip is not None  # the decorator returns the original handler

    events = await receive_events(
        [
            form_frame({"a": '"x"'}, event_id="e1", button="trip_signup"),
            form_frame({"a": '"x"'}, event_id="e2", button="other_form"),
            form_frame({"a": '"x"'}, event_id="e3", button="unrelated"),
        ]
    )
    for e in events:
        await bot._dispatch(e)
    assert hits == ["trip:trip_signup", "other:other_form"]
    assert bot._has_event_handler("form.submitted")


# --- the README ------------------------------------------------------------------


def _forms_readme_section() -> str:
    import pathlib

    text = (pathlib.Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    start = text.index("\n## Forms\n")
    return text[start : text.index("\n## ", start + 5)]


def test_the_readme_forms_examples_run_and_the_warnings_are_there() -> None:
    import re

    section = _forms_readme_section()
    blocks = re.findall(r"```python\n(.*?)```", section, re.DOTALL)
    assert len(blocks) == 2
    namespace: dict[str, Any] = {}
    builder = "\n".join(ln for ln in blocks[0].splitlines() if not ln.lstrip().startswith("await "))
    exec(compile(builder, "README.md Forms block 0", "exec"), namespace)
    assert namespace["ask"].to_dict()["style"] == "form"
    assert namespace["trip"].id == "trip_signup"
    # The handler block must at least be valid Python that names the real API.
    compile(blocks[1], "README.md Forms block 1", "exec")
    lowered = section.lower()
    assert "a card patch is public to every member" in lowered
    assert "never echo an answer" in lowered
    assert "no cooldown for a form" in lowered
    for name in ("raw_values", "parse_float=Decimal", "FormValueError", "isinstance(True, int)"):
        assert name in section, name
