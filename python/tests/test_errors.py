"""Tests for aurival.errors.

The catalogue-coverage test parses the Go source directly (errors_v1.go) rather
than retyping the code list — a hand-written list drifts, per SDK_INTERFACES.md.
"""

from __future__ import annotations

import importlib
import pathlib
import re
import sys
import types

import pytest


def _load_aurival_submodule(name: str):
    """Import `aurival.<name>` without running `aurival/__init__.py`.

    The lead's `__init__.py` pulls in `bot.py`, which pulls in the other
    lanes' modules — those may not exist yet while this lane's tests run.
    Register a bare package stub (just a `__path__`) so normal import
    machinery finds the real submodule file without touching `__init__.py`.
    Safe if a real `aurival` package is already loaded too: this is a no-op
    in that case and the submodule import proceeds as normal.
    """
    if "aurival" not in sys.modules:
        pkg_dir = pathlib.Path(__file__).resolve().parents[1] / "aurival"
        stub = types.ModuleType("aurival")
        stub.__path__ = [str(pkg_dir)]
        sys.modules["aurival"] = stub
    return importlib.import_module(f"aurival.{name}")


errors = _load_aurival_submodule("errors")

GO_ERRORS_FILE = (
    pathlib.Path(__file__).resolve().parents[3]
    / "backend-go"
    / "internal"
    / "botapi"
    / "errors_v1.go"
)


def _go_source() -> str:
    if not GO_ERRORS_FILE.exists():
        # canonical-only pin: the public mirror ships sdk/ alone, so the Go
        # catalogue is not there and this guard has nothing to compare against
        pytest.skip("backend-go/internal/botapi/errors_v1.go is not in this checkout (mirror)", allow_module_level=True)
    return GO_ERRORS_FILE.read_text()


def _parse_type_constants(src: str) -> dict[str, str]:
    """`TypeAuthentication = "authentication_error"` -> {"TypeAuthentication": "..."}"""
    return dict(re.findall(r'\b(Type\w+)\s*=\s*"([a-z_]+)"', src))


def _parse_code_constants(src: str) -> dict[str, str]:
    """`CodeAccessTokenExpired = "access_token_expired"` -> {"CodeAccessTokenExpired": "..."}"""
    return dict(re.findall(r'\b(Code\w+)\s*=\s*"([a-z_]+)"', src))


def _parse_catalogue_types(src: str) -> dict[str, str]:
    """Walk the `errCatalogue` map literal and return {CodeConst: TypeConst}.

    Entries look like `CodeAccessTokenExpired: {TypeAuthentication, 401,` — the
    const names, not the string values, so this test is independent of the
    string spelling used inside errors.py.
    """
    start = src.index("var errCatalogue")
    body = src[start:]
    return dict(re.findall(r"\b(Code\w+):\s*\{\s*(Type\w+)\s*,", body))


def go_catalogue_codes() -> dict[str, str]:
    """{wire code string -> wire type string}, straight off the Go source."""
    src = _go_source()
    type_consts = _parse_type_constants(src)
    code_consts = _parse_code_constants(src)
    catalogue = _parse_catalogue_types(src)
    assert catalogue, "failed to parse errCatalogue out of errors_v1.go — regex is stale"
    out: dict[str, str] = {}
    for code_const, type_const in catalogue.items():
        out[code_consts[code_const]] = type_consts[type_const]
    return out


CATALOGUE = go_catalogue_codes()


def test_go_catalogue_parsed_something_sane():
    # A canary on the parser itself: if this drifts to 0 every other test in
    # this file passes vacuously.
    assert len(CATALOGUE) >= 30
    assert CATALOGUE["access_token_expired"] == "authentication_error"


@pytest.mark.parametrize("code,wire_type", sorted(CATALOGUE.items()))
def test_every_go_catalogue_code_maps_to_a_class(code: str, wire_type: str):
    assert code in errors.CODE_CLASSES, f"{code!r} from the Go catalogue has no CODE_CLASSES entry"
    cls = errors.CODE_CLASSES[code]
    assert issubclass(cls, errors.AurivalAPIError)
    type_cls = errors.TYPE_CLASSES[wire_type]
    assert issubclass(cls, type_cls), (
        f"{cls.__name__} is not a {type_cls.__name__} but the catalogue says "
        f"{code!r} is {wire_type!r}"
    )


def test_too_many_problems_is_now_on_the_wire_and_still_mapped():
    # BA-R23 HAS LANDED. This test used to assert the opposite — that
    # `too_many_problems` was absent from the Go catalogue because BA-R23 was
    # ruled and unimplemented (SDK-39). It is implemented now: errors_v1.go:325
    # carries the row and gateway.go:170 sends it as the graduation bye. The old
    # negative assertion was a stale fact, and a test asserting a fact that has
    # since flipped fails for the right reason exactly once — this is that once.
    #
    # It is read from the GO SOURCE rather than restated here, so the day the
    # code changes again this moves with it instead of encoding today's answer.
    assert "too_many_problems" in CATALOGUE, (
        "the Go catalogue no longer carries `too_many_problems`. If BA-R23 was reverted, "
        "socket.py's BYE_ACTIONS row is now describing a wire that does not exist"
    )
    assert CATALOGUE["too_many_problems"] == "invalid_request_error"
    assert errors.CODE_CLASSES["too_many_problems"] is errors.TooManyProblems
    assert issubclass(errors.TooManyProblems, errors.InvalidRequestError)


def test_from_envelope_known_code_and_type():
    payload = {
        "error": {
            "type": "authentication_error",
            "code": "access_token_expired",
            "message": "Your access token expired 3 minutes ago.",
            "doc_url": "https://bots.aurival.com/docs/errors#access_token_expired",
            "request_id": "req_abc123",
        }
    }
    exc = errors.from_envelope(payload, status=401)
    assert isinstance(exc, errors.AccessTokenExpired)
    assert isinstance(exc, errors.AuthenticationError)
    assert exc.code == "access_token_expired"
    assert exc.type == "authentication_error"
    assert exc.doc_url == "https://bots.aurival.com/docs/errors#access_token_expired"
    assert exc.request_id == "req_abc123"
    assert exc.status == 401
    assert exc.message == "Your access token expired 3 minutes ago."


def test_from_envelope_unknown_code_falls_back_to_type_class():
    payload = {
        "error": {
            "type": "invalid_request_error",
            "code": "some_future_code_not_yet_in_the_sdk",
            "message": "a new code the server started sending",
            "doc_url": "https://bots.aurival.com/docs/errors#some_future_code_not_yet_in_the_sdk",
            "request_id": "req_xyz",
        }
    }
    exc = errors.from_envelope(payload)
    assert type(exc) is errors.InvalidRequestError
    assert exc.code == "some_future_code_not_yet_in_the_sdk"


def test_from_envelope_unknown_type_falls_back_to_base_class():
    payload = {
        "error": {
            "type": "some_future_type",
            "code": "some_future_code",
            "message": "a whole new type",
            "doc_url": "https://bots.aurival.com/docs/errors#some_future_code",
            "request_id": "req_qqq",
        }
    }
    exc = errors.from_envelope(payload)
    assert type(exc) is errors.AurivalAPIError
    assert exc.type == "some_future_type"


def test_from_envelope_never_raises_on_garbage():
    exc = errors.from_envelope({})
    assert isinstance(exc, errors.AurivalAPIError)
    assert exc.code == ""
    exc2 = errors.from_envelope({"error": {"type": 5, "code": None}})
    assert isinstance(exc2, errors.AurivalAPIError)


def test_from_envelope_accepts_bare_inner_object_without_error_wrapper():
    # SDK_INTERFACES.md: "{"error": {...}} or the inner object" — a socket bye
    # frame's `d` happens to already be {"error": {...}}, but be defensive.
    payload = {
        "type": "permission_error",
        "code": "bot_suspended",
        "message": "This bot is suspended.",
        "doc_url": "https://bots.aurival.com/docs/errors#bot_suspended",
        "request_id": None,
    }
    exc = errors.from_envelope(payload)
    assert isinstance(exc, errors.BotSuspended)
    assert exc.request_id is None


def test_every_instance_carries_code_and_doc_url():
    for code, cls in errors.CODE_CLASSES.items():
        exc = cls(type="x", code=code, message="m", doc_url="d", request_id=None)
        assert exc.code == code
        assert exc.doc_url == "d"


def test_permission_denied_error_is_not_the_builtin_permission_error():
    assert errors.PermissionDeniedError is not PermissionError
    assert not issubclass(errors.PermissionDeniedError, PermissionError)
