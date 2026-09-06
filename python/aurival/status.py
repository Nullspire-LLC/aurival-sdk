"""Human-friendly one-line status banners, printed to stderr by default.

Six moments (connecting / connected / reconnecting / reconnected / stopped /
disconnected) so a developer who ran `python bot.py` sees SOMETHING rather
than a blank terminal. Always stderr — never stdout, so piping stays clean.
Colored only when stderr is a real TTY; plain text otherwise (piped,
redirected, or explicitly disabled).

Opt-out: `Bot(quiet=True)` or env `AURIVAL_QUIET=1` — either silences every
line this module prints. Checked live on every call (not cached at
construction) so an env var set after the fact still takes effect.
"""

from __future__ import annotations

import os
import sys
from typing import TextIO

_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_RESET = "\033[0m"


def env_quiet() -> bool:
    return os.environ.get("AURIVAL_QUIET") == "1"


def format_duration(seconds: float) -> str:
    """Plain human-friendly duration, no external deps: `2.3s`, `1m 5s`, `1h 2m`."""
    seconds = max(0.0, seconds)
    if seconds < 60:
        return f"{seconds:.1f}s"
    total = int(round(seconds))
    minutes, sec = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m {sec}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


def _use_color(stream: TextIO) -> bool:
    try:
        return bool(stream.isatty())
    except Exception:
        return False


# Codes whose bare `{code}: {message}` reads like a crash rather than a
# designed stop — a second connection, or an owner pausing the bot from the
# app. Friendlier text, plus the doc_url on its own line so the developer can
# read the full story. Every other code is untouched.
_FRIENDLY_STOPPED: dict[str, str] = {
    "session_superseded": (
        "another copy of this bot connected (elsewhere). One socket per "
        "bot: stop the other copy, then start this one again."
    ),
    "bot_suspended": (
        "this bot is paused by its owner. Resume it from the app, then start again."
    ),
}


class StatusReporter:
    """One reporter per `Bot`, held by the bot and shared into its `Socket`
    so both sides of the connecting/connected/reconnecting story print
    through the same quiet/color rules."""

    def __init__(self, *, quiet: bool = False, stream: TextIO | None = None) -> None:
        self._quiet = quiet
        self._stream = stream if stream is not None else sys.stderr

    @property
    def enabled(self) -> bool:
        return not self._quiet and not env_quiet()

    def _emit(self, text: str, color: str | None) -> None:
        if not self.enabled:
            return
        stream = self._stream
        if color is not None and _use_color(stream):
            stream.write(f"{color}{text}{_RESET}\n")
        else:
            stream.write(f"{text}\n")
        stream.flush()

    def connecting(self, bot: str) -> None:
        self._emit(f"aurival: connecting to bots.aurival.com as {bot}…", _YELLOW)

    def connected(self, *, bot: str, session_id: str, command_count: int) -> None:
        short_id = session_id[:8]
        self._emit(
            f"aurival: connected — {bot}, session {short_id}, {command_count} commands "
            f"registered. Waiting for commands. (Ctrl+C to stop)",
            _GREEN,
        )

    def reconnecting(self, *, reason: str, delay_s: float) -> None:
        self._emit(f"aurival: connection closed ({reason}), reconnecting in {delay_s:.1f}s…", _YELLOW)

    def reconnected(self, *, duration_s: float) -> None:
        self._emit(f"aurival: reconnected after {format_duration(duration_s)}", _GREEN)

    def stopped(self, *, code: str, message: str, doc_url: str | None = None) -> None:
        friendly = _FRIENDLY_STOPPED.get(code)
        if friendly is not None:
            text = f"aurival: stopped — {friendly}"
            if doc_url is not None:
                text = f"{text}\n{doc_url}"
            self._emit(text, _RED)
            return
        self._emit(f"aurival: stopped — {code}: {message}", _RED)

    def duplicate_command(self, name: str) -> None:
        self._emit(
            f'aurival: command "{name}" registered twice, the later definition wins',
            _YELLOW,
        )

    def no_commands(self) -> None:
        self._emit(
            "aurival: no commands registered, this bot will connect and wait "
            "forever. Add @bot.command(...) before run().",
            _YELLOW,
        )

    def disconnected(self, *, duration_s: float) -> None:
        self._emit(f"aurival: disconnected after {format_duration(duration_s)}", None)
