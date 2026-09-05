"""Tests for `aurival.auth`.

Two fixed vectors are pinned against the real Go source (never against this
module's own math): a public key + fingerprint from `botapi.Fingerprint`, and
a signed assertion verified with `ed25519.Verify` the way `ExchangeAssertion`
does. See the report for how each was produced.

The pairing and token flows run against a REAL aiohttp server (`FakeBotAPI`
below), shaped from `pairing.go` / `server.go` / `token.go`, not a mock.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from aurival import auth, errors
from aurival.http import HttpClient

# --- fixed vectors, produced by running Go, not by this module -------------
#
# `go run ./cmd/pgsdk-throwaway` (deleted after use) against
# backend-go/internal/botapi.Fingerprint and crypto/ed25519, seed = bytes
# 0..31:
#
#   public_key_b64: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
#   fingerprint:    ZXST-0S3V
#   assertion_json: {"key_id":"machine_test123","bot_id":"bot_test456",
#                    "iat":1000000000,"exp":1000000120,
#                    "nonce":"fixedNonceValue1"}
#   assertion_wire: <GO_ASSERTION_WIRE below>
#
# The wire form was then independently re-verified with a second throwaway
# Go program doing exactly what ExchangeAssertion's signature/age check does
# (ed25519.Verify over the raw JSON bytes, exp-iat <= AssertionMaxAge):
# signature_valid: true, exp_minus_iat: 120, age_within_max: true.

GO_SEED = bytes(range(32))
GO_SEED_B64 = base64.b64encode(GO_SEED).decode()
GO_PUBKEY_B64 = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
GO_FINGERPRINT = "ZXST-0S3V"
GO_ASSERTION_JSON = (
    b'{"key_id":"machine_test123","bot_id":"bot_test456",'
    b'"iat":1000000000,"exp":1000000120,"nonce":"fixedNonceValue1"}'
)
GO_ASSERTION_WIRE = (
    "eyJrZXlfaWQiOiJtYWNoaW5lX3Rlc3QxMjMiLCJib3RfaWQiOiJib3RfdGVzdDQ1NiIs"
    "ImlhdCI6MTAwMDAwMDAwMCwiZXhwIjoxMDAwMDAwMTIwLCJub25jZSI6ImZpeGVkTm9u"
    "Y2VWYWx1ZTEifQ.aPuCuXFQ6YWQK9vmDN4qb4CXpAHq1oI44I_dzbWqDCcPBTHqR9pp"
    "pRvxuFoKtyjMUrCyKZloI7C9FLhBvEtgBA"
)


def test_fingerprint_matches_go_fixed_vector() -> None:
    key = auth.MachineKey.from_seed_b64(GO_SEED_B64)
    assert key.public_key_b64 == GO_PUBKEY_B64
    assert key.fingerprint == GO_FINGERPRINT


def test_assertion_signature_matches_go_fixed_vector() -> None:
    key = auth.MachineKey.from_seed_b64(GO_SEED_B64)
    sig = key.sign(GO_ASSERTION_JSON)
    wire = auth._b64url_nopad(GO_ASSERTION_JSON) + "." + auth._b64url_nopad(sig)
    assert wire == GO_ASSERTION_WIRE


def test_build_assertion_shape_and_signature() -> None:
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_abc", machine="machine_xyz", host="https://x", created="2026-01-01T00:00:00Z"
    )
    a = auth.Auth(http=None, key=key, machine=machine)  # type: ignore[arg-type]
    wire = a.build_assertion(now=1_700_000_000.0)
    raw_b64, sig_b64 = wire.split(".")
    raw = _b64url_decode(raw_b64)
    sig = _b64url_decode(sig_b64)
    payload = json.loads(raw)
    assert payload["key_id"] == "machine_xyz"
    assert payload["bot_id"] == "bot_abc"
    assert payload["iat"] == 1_700_000_000
    assert payload["exp"] - payload["iat"] == 120
    nonce_bytes = _b64url_decode(payload["nonce"])
    assert len(nonce_bytes) == 16
    Ed25519PublicKey.from_public_bytes(base64.b64decode(key.public_key_b64)).verify(sig, raw)


def test_build_assertion_nonce_is_random() -> None:
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_abc", machine="machine_xyz", host="https://x", created="2026-01-01T00:00:00Z"
    )
    a = auth.Auth(http=None, key=key, machine=machine)  # type: ignore[arg-type]
    w1 = a.build_assertion(now=1.0)
    w2 = a.build_assertion(now=1.0)
    assert w1 != w2


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _fixture_machine() -> auth.Machine:
    return auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )


# ---------------------------------------------------------------------------
# a real in-process server, shaped from pairing.go / server.go / token.go
# ---------------------------------------------------------------------------


def _error_envelope(error_type: str, code: str, message: str = "test error") -> dict:
    return {
        "error": {
            "type": error_type,
            "code": code,
            "message": message,
            "doc_url": f"https://bots.aurival.com/docs/errors#{code}",
            "request_id": "req_test",
        }
    }


class FakeBotAPI:
    """A tiny stand-in for bot-api's pairing/token endpoints. Verifies the
    pairing proof exactly like `pairing.go` does, so a client that signs the
    wrong bytes fails here exactly as it would against the real service.

    Each route is driven by a "script" — a queue of callables the test can
    push canned responses onto — falling back to a plain default.
    """

    def __init__(self) -> None:
        self.pair_start_script: list[Callable[[dict], tuple[int, dict, dict]]] = []
        self.pair_poll_script: list[Callable[[str], tuple[int, dict, dict]]] = []
        self.token_script: list[Callable[[dict], tuple[int, dict, dict]]] = []
        self.pair_start_calls: list[dict] = []
        self.pair_poll_calls: list[str] = []
        self.token_calls: list[dict] = []
        self.app = web.Application()
        self.app.router.add_post("/v1/pair/start", self._pair_start)
        self.app.router.add_post("/v1/pair/poll", self._pair_poll)
        self.app.router.add_post("/v1/token", self._token)

    async def _pair_start(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.pair_start_calls.append(body)
        if self.pair_start_script:
            status, payload, headers = self.pair_start_script.pop(0)(body)
            return web.json_response(payload, status=status, headers=headers)
        pub = base64.b64decode(body["public_key"])
        # pairing.go:41-63 — verify against the label AS SENT, no fallback.
        msg = f"pair-start:{body.get('machine_label', '')}:{body['iat']}".encode()
        sig = base64.b64decode(body["proof"])
        try:
            Ed25519PublicKey.from_public_bytes(pub).verify(sig, msg)
        except InvalidSignature:
            return web.json_response(
                _error_envelope("authentication_error", "bad_proof"), status=401
            )
        return web.json_response(
            {
                "user_code": "TEST-0001",
                "fingerprint": "TEST-FING",
                "poll_token": "polltok_default",
                "expires_at": "2026-01-01T00:00:00Z",
                "interval_ms": 5,
            },
            status=201,
        )

    async def _pair_poll(self, request: web.Request) -> web.Response:
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        self.pair_poll_calls.append(token)
        if self.pair_poll_script:
            status, payload, headers = self.pair_poll_script.pop(0)(token)
            return web.json_response(payload, status=status, headers=headers)
        return web.json_response(
            {
                "object": "pairing",
                "state": "pending",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": None,
                "bot": None,
                "machine": None,
            }
        )

    async def _token(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.token_calls.append(body)
        if self.token_script:
            status, payload, headers = self.token_script.pop(0)(body)
            return web.json_response(payload, status=status, headers=headers)
        return web.json_response(_error_envelope("api_error", "internal_error"), status=500)


@asynccontextmanager
async def running_http(fake: FakeBotAPI):
    server = TestServer(fake.app)
    await server.start_server()
    session = aiohttp.ClientSession()
    http = HttpClient(session, str(server.make_url("")))
    try:
        yield http
    finally:
        await session.close()
        await server.close()


def _ok(payload: dict, status: int = 200, headers: dict | None = None) -> tuple[int, dict, dict]:
    return status, payload, headers or {}


def _err(
    error_type: str, code: str, status: int, headers: dict | None = None
) -> tuple[int, dict, dict]:
    return status, _error_envelope(error_type, code), headers or {}


# ---------------------------------------------------------------------------
# pairing
# ---------------------------------------------------------------------------


async def test_pairing_happy_path_returns_key_and_machine() -> None:
    fake = FakeBotAPI()
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "pending",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": None,
                "bot": None,
                "machine": None,
            }
        ),
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "attok_from_pairing",
                "bot": "bot_won123",
                "machine": "machine_won456",
            }
        ),
    ]
    lines: list[str] = []
    async with running_http(fake) as http:
        key, machine = await asyncio.wait_for(
            auth.pair(http, machine_label="test-machine", host="https://x", out=lines.append),
            timeout=5,
        )
    assert machine.bot == "bot_won123"
    assert machine.machine == "machine_won456"
    assert any("TEST-0001" in line for line in lines)
    assert any("TEST-FING" in line for line in lines)
    assert isinstance(key, auth.MachineKey)


async def test_pairing_signs_the_label_actually_sent() -> None:
    """pairing.go verifies the proof against the label AS RECEIVED, before its
    own "" -> "unnamed machine" fallback runs. A client that signed the
    fallback value instead of the empty string it sent would fail here.
    """
    fake = FakeBotAPI()
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "tok",
                "bot": "bot_a",
                "machine": "machine_b",
            }
        )
    ]
    async with running_http(fake) as http:
        _key, machine = await asyncio.wait_for(
            auth.pair(http, machine_label="", host="https://x", out=lambda _s: None),
            timeout=5,
        )
    assert fake.pair_start_calls[0]["machine_label"] == ""
    assert machine.bot == "bot_a"


async def test_pairing_prints_to_stdout_not_logger(caplog: pytest.LogCaptureFixture) -> None:
    fake = FakeBotAPI()
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "tok",
                "bot": "bot_a",
                "machine": "machine_b",
            }
        )
    ]
    lines: list[str] = []
    logger = logging.getLogger("aurival")
    with caplog.at_level(logging.WARNING, logger="aurival"):
        async with running_http(fake) as http:
            await asyncio.wait_for(
                auth.pair(
                    http, machine_label="m", host="https://x", out=lines.append, logger=logger
                ),
                timeout=5,
            )
    joined_out = "\n".join(lines)
    assert "TEST-0001" in joined_out
    assert "TEST-FING" in joined_out
    joined_logs = "\n".join(r.getMessage() for r in caplog.records)
    assert "TEST-0001" not in joined_logs
    assert "TEST-FING" not in joined_logs


async def test_pairing_rate_limited_sleeps_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeBotAPI()
    fake.pair_start_script = [
        lambda body: _err("rate_limit_error", "pair_rate_limited", 429, {"Retry-After": "7"})
    ]
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "tok",
                "bot": "bot_a",
                "machine": "machine_b",
            }
        )
    ]
    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        await real_sleep(0)

    monkeypatch.setattr(auth.asyncio, "sleep", fake_sleep)

    async with running_http(fake) as http:
        await asyncio.wait_for(
            auth.pair(http, machine_label="m", host="https://x", out=lambda _s: None),
            timeout=5,
        )
    assert 7.0 in sleeps


async def test_pairing_expired_restarts_with_a_new_code() -> None:
    fake = FakeBotAPI()
    starts = {"n": 0}

    def start_responder(body: dict) -> tuple[int, dict, dict]:
        starts["n"] += 1
        code = "TEST-000" + str(starts["n"])
        return _ok(
            {
                "user_code": code,
                "fingerprint": "TEST-FING",
                "poll_token": f"polltok-{starts['n']}",
                "expires_at": "2026-01-01T00:00:00Z",
                "interval_ms": 5,
            },
            status=201,
        )

    fake.pair_start_script = [start_responder, start_responder]
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "expired",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": None,
                "bot": None,
                "machine": None,
            }
        ),
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "tok",
                "bot": "bot_a",
                "machine": "machine_b",
            }
        ),
    ]
    lines: list[str] = []
    async with running_http(fake) as http:
        _key, machine = await asyncio.wait_for(
            auth.pair(http, machine_label="m", host="https://x", out=lines.append),
            timeout=5,
        )
    assert machine.bot == "bot_a"
    joined = "\n".join(lines)
    assert "TEST-0001" in joined
    assert "TEST-0002" in joined
    assert starts["n"] == 2


# ---------------------------------------------------------------------------
# token exchange / caching
# ---------------------------------------------------------------------------


def _rfc3339(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


async def test_token_caches_and_refreshes_ahead_of_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeBotAPI()
    now = 1_800_000_000.0
    monkeypatch.setattr(auth.time, "time", lambda: now)

    call_count = {"n": 0}

    def token_responder(body: dict) -> tuple[int, dict, dict]:
        call_count["n"] += 1
        return _ok({"access_token": f"attok_{call_count['n']}", "expires_at": _rfc3339(now + 900)})

    fake.token_script = [token_responder, token_responder]

    key = auth.MachineKey.generate()
    machine = _fixture_machine()

    async with running_http(fake) as http:
        a = auth.Auth(http, key, machine)
        t1 = await a.token()
        t2 = await a.token()  # still fresh: no second call
        assert t1 == t2 == "attok_1"
        assert call_count["n"] == 1

        # jump past expires_at - headroom (900 - 60 = 840s from now)
        now += 850
        t3 = await a.token()
        assert t3 == "attok_2"
        assert call_count["n"] == 2


async def test_refresh_always_forces_a_new_exchange() -> None:
    fake = FakeBotAPI()
    call_count = {"n": 0}

    def token_responder(body: dict) -> tuple[int, dict, dict]:
        call_count["n"] += 1
        return _ok(
            {"access_token": f"attok_{call_count['n']}", "expires_at": _rfc3339(time.time() + 900)}
        )

    fake.token_script = [token_responder, token_responder]
    key = auth.MachineKey.generate()
    machine = _fixture_machine()

    async with running_http(fake) as http:
        a = auth.Auth(http, key, machine)
        first = await a.refresh()
        second = await a.refresh()  # forced, even though `first` is still fresh
    assert first == "attok_1"
    assert second == "attok_2"
    assert call_count["n"] == 2


async def test_token_exchange_key_revoked_raises_and_does_not_swallow() -> None:
    fake = FakeBotAPI()
    fake.token_script = [lambda body: _err("authentication_error", "key_revoked", 401)]
    key = auth.MachineKey.generate()
    machine = _fixture_machine()
    async with running_http(fake) as http:
        a = auth.Auth(http, key, machine)
        with pytest.raises(errors.KeyRevoked):
            await a.refresh()


# ---------------------------------------------------------------------------
# resolve_host / machine_label
# ---------------------------------------------------------------------------


def test_resolve_host_default_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AURIVAL_API", raising=False)
    assert auth.resolve_host() == auth.DEFAULT_HOST


def test_resolve_host_rejects_non_https_non_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AURIVAL_API", "http://example.com:80")
    # AurivalError, not a bare ValueError. The README promises one
    # `except AurivalError` catches everything this library raises, and this is
    # the first call `run()` makes — a builtin escaping here breaks the promise
    # before the developer's code has done anything at all.
    with pytest.raises(errors.AurivalError):
        auth.resolve_host()
    # And it must not merely be *a* builtin that happens to subclass nothing:
    # assert the specific hierarchy, or `AurivalError` could be re-pointed at
    # ValueError one day and this test would still pass.
    assert not issubclass(errors.AurivalError, ValueError)


def test_resolve_host_accepts_loopback_with_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AURIVAL_API", "http://127.0.0.1:54321")
    assert auth.resolve_host() == "http://127.0.0.1:54321"


def test_resolve_host_accepts_localhost_with_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AURIVAL_API", "http://localhost:9000")
    assert auth.resolve_host() == "http://localhost:9000"


def test_resolve_host_accepts_https_non_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AURIVAL_API", "https://staging.bots.aurival.com")
    assert auth.resolve_host() == "https://staging.bots.aurival.com"


def test_machine_label_truncated_to_64(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth._socket, "gethostname", lambda: "x" * 100)
    assert len(auth.machine_label()) == 64
