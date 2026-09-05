"""SDK-33 is architecture, not a feature: this test is the enforcement.

Nothing containing the seed b64, the raw seed bytes, an access token, or a
poll token may reach `str`/`repr`/`format` of `MachineKey`, `Machine`, or
`Auth`; a log record; the pairing stdout printout; or the traceback of a
failed exchange.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import traceback

import pytest
from test_auth import FakeBotAPI, _err, _fixture_machine, _ok, running_http

from aurival import auth, errors


def _secrets_from(key: auth.MachineKey, seed_b64: str) -> list[str]:
    seed_bytes = base64.b64decode(seed_b64)
    return [
        seed_b64,
        seed_bytes.hex(),
        str(seed_bytes),
        repr(seed_bytes),
    ]


def _assert_none_present(haystacks: list[str], secrets: list[str], where: str) -> None:
    joined = "\n".join(haystacks)
    for secret in secrets:
        assert secret not in joined, f"leaked {secret!r} in {where}"


def test_machine_key_str_repr_format_never_leak_the_seed() -> None:
    seed_b64 = base64.b64encode(bytes(range(32))).decode()
    key = auth.MachineKey.from_seed_b64(seed_b64)
    secrets = _secrets_from(key, seed_b64)
    _assert_none_present([str(key), repr(key), format(key)], secrets, "MachineKey str/repr/format")
    # The fingerprint IS meant to be shown — confirm it still appears, so this
    # test cannot pass by having emptied the repr entirely.
    assert key.fingerprint in repr(key)


def test_machine_dataclass_never_holds_the_seed() -> None:
    machine = _fixture_machine()
    seed_b64 = base64.b64encode(bytes(range(32))).decode()
    key = auth.MachineKey.from_seed_b64(seed_b64)
    secrets = _secrets_from(key, seed_b64)
    _assert_none_present([str(machine), repr(machine)], secrets, "Machine str/repr")


async def test_auth_str_repr_never_leak_token_or_seed() -> None:
    seed_b64 = base64.b64encode(bytes(range(32))).decode()
    key = auth.MachineKey.from_seed_b64(seed_b64)
    machine = _fixture_machine()
    fake = FakeBotAPI()
    fake.token_script = [
        lambda body: _ok(
            {"access_token": "attok_super_secret_123", "expires_at": "2099-01-01T00:00:00Z"}
        )
    ]
    async with running_http(fake) as http:
        a = auth.Auth(http, key, machine)
        await a.token()
        secrets = [*_secrets_from(key, seed_b64), "attok_super_secret_123"]
        _assert_none_present([str(a), repr(a)], secrets, "Auth str/repr")


async def test_pairing_and_token_flow_never_logs_secrets(caplog: pytest.LogCaptureFixture) -> None:
    seed_b64 = base64.b64encode(bytes(range(32))).decode()
    fake = FakeBotAPI()
    fake.pair_start_script = [
        lambda body: _err("rate_limit_error", "pair_rate_limited", 429, {"Retry-After": "0"})
    ]
    fake.pair_poll_script = [
        lambda tok: _ok(
            {
                "object": "pairing",
                "state": "approved",
                "expires_at": "2026-01-01T00:00:00Z",
                "access_token": "tok_ignored",
                "bot": "bot_secretflow",
                "machine": "machine_secretflow",
            }
        )
    ]
    out_lines: list[str] = []
    logger = logging.getLogger("aurival")

    with caplog.at_level(logging.DEBUG, logger="aurival"):
        async with running_http(fake) as http:
            key, machine = await asyncio.wait_for(
                auth.pair(
                    http, machine_label="m", host="https://x", out=out_lines.append, logger=logger
                ),
                timeout=5,
            )

            # Now a successful token exchange, followed by a revoked-key failure —
            # both must leave no secret in the log.
            fake.token_script = [
                lambda body: _ok(
                    {
                        "access_token": "attok_from_first_exchange",
                        "expires_at": "2099-01-01T00:00:00Z",
                    }
                )
            ]
            a = auth.Auth(http, key, machine, logger=logger)
            await a.token()

            fake.token_script = [lambda body: _err("authentication_error", "key_revoked", 401)]
            tb_text = ""
            try:
                await a.refresh()
            except errors.KeyRevoked:
                tb_text = traceback.format_exc()

    seed_bytes = base64.b64decode(seed_b64)
    secrets = [
        seed_b64,
        seed_bytes.hex(),
        "attok_from_first_exchange",
        "polltok_default",
        "tok_ignored",
    ]

    log_text = "\n".join(r.getMessage() for r in caplog.records)
    _assert_none_present([log_text], secrets, "caplog across pairing + token exchange + failure")
    _assert_none_present(out_lines, secrets, "pairing stdout printout")
    _assert_none_present([tb_text], secrets, "traceback.format_exc() of the failed exchange")
    assert tb_text != "", "the deliberate failure must actually have raised"
