"""Parity between the JS and Python form suites.

Both SDKs run the same shared vectors, `sdk/testdata/form_vectors.json`. This test pins that the
two suites really load that one file (not private copies), that the file has not been truncated,
and, inside the Aurival monorepo, that it is byte-equal to the server's canonical copy.
"""

from __future__ import annotations

import json
from pathlib import Path

SDK = Path(__file__).resolve().parents[2]
VECTORS = SDK / "testdata" / "form_vectors.json"
JS_SUITE = SDK / "js" / "test" / "forms.vectors.test.ts"
PY_SUITE = SDK / "python" / "tests" / "test_forms_vectors.py"
CANONICAL = SDK.parent / "backend-go" / "internal" / "botapi" / "testdata" / "form_vectors.json"

EXPECTED_FIELD_ROWS = 63
EXPECTED_FORM_ROWS = 2


def test_vectors_file_is_whole() -> None:
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    field_ids = [row["id"] for row in data["fields"]]
    form_ids = [row["id"] for row in data["forms"]]
    assert len(field_ids) == EXPECTED_FIELD_ROWS
    assert len(form_ids) == EXPECTED_FORM_ROWS
    assert len(set(field_ids + form_ids)) == EXPECTED_FIELD_ROWS + EXPECTED_FORM_ROWS


def test_both_suites_exist_and_load_the_one_shared_file() -> None:
    for suite in (JS_SUITE, PY_SUITE):
        assert suite.is_file(), f"missing suite {suite}"
        source = suite.read_text(encoding="utf-8")
        assert "form_vectors.json" in source, f"{suite.name} does not load form_vectors.json"
        assert "testdata" in source, f"{suite.name} does not read from the shared testdata dir"
    # A private copy of the vectors next to either suite would defeat the parity.
    stray = [
        p
        for p in (SDK / "js").rglob("form_vectors*.json")
        if "node_modules" not in p.parts
    ] + list((SDK / "python").rglob("form_vectors*.json"))
    assert stray == []


def test_both_suites_pin_the_same_row_counts() -> None:
    for suite in (JS_SUITE, PY_SUITE):
        source = suite.read_text(encoding="utf-8")
        assert str(EXPECTED_FIELD_ROWS) in source, f"{suite.name} must pin {EXPECTED_FIELD_ROWS} field rows"
        assert str(EXPECTED_FORM_ROWS) in source, f"{suite.name} must pin {EXPECTED_FORM_ROWS} form rows"


def test_matches_server_canonical_copy_when_in_the_monorepo() -> None:
    if not CANONICAL.is_file():
        # The public mirror has no backend-go; the monorepo-side Go parity test covers it there.
        return
    assert VECTORS.read_bytes() == CANONICAL.read_bytes()
