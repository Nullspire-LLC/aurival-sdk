"""`Auth.token()` coalesces concurrent waiters; `Auth.refresh()` deliberately
does not.

They are two different jobs and the bug was giving them one implementation.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from aurival import auth
from aurival.errors import AuthenticationError


def _expires_in(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


class _CountingHttp:
    """Counts `/v1/token` exchanges and can be held open until N callers have
    arrived, which is the only way to make the race deterministic."""

    def __init__(self, *, ttl: float = 900.0, gate: asyncio.Event | None = None) -> None:
        self.exchanges = 0
        self.arrived = 0
        # Set the instant the first caller reaches the exchange, so a test can
        # wait on the race point rather than poll for it.
        self.first_arrived = asyncio.Event()
        self._ttl = ttl
        self._gate = gate

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        assert path == "/v1/token"
        self.arrived += 1
        self.first_arrived.set()
        if self._gate is not None:
            await self._gate.wait()
        self.exchanges += 1
        return {
            "access_token": f"tok_{self.exchanges}",
            "expires_at": _expires_in(self._ttl),
        }


def _auth(http: Any) -> auth.Auth:
    return auth.Auth(
        http,
        auth.MachineKey.generate(),
        auth.Machine(bot="bot_1", machine="machine_1", host="https://x", created="now"),
    )


async def test_a_second_waiter_reuses_the_token_the_first_just_minted() -> None:
    """THE BUG. `token()` checked freshness, found none, and called a `refresh()`
    that exchanged unconditionally. Two callers arriving together therefore
    performed two exchanges, the second throwing away a token minted
    milliseconds earlier.

    It is not hypothetical: handlers run concurrently and every one of them
    reaches this through `ctx.reply`, so the moment a token goes stale N
    handlers queue on this lock at once. N assertions and N `/v1/token` calls,
    self-inflicted, against the endpoint whose rate limit takes the bot offline.

    The gate is what makes it deterministic: BOTH callers are inside the
    exchange path before either is allowed to finish, so the second one is
    guaranteed to be waiting on the lock when the first stores its token.
    """
    gate = asyncio.Event()
    http = _CountingHttp(gate=gate)
    a = _auth(http)

    first = asyncio.create_task(a.token())
    # Let the first take the lock and reach the request.
    await http.first_arrived.wait()
    second = asyncio.create_task(a.token())
    # And let the second get as far as it can — which must be the lock, not the
    # request. If it reaches the request, `arrived` becomes 2 and the assertion
    # below catches it.
    for _ in range(50):
        await asyncio.sleep(0)

    gate.set()
    tok1, tok2 = await first, await second

    assert http.exchanges == 1, (
        f"{http.exchanges} exchanges for two concurrent token() calls. The second waiter took "
        "the lock after the first had already stored a fresh token and minted another anyway"
    )
    assert tok1 == tok2 == "tok_1"


async def test_many_concurrent_waiters_still_exchange_once() -> None:
    gate = asyncio.Event()
    http = _CountingHttp(gate=gate)
    a = _auth(http)

    tasks = [asyncio.create_task(a.token()) for _ in range(12)]
    await http.first_arrived.wait()
    for _ in range(50):
        await asyncio.sleep(0)
    gate.set()
    tokens = await asyncio.gather(*tasks)

    assert http.exchanges == 1, f"12 concurrent callers caused {http.exchanges} exchanges"
    assert set(tokens) == {"tok_1"}


async def test_refresh_forces_an_exchange_even_when_the_token_still_looks_fresh() -> None:
    """THE OTHER HALF, AND THE REASON THE ONE-LINE FIX IS WRONG.

    Re-checking freshness inside `refresh()` would break the HTTP 401 path
    (SDK-37): its caller has just been told by the server that the token it holds
    is rejected. Clock skew or a server-side rotation both leave that token
    nominally fresh by our clock, so an early return would re-send the rejected
    token, burn the single permitted retry, and raise on a request a real
    refresh would have completed.
    """
    http = _CountingHttp()
    a = _auth(http)

    first = await a.token()
    assert http.exchanges == 1
    # Still comfortably fresh — a freshness check here would return `first`.
    assert a._fresh()

    second = await a.refresh()
    assert http.exchanges == 2, (
        "refresh() returned the cached token. Its only caller is the 401 path, where the server "
        "has just rejected exactly that token — returning it burns the one retry and raises"
    )
    assert second != first

    # And token() now serves what refresh() minted, without a third exchange.
    assert await a.token() == second
    assert http.exchanges == 2


async def test_token_still_exchanges_when_the_cached_one_is_inside_the_refresh_headroom() -> None:
    """The coalescing re-check must not become "never refresh". A token whose
    expiry is inside the 60s headroom is NOT fresh and must be replaced."""
    http = _CountingHttp(ttl=30.0)  # below _TOKEN_REFRESH_HEADROOM
    a = _auth(http)

    await a.token()
    assert http.exchanges == 1
    assert not a._fresh(), "a 30s token is inside the 60s headroom and must not count as fresh"
    await a.token()
    assert http.exchanges == 2


async def test_a_failed_exchange_does_not_leave_a_stale_token_behind() -> None:
    class _FailingHttp:
        def __init__(self) -> None:
            self.calls = 0

        async def request(self, method: str, path: str, **kwargs: Any) -> dict:
            self.calls += 1
            raise AuthenticationError(
                type="authentication_error",
                code="key_revoked",
                message="revoked",
                doc_url="",
                request_id=None,
            )

    http = _FailingHttp()
    a = _auth(http)
    with pytest.raises(AuthenticationError):
        await a.token()
    # The lock is released and the next call tries again rather than deadlocking
    # or serving a token that was never minted.
    with pytest.raises(AuthenticationError):
        await a.token()
    assert http.calls == 2
