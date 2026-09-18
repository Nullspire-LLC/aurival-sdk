"""`Cooldown`: SDK-side rate limiting for commands and buttons (AMENDMENT-08).

One primitive, no server involvement. A bot author attaches a `Cooldown` to a
command, a card, or a button, and the SDK enforces it locally — a fixed-window
bucket per key, checked and consumed in one synchronous call.

**Buckets are process memory.** They live only as long as the `Cooldown`
instance that owns them, and they reset the moment the process restarts. They
are never shared across instances or across processes — a bot running two
replicas behind a supervisor keeps two independent counts, and a deploy clears
every bucket it had (AMENDMENT-08 §2, D16). This is fine for what a cooldown
is for — pacing a conversation, not enforcing an entitlement — and the server's
own floor (`ButtonPressRateLimit`, `press.go`) is what actually bounds abuse.

Bounds: a `Cooldown` itself only ever requires `rate >= 1` and `per > 0`. The
60-second cap on a *button* cooldown is enforced separately, at the point a
`Cooldown` is attached to a button (`validate_button_cooldown`) — command
cooldowns are unbounded (AMENDMENT-08 D13), because they never reach the wire.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Hashable
from typing import Union

# --- sentences (AMENDMENT-08 §8) --------------------------------------------
#
# These have NO server twin — nothing on the wire can carry a `Cooldown`, so
# they do not belong in caps.py, whose header pins it to sentences the server
# itself can send back. They live here, beside the primitive they guard.

RATE_AT_LEAST_ONE = "a cooldown rate is at least 1"
PERIOD_GREATER_THAN_ZERO = "a cooldown period is greater than zero"
BUTTON_COOLDOWN_MAX_SECONDS = "a button cooldown is at most 60 seconds"
LINK_BUTTON_CANNOT_HAVE_COOLDOWN = "a link button cannot carry a cooldown"

# AMENDMENT-08 §5.1: button-cooldown `per` is bounded so `retry_after_ms` can
# never exceed the wire's own 60000 ms ceiling.
MAX_BUTTON_COOLDOWN_SECONDS = 60.0

BucketName = str  # "user" | "chat" | "global" — a plain str, like Button.style


class _UnsetType:
    """The sentinel that makes `Bot(button_cooldown=None)` distinguishable
    from "not passed" (AMENDMENT-08 §3). `None` already means "disabled" at
    every attachment point, so "the caller said nothing" needs a third value.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "UNSET"

    def __bool__(self) -> bool:  # pragma: no cover - guards accidental truthiness checks
        return False


UNSET = _UnsetType()

# What a `cooldown=` keyword can hold at any of the three button attachment
# points: unset (inherit from the level above), `None` (disabled here), or a
# concrete `Cooldown` to use.
CooldownSpec = Union["Cooldown", None, _UnsetType]


class Cooldown:
    """A fixed-window rate bucket, anchored at first use.

    `Cooldown(rate, per, bucket="user")` — `rate` calls admitted per `per`
    seconds (`per` is always seconds, never milliseconds, in this SDK), and
    `bucket` says what the window is keyed on when it is attached to a
    command or a button:

        "user"    (default)  each person gets `rate` every `per` seconds
        "chat"                  the whole chat gets `rate`, whoever asks
        "global"              the whole bot gets `rate`, everywhere

    **Buckets are process memory** — see the module docstring. **Every
    `Cooldown` instance owns its own bucket dict**; instances are never
    shared between attachments, so a command's own `Cooldown` is already
    private to that command and needs no further scoping.

    `clock` is injectable (defaults to `time.monotonic`) so a test can drive
    time without sleeping.
    """

    def __init__(
        self,
        rate: int,
        per: float,
        bucket: BucketName = "user",
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if rate < 1:
            raise ValueError(RATE_AT_LEAST_ONE)
        if per <= 0:
            raise ValueError(PERIOD_GREATER_THAN_ZERO)
        self.rate = rate
        self.per = per
        self.bucket = bucket
        self._clock = clock
        # key -> (window_start, tokens_remaining)
        self._buckets: dict[Hashable, tuple[float, int]] = {}
        # key -> the window_start a refusal was last announced for, so a
        # caller can implement "one notice per bucket per window" (§4)
        # without re-deriving the window itself.
        self._notified: dict[Hashable, float] = {}

    def check(self, key: Hashable) -> float | None:
        """Check-and-consume, in one call. `None` on a pass (a token was
        spent). On a refusal, the `retry_after` seconds until this bucket
        next admits a call — and the refusal **consumes nothing and touches
        no state**, so it never extends the window."""
        now = self._clock()
        state = self._buckets.get(key)
        if state is None or now - state[0] >= self.per:
            window_start, tokens = now, self.rate
        else:
            window_start, tokens = state
        if tokens == 0:
            return self.per - (now - window_start)
        self._buckets[key] = (window_start, tokens - 1)
        return None

    def should_notify(self, key: Hashable) -> bool:
        """True the first time this is called for a given key's *current*
        window (as last observed by `check`), False every time after, until
        the window rolls over. Call only after a refusal — the window it
        reads is the one `check` just refused against."""
        state = self._buckets.get(key)
        window_start = state[0] if state is not None else 0.0
        if self._notified.get(key) == window_start:
            return False
        self._notified[key] = window_start
        return True


def validate_button_cooldown(cooldown: Cooldown | None) -> None:
    """Attachment-time bound for a *button* cooldown (§5.1, §5.1 D12): `per`
    at most 60 seconds, because `retry_after_ms` has to fit the wire's own
    ceiling. Command cooldowns never call this — they are unbounded (D13).
    A no-op for `None` (disabled, nothing to bound)."""
    if cooldown is not None and cooldown.per > MAX_BUTTON_COOLDOWN_SECONDS:
        raise ValueError(BUTTON_COOLDOWN_MAX_SECONDS)


def resolve_subject(bucket: BucketName, *, user_id: str, chat_id: str) -> Hashable:
    """The bucket-scheme table (§2): `user` keys on the invoking/pressing
    user, `chat` on the conversation, `global` on nothing (one bucket per
    attachment) — spelled `()` so it is still a valid, hashable dict key."""
    if bucket == "chat":
        return chat_id
    if bucket == "global":
        return ()
    return user_id


# Bounds how many messages' worth of button/card cooldowns a long-lived bot
# remembers. Well past any plausible working set of "cards with live
# buttons"; it exists so a bot that has been up for weeks doesn't grow this
# table without limit, not because 1024 is a meaningful number on its own.
DEFAULT_TABLE_CAPACITY = 1024

CardRecord = tuple[CooldownSpec, "dict[str, CooldownSpec]"]


class CooldownTable:
    """What `send()` (and `reply()`/`edit()`/`ack()` when they carry buttons)
    records so a later `button.pressed` event — which carries only ids, never
    the `Button` objects themselves — can be resolved back to the cooldown
    that was attached when the card went out (§3's "card lookup on press").

    Keyed by message id: `{card_cooldown, {button_id: button_cooldown}}`,
    each value one of `UNSET` (inherit), `None` (disabled) or a `Cooldown`.
    If a message id is missing entirely — the bot restarted, or the card was
    sent by another process — the caller falls through to the bot default;
    this table only ever says what it actually recorded.

    Bounded (see `DEFAULT_TABLE_CAPACITY`) with simple insertion-order
    eviction, so a long-lived bot's memory for this does not grow forever.
    Process memory only, exactly like a `Cooldown`'s own buckets — it does
    not survive a restart and is never shared across instances.
    """

    def __init__(self, capacity: int = DEFAULT_TABLE_CAPACITY) -> None:
        self._capacity = capacity
        self._records: dict[str, CardRecord] = {}

    def record(
        self,
        message_id: str,
        card_cooldown: CooldownSpec,
        button_cooldowns: dict[str, CooldownSpec],
    ) -> None:
        if not message_id:
            return
        # Re-inserting moves the key to the end of iteration order, which is
        # what makes `popitem`-by-oldest below a correct (if approximate) LRU.
        self._records.pop(message_id, None)
        self._records[message_id] = (card_cooldown, dict(button_cooldowns))
        while len(self._records) > self._capacity:
            oldest = next(iter(self._records))
            del self._records[oldest]

    def lookup(self, message_id: str) -> CardRecord | None:
        return self._records.get(message_id)
