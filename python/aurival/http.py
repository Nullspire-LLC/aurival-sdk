"""The REST lane. One retry policy lives here (SDK-26/SDK-35/SDK-37) so every
caller — `bot.py`, `Context.reply`, pairing — gets it for free. Nothing from
`aiohttp` escapes: every failure becomes one of `aurival.errors`'s exceptions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.parse
import uuid
from typing import TYPE_CHECKING

import aiohttp

from . import errors
from .cooldown import CooldownTable

if TYPE_CHECKING:
    from .auth import Auth

DEFAULT_HOST = "https://bots.aurival.com"

_AURIVAL_DEBUG_ENV = "AURIVAL_DEBUG"


class Omitted:
    """The third state a card part on an edit or an ack can be in.

    AMENDMENT-07 §9 gives `embeds`/`buttons` three meanings and `None` is
    already spent on two of them: absent from the request body, and the JSON
    `null` that clears the part. `send_message`'s `if embeds:` shortcut cannot
    express that — it folds "clear" into "absent" — so the body builders below
    test against this sentinel instead, and a real `None` reaches the wire as
    `null`.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "OMITTED"


OMITTED = Omitted()


def _card_body(
    text: str | None,
    embeds: list[dict[str, object]] | Omitted | None,
    buttons: list[dict[str, object]] | Omitted | None,
) -> dict[str, object]:
    """The shared body builder for the two routes that take card parts.

    A key is written when its part is present, and only then: `text=None` is
    absent (AMENDMENT-07 §2 makes `text` unclearable, so `None` has only the
    one meaning there) while `text=""` is a real, legal value on both routes.
    `embeds`/`buttons` write `null` on a real `None` and are left out only on
    `OMITTED`.
    """
    body: dict[str, object] = {}
    if text is not None:
        body["text"] = text
    if not isinstance(embeds, Omitted):
        body["embeds"] = embeds
    if not isinstance(buttons, Omitted):
        body["buttons"] = buttons
    return body


def _default_logger() -> logging.Logger:
    """The "aurival" logger, built once at import time. Left alone, an
    unconfigured Python logger already sends WARNING+ to stderr via the
    logging module's last-resort handler — the only thing missing is
    debug/info visibility, which `AURIVAL_DEBUG=1` turns on here (mirrors
    `sdk/js/src/http.ts`'s `defaultLogger()`, same env var name, so it means
    the same thing in both SDKs). Never touches a `Bot(logger=...)` a caller
    supplied explicitly — this only shapes the shared default instance.
    """
    logger = logging.getLogger("aurival")
    if os.environ.get(_AURIVAL_DEBUG_ENV) == "1" and not logger.handlers:
        logger.setLevel(logging.DEBUG)
        handler = logging.StreamHandler()
        handler.setLevel(logging.DEBUG)
        logger.addHandler(handler)
    return logger


_log = _default_logger()

# Both the rate-limit lane and the api_error/transport lane are bounded here
# (SDK-26): this many tries total, first attempt included.
_MAX_ATTEMPTS = 5
_DEFAULT_RETRY_AFTER = 1.0
# A `retry_after` longer than this is not a transient the request should wait
# out (SDK-40). The generic rate limit is retried INSIDE whatever awaited the
# request, which for a reply is the command handler, and the handler holds the
# event's ack open for as long as it runs. A server once answered 600 s; the
# bot then slept ten minutes per command, every unacked event was redelivered
# every 30 s behind it, and the whole chat looked dead. Past this bound the
# error is raised at once and the handler decides.
_MAX_RETRY_AFTER_S = 15.0


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
        self._logger = logger or _log
        # Injectable so a retry/backoff test never actually waits.
        self._sleep = asyncio.sleep
        # AMENDMENT-08 §3: the process-memory table `send()`/`reply()`/
        # `edit()`/`ack()` record card/button cooldowns into, so a later
        # `button.pressed` event (ids only) can resolve back to what was
        # attached. One table per `HttpClient`, which is one per `Bot` run —
        # it survives a socket reconnect, since it isn't connection state.
        self.cooldowns = CooldownTable()

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
                # A 204 No Content (typing, reactions, delete) has no body to
                # decode — an empty dict, not a ProtocolError (R3). Gated on
                # the status itself, not merely an empty body: an empty-bodied
                # 200 (should one ever occur on an existing endpoint) still
                # raises ProtocolError exactly as it did on 0.1.8.
                if status == 204 and not raw:
                    return {}
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
                    if retry_after > _MAX_RETRY_AFTER_S:
                        self._logger.warning(
                            "rate limited for %.0fs, longer than the %.0fs this client will wait;"
                            " raising",
                            retry_after,
                            _MAX_RETRY_AFTER_S,
                        )
                        raise exc
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

    async def send_message(
        self,
        chat: str,
        text: str,
        *,
        idempotency_key: str,
        mentions: list[dict[str, str]] | None = None,
        embeds: list[dict[str, object]] | None = None,
        buttons: list[dict[str, object]] | None = None,
    ) -> dict:
        body: dict[str, object] = {"chat": chat, "text": text}
        # CONTRACT-V1 §5.0.1: absent and `[]` mean exactly the same thing, so
        # an empty list is omitted rather than sent — matching the js seam,
        # not merely legal per the contract. Same rule for embeds/buttons.
        if mentions:
            body["mentions"] = mentions
        if embeds:
            body["embeds"] = embeds
        if buttons:
            body["buttons"] = buttons
        return await self.request(
            "POST",
            "/v1/messages",
            body=body,
            idempotency_key=idempotency_key,
        )

    async def set_typing(self, chat: str, is_typing: bool) -> dict:
        return await self.request(
            "POST",
            f"/v1/chats/{chat}/typing",
            body={"is_typing": is_typing},
            idempotency_key=str(uuid.uuid4()),
        )

    async def edit_message(
        self,
        msg: str,
        text: str | None = None,
        *,
        embeds: list[dict[str, object]] | Omitted | None = OMITTED,
        buttons: list[dict[str, object]] | Omitted | None = OMITTED,
    ) -> dict:
        """`PATCH /v1/messages/{msg}` with whichever card parts are present
        (AMENDMENT-07 §2). A part left `OMITTED` keeps whatever the message
        already has; `None` goes on the wire as `null` and clears it. Unlike
        `send_message`, an empty list is never a reason to drop the key — the
        caller has already turned `embeds=[]` into the clearing `None`."""
        body = _card_body(text, embeds, buttons)
        return await self.request(
            "PATCH",
            f"/v1/messages/{msg}",
            body=body,
            idempotency_key=str(uuid.uuid4()),
        )

    async def delete_message(self, msg: str) -> dict:
        return await self.request(
            "DELETE",
            f"/v1/messages/{msg}",
            idempotency_key=str(uuid.uuid4()),
        )

    async def set_reaction(self, msg: str, emoji: str) -> dict:
        return await self.request(
            "PUT",
            f"/v1/messages/{msg}/reactions/{urllib.parse.quote(emoji, safe='')}",
            idempotency_key=str(uuid.uuid4()),
        )

    async def unset_reaction(self, msg: str, emoji: str) -> dict:
        return await self.request(
            "DELETE",
            f"/v1/messages/{msg}/reactions/{urllib.parse.quote(emoji, safe='')}",
            idempotency_key=str(uuid.uuid4()),
        )

    async def ack_interaction(
        self,
        interaction: str,
        text: str | None = None,
        *,
        embeds: list[dict[str, object]] | Omitted | None = OMITTED,
        buttons: list[dict[str, object]] | Omitted | None = OMITTED,
        cooldown_retry_after_ms: int | None = None,
    ) -> dict:
        """`POST /v1/interactions/{interaction}/ack`, optionally carrying the
        replacement card (AMENDMENT-07 §3). With no parts at all the body is
        `None`, not `{}`, so a bare ack is byte-identical on the wire to the
        one 0.5.0 sent: `request` passes `json=body` straight to aiohttp, and
        `json=None` writes no entity body and no content-type.

        `cooldown_retry_after_ms` (AMENDMENT-08 §5.1) is the SDK's own
        automatic cooldown ack, never a developer-facing parameter —
        `ButtonContext.ack()` doesn't expose it. Mutually exclusive with
        `text`/`embeds`/`buttons` on the wire (`cooldown_with_body`); the SDK
        enforces that by construction, only ever calling this with one or the
        other, never both."""
        if cooldown_retry_after_ms is not None:
            body: dict[str, object] = {"cooldown": {"retry_after_ms": cooldown_retry_after_ms}}
        else:
            body = _card_body(text, embeds, buttons)
        return await self.request(
            "POST",
            f"/v1/interactions/{interaction}/ack",
            body=body or None,
            idempotency_key=str(uuid.uuid4()),
        )

    async def list_members(self, chat: str, cursor: str | None = None) -> dict:
        path = f"/v1/chats/{chat}/members"
        if cursor:
            path += f"?cursor={urllib.parse.quote(cursor, safe='')}"
        return await self.request("GET", path)

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
