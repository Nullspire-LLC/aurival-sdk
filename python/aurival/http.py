"""The REST lane. One retry policy lives here (SDK-26/SDK-35/SDK-37) so every
caller — `bot.py`, `Context.reply`, pairing — gets it for free. Nothing from
`aiohttp` escapes: every failure becomes one of `aurival.errors`'s exceptions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import TYPE_CHECKING

import aiohttp

from . import errors

if TYPE_CHECKING:
    from .auth import Auth

DEFAULT_HOST = "https://bots.aurival.com"

# Both the rate-limit lane and the api_error/transport lane are bounded here
# (SDK-26): this many tries total, first attempt included.
_MAX_ATTEMPTS = 5
_DEFAULT_RETRY_AFTER = 1.0


def _decode_object(raw: bytes) -> dict[str, object]:
    """A non-JSON body, or JSON that is not an object, is a `ProtocolError`."""
    try:
        data = json.loads(raw) if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise errors.ProtocolError(f"response body was not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise errors.ProtocolError("response body was not a JSON object")
    return data


def _envelope_body(envelope: dict[str, object]) -> dict[str, object]:
    inner = envelope.get("error")
    return inner if isinstance(inner, dict) else envelope


def _retry_after_seconds(header: str | None, envelope: dict[str, object]) -> float:
    if header is not None:
        try:
            return max(0.0, float(header))
        except ValueError:
            pass
    body = _envelope_body(envelope)
    value = body.get("retry_after")
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    return _DEFAULT_RETRY_AFTER


def _backoff_delay(attempt: int) -> float:
    # attempt is 1-based. Plain exponential, capped — the shape doesn't matter
    # much here since every test injects the sleep; being bounded does.
    return min(0.5 * (2 ** (attempt - 1)), 8.0)


class HttpClient:
    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        auth: Auth | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._session = session
        self._host = host.rstrip("/")
        self._auth = auth
        self._logger = logger or logging.getLogger("aurival")
        # Injectable so a retry/backoff test never actually waits.
        self._sleep = asyncio.sleep

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        headers: dict[str, str] | None = None,
        authenticated: bool = True,
        idempotency_key: str | None = None,
        retry_auth: bool = True,
    ) -> dict:
        """Returns the decoded JSON body. Raises only SDK exceptions."""
        base_headers = dict(headers) if headers else {}
        if idempotency_key is not None:
            # Generated once by the caller and reused verbatim across every
            # retry of this call (SDK-30) — never regenerated per attempt.
            base_headers["Idempotency-Key"] = idempotency_key

        url = self._host + path
        auth_retried = False
        attempt = 0

        while True:
            attempt += 1
            attempt_headers = dict(base_headers)
            if authenticated:
                if self._auth is None:
                    raise errors.AurivalError(
                        "request() needs an authenticated Auth but none was given",
                    )
                token = await self._auth.token()
                attempt_headers["Authorization"] = f"Bearer {token}"

            try:
                async with self._session.request(
                    method, url, json=body, headers=attempt_headers
                ) as resp:
                    status = resp.status
                    raw = await resp.read()
                    retry_after_header = resp.headers.get("Retry-After")
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                if attempt < _MAX_ATTEMPTS:
                    await self._sleep(_backoff_delay(attempt))
                    continue
                raise errors.TransportError(str(exc)) from None

            if status < 400:
                return _decode_object(raw)

            envelope = _decode_object(raw)
            retry_after = _retry_after_seconds(retry_after_header, envelope)
            exc = errors.from_envelope(envelope, status=status, retry_after=retry_after)

            if isinstance(exc, errors.AuthenticationError):
                expired_or_invalid = exc.code in ("access_token_expired", "access_token_invalid")
                if (
                    authenticated
                    and expired_or_invalid
                    and retry_auth
                    and not auth_retried
                    and self._auth is not None
                ):
                    auth_retried = True
                    await self._auth.refresh()
                    continue
                raise exc

            if isinstance(exc, errors.RateLimitError):
                # Only the generic `rate_limited` retries here. `pair_rate_limited`
                # and `sync_rate_limited` are owned by their callers (auth.pair,
                # bot.py's background sync per SDK-35) — retrying them here would
                # make sync_commands swallow SyncRateLimited, which it must not.
                if type(exc) is errors.RateLimited and attempt < _MAX_ATTEMPTS:
                    self._logger.warning("rate limited, retrying after %.1fs", retry_after)
                    await self._sleep(retry_after)
                    continue
                raise exc

            if isinstance(exc, errors.APIError):
                if attempt < _MAX_ATTEMPTS:
                    await self._sleep(_backoff_delay(attempt))
                    continue
                raise exc

            # invalid_request_error, permission_error: never retried.
            raise exc

    async def send_message(self, chat: str, text: str, *, idempotency_key: str) -> dict:
        return await self.request(
            "POST",
            "/v1/messages",
            body={"chat": chat, "text": text},
            idempotency_key=idempotency_key,
        )

    async def sync_commands(self, bot: str, commands: list[dict[str, str]]) -> dict:
        return await self.request(
            "PUT",
            f"/v1/bots/{bot}/commands",
            body={"commands": commands},
            idempotency_key=str(uuid.uuid4()),
        )

    async def list_commands(self, bot: str) -> dict:
        return await self.request("GET", f"/v1/bots/{bot}/commands")

    def gateway_url(self) -> str:
        if self._host.startswith("https://"):
            base = "wss://" + self._host[len("https://") :]
        elif self._host.startswith("http://"):
            base = "ws://" + self._host[len("http://") :]
        else:
            base = self._host
        return base + "/v1/gateway"
