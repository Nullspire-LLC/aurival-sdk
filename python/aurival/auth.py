"""The key file, first-run pairing, assertion signing, access-token exchange.

SDK-33: the seed lives in exactly one object (`MachineKey`) and never leaves
it — not an attribute anywhere else, not a local in dispatch, not in a log
line or exception message. The only path the b64 seed travels is
`KeyFile.load` -> `MachineKey.from_seed_b64` (decoded immediately) and
`MachineKey._seed_for_save` -> `KeyFile.save` (encoded only at the moment of
writing).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import dataclasses
import hashlib
import ipaddress
import json
import logging
import os
import pathlib
import socket as _socket
import tempfile
import time
import urllib.parse
from collections.abc import Callable
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from . import errors
from .http import DEFAULT_HOST

if TYPE_CHECKING:
    from .http import HttpClient

# Re-exported, not redefined: bot.py compares the resolved host against http's
# copy, and two spellings of one default drift silently.
__all__ = ["DEFAULT_HOST"]

# token.go: AssertionMaxAge. auth owns 60s of refresh headroom ahead of a
# 15-minute access-token TTL (SDK-37).
_ASSERTION_MAX_AGE = 120
_TOKEN_REFRESH_HEADROOM = 60.0
_DEFAULT_PAIR_RETRY_AFTER = 60.0

# Public alias: `Socket`'s proactive-rotation timer (SDK-19) reuses this exact
# headroom rather than defining its own, so the two lanes that race the same
# 15-minute TTL agree on when "about to expire" starts.
TOKEN_REFRESH_HEADROOM = _TOKEN_REFRESH_HEADROOM

# botapi.go:158 — a custom base32 alphabet, no padding. Not base64.b32encode.
_B32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def _b32encode_nopad(data: bytes) -> str:
    bits = 0
    value = 0
    out: list[str] = []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            index = (value >> (bits - 5)) & 0x1F
            out.append(_B32_ALPHABET[index])
            bits -= 5
    if bits > 0:
        out.append(_B32_ALPHABET[(value << (5 - bits)) & 0x1F])
    return "".join(out)


def _fingerprint_of(canonical_b64: str) -> str:
    # botapi.go:206 — hashes the canonical base64 STRING, not the raw bytes.
    digest = hashlib.sha256(canonical_b64.encode("ascii")).digest()
    s = _b32encode_nopad(digest)[:8]
    return (s[:4] + "-" + s[4:]).upper()


def _b64url_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _parse_rfc3339(s: str) -> float:
    # time.RFC3339 in Go always has a "Z" or numeric offset, never a bare
    # local time; datetime.fromisoformat wants "+00:00", not "Z" (py3.10).
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).timestamp()


class MachineKey:
    """The ONLY object that holds the seed (SDK-33)."""

    __slots__ = ("_private_key",)

    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._private_key = private_key

    @classmethod
    def generate(cls) -> MachineKey:
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def from_seed_b64(cls, seed_b64: str) -> MachineKey:
        seed = base64.b64decode(seed_b64)
        return cls(Ed25519PrivateKey.from_private_bytes(seed))

    def sign(self, payload: bytes) -> bytes:
        return self._private_key.sign(payload)

    @property
    def public_key_b64(self) -> str:
        pub: Ed25519PublicKey = self._private_key.public_key()
        raw = pub.public_bytes(Encoding.Raw, PublicFormat.Raw)
        return base64.b64encode(raw).decode("ascii")

    @property
    def fingerprint(self) -> str:
        return _fingerprint_of(self.public_key_b64)

    def _seed_b64_for_save(self) -> str:
        """The seed's one legitimate exit. Called ONLY by `KeyFile.save`."""
        raw = self._private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        return base64.b64encode(raw).decode("ascii")

    def __repr__(self) -> str:
        return f"<MachineKey fingerprint={self.fingerprint}>"

    __str__ = __repr__


@dataclasses.dataclass(frozen=True)
class Machine:
    """machine.json minus the seed. Safe to log."""

    bot: str
    machine: str
    host: str
    created: str


class KeyFile:
    def __init__(self, path: pathlib.Path | None = None) -> None:
        if path is not None:
            self.path = path
            self.is_default = False
        else:
            override = os.environ.get("AURIVAL_KEY_PATH")
            if override:
                self.path = pathlib.Path(override)
                self.is_default = False
            else:
                self.path = self.default_path()
                self.is_default = True

    @staticmethod
    def default_path() -> pathlib.Path:
        return pathlib.Path(".aurival") / "machine.json"

    def load(self) -> tuple[MachineKey, Machine] | None:
        if not self.path.exists():
            return None
        with self.path.open("r", encoding="utf-8") as f:
            doc = json.load(f)
        key = MachineKey.from_seed_b64(doc["seed"])
        machine = Machine(
            bot=doc["bot"], machine=doc["machine"], host=doc["host"], created=doc["created"]
        )
        return key, machine

    def save(self, key: MachineKey, machine: Machine) -> None:
        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)

        doc = {
            "seed": key._seed_b64_for_save(),
            "bot": machine.bot,
            "machine": machine.machine,
            "host": machine.host,
            "created": machine.created,
        }
        fd, tmp_name = tempfile.mkstemp(dir=directory, prefix=".machine-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            os.chmod(tmp_name, 0o600)
            os.replace(tmp_name, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp_name)
            raise

        if self.is_default:
            gitignore = directory / ".gitignore"
            gitignore.write_text("*\n", encoding="utf-8")


class Auth:
    def __init__(
        self,
        http: HttpClient,
        key: MachineKey,
        machine: Machine,
        logger: logging.Logger | None = None,
    ) -> None:
        self._http = http
        self._key = key
        self._machine_id = machine.machine
        self.bot = machine.bot
        self._logger = logger or logging.getLogger("aurival")
        self._token: str | None = None
        self._expires_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def expires_at(self) -> float | None:
        """Epoch seconds the held token expires at, or `None` before the
        first exchange. Read-only seam for `Socket`'s rotation timer."""
        return self._expires_at

    def _fresh(self) -> bool:
        return (
            self._token is not None
            and self._expires_at is not None
            and time.time() < self._expires_at - _TOKEN_REFRESH_HEADROOM
        )

    async def token(self) -> str:
        """The current access token, minting one only if we have no fresh one.

        THE RE-CHECK INSIDE THE LOCK IS THE POINT. Handlers run concurrently and
        every one of them reaches this through `ctx.reply`, so N callers arrive
        together the moment a token goes stale. Without it each waiter takes the
        lock in turn and performs its own exchange: N assertions, N `/v1/token`
        round trips, and N-1 tokens thrown away — a self-inflicted burst against
        the endpoint whose rate limit would take the bot offline.
        """
        if self._fresh():
            assert self._token is not None
            return self._token
        async with self._lock:
            # The first waiter minted one while we queued. Reuse it.
            if self._fresh():
                assert self._token is not None
                return self._token
            return await self._exchange()

    async def refresh(self) -> str:
        """Force a new exchange, whatever we currently hold.

        DELIBERATELY NOT FRESHNESS-CHECKED, and it is not the same function as
        `token()`. Its one caller is the HTTP 401 path (SDK-37): the server has
        just REJECTED the token we hold, so "it still looks fresh by our clock"
        is precisely the wrong answer — clock skew or a server-side rotation
        both produce it, and returning the rejected token would burn the single
        permitted retry and raise on a request that a real refresh would have
        completed.
        """
        async with self._lock:
            return await self._exchange()

    async def _exchange(self) -> str:
        """One assertion, one `/v1/token`. Callers hold the lock."""
        assertion = self.build_assertion()
        resp = await self._http.request(
            "POST",
            "/v1/token",
            body={"assertion": assertion},
            authenticated=False,
        )
        token = resp["access_token"]
        if not isinstance(token, str):
            raise errors.ProtocolError("token response missing access_token")
        self._token = token
        self._expires_at = _parse_rfc3339(str(resp["expires_at"]))
        self._logger.debug("access token refreshed")
        return self._token

    def build_assertion(self, *, now: float | None = None) -> str:
        iat = int(now if now is not None else time.time())
        exp = iat + _ASSERTION_MAX_AGE
        nonce = _b64url_nopad(os.urandom(16))
        payload = {
            "key_id": self._machine_id,
            "bot_id": self.bot,
            "iat": iat,
            "exp": exp,
            "nonce": nonce,
        }
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
        sig = self._key.sign(raw)
        return f"{_b64url_nopad(raw)}.{_b64url_nopad(sig)}"


def machine_label() -> str:
    # pairing.go:64 falls back on the server side past 64 chars anyway; we
    # truncate up front so the sent label and the signed label always match.
    return _socket.gethostname()[:64]


# Captured here so `pair`'s `machine_label` parameter can shadow the name
# without losing the default implementation.
_default_machine_label = machine_label


def _is_loopback_hostname(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def resolve_host() -> str:
    host = os.environ.get("AURIVAL_API")
    if not host:
        return DEFAULT_HOST
    parsed = urllib.parse.urlsplit(host)
    hostname = parsed.hostname or ""
    if parsed.scheme != "https" and not _is_loopback_hostname(hostname):
        # An SDK exception, never a bare ValueError. The README promises one
        # `except AurivalError` catches everything this library raises, and a
        # builtin leaking out of the very first call in `run()` breaks that
        # promise at the least convenient moment.
        raise errors.AurivalError(
            f"AURIVAL_API must be https:// unless the host is loopback, got {host!r}"
        )
    return host


async def pair(
    http: HttpClient,
    *,
    machine_label: str | None = None,
    host: str,
    out: Callable[[str], None] = print,
    logger: logging.Logger | None = None,
) -> tuple[MachineKey, Machine]:
    log = logger or logging.getLogger("aurival")
    label = machine_label if machine_label is not None else _default_machine_label()
    key = MachineKey.generate()

    while True:
        iat = int(time.time())
        proof = key.sign(f"pair-start:{label}:{iat}".encode())
        try:
            start = await http.request(
                "POST",
                "/v1/pair/start",
                authenticated=False,
                body={
                    "machine_label": label,
                    "public_key": key.public_key_b64,
                    "proof": base64.b64encode(proof).decode("ascii"),
                    "iat": iat,
                },
            )
        except errors.PairRateLimited as exc:
            wait = exc.retry_after if exc.retry_after is not None else _DEFAULT_PAIR_RETRY_AFTER
            log.info("pairing rate limited, waiting %.0fs", wait)
            await asyncio.sleep(wait)
            continue

        user_code = str(start["user_code"])
        fingerprint = str(start["fingerprint"])
        poll_token = str(start["poll_token"])
        interval_s = float(start["interval_ms"]) / 1000.0

        # Directly to stdout, never the logger (SDK-31) — a dev with the
        # logger at WARNING must still see this. The lead's e2e matches these
        # two lines verbatim: `r"pairing code\s+([0-9A-Z]{4}-[0-9A-Z]{4})"`.
        out(f"aurival: pairing code    {user_code}")
        out(f"aurival: fingerprint     {fingerprint}")
        out("Compare the fingerprint in the app, then approve. Waiting...")

        machine, expired = await _poll_until_settled(http, poll_token, interval_s, host)
        if machine is not None:
            return key, machine
        assert expired
        log.info("pairing code expired, starting a new one")
        out("That code expired. Here is a new one:")
        # SDK-36: unbounded restart, one new code per restart. Loop again.


async def _poll_until_settled(
    http: HttpClient, poll_token: str, interval_s: float, host: str
) -> tuple[Machine | None, bool]:
    """Returns (machine, expired). Exactly one of the two paths is non-empty:
    a `Machine` on approval, or `expired=True` telling `pair` to restart.
    """
    headers = {"Authorization": f"Bearer {poll_token}"}
    while True:
        await asyncio.sleep(interval_s)
        try:
            resp = await http.request("POST", "/v1/pair/poll", authenticated=False, headers=headers)
        except errors.PairRateLimited as exc:
            wait = exc.retry_after if exc.retry_after is not None else _DEFAULT_PAIR_RETRY_AFTER
            await asyncio.sleep(wait)
            continue

        state = resp["state"]
        if state == "pending":
            continue
        if state == "expired":
            return None, True
        if state == "approved":
            machine = Machine(
                bot=str(resp["bot"]),
                machine=str(resp["machine"]),
                host=host,
                created=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            )
            return machine, False
        raise errors.ProtocolError(f"unknown pairing state: {state!r}")
