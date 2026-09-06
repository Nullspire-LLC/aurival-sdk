"""``aurival init`` (SDK-43): pair this machine, then scaffold a starter bot.

Shares the pairing path with `Bot.start` (`auth.pair`, `auth.KeyFile`) rather
than duplicating it — one code path means one place a pairing bug can hide.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import aiohttp

from .auth import KeyFile, machine_label, pair, resolve_host
from .http import HttpClient

# The README's quick-start bot, spaced for PEP 8 rather than for prose — the two
# differ in blank lines and in nothing else, which is what test_readme.py pins.
# A developer who read the docs must get the file the docs showed them.
BOT_TEMPLATE = """from aurival import Bot, Context

bot = Bot()


@bot.command("ping", "Check that the bot is alive")
async def ping(ctx: Context):
    await ctx.reply("pong")


bot.run()
"""

_log = logging.getLogger("aurival")


BOT_PATH = Path("bot.py")


def _running_as() -> str:
    """The path of the executable this process was invoked as.

    `sys.argv[0]`, resolved, rather than `sys.executable`: the question being
    answered is "which `aurival` did the shell find", and `sys.executable` is
    the interpreter, which is the same for the right script and the wrong one.
    """
    try:
        return str(Path(sys.argv[0]).resolve())
    except (OSError, ValueError):  # a stripped or exotic argv[0]
        return sys.argv[0] or "?"


def _bot_py_already_exists(out: Callable[[str], None]) -> bool:
    """Sync for the same reason `_write_starter_bot` is: blocking filesystem I/O
    stays out of the coroutine body."""
    if BOT_PATH.exists():
        out(f"aurival: {BOT_PATH} already exists, refusing to overwrite it")
        return True
    return False


def _write_starter_bot(out: Callable[[str], None]) -> int:
    """The filesystem half of `init`. Plain (non-async) on purpose: it is
    blocking I/O, kept out of the coroutine's body."""
    BOT_PATH.write_text(BOT_TEMPLATE, encoding="utf-8")
    out("python bot.py")
    return 0


async def init(out: Callable[[str], None] = print) -> int:
    """Write `bot.py` for a paired machine, pairing first if this one is new.

    Returns a process exit code.

    THE REFUSAL COMES FIRST, BEFORE ANY PAIRING. `bot.py` is the developer's
    file the moment it exists, and pairing is not a local step — it prints a
    code and then waits for a human to walk to their phone, compare a
    fingerprint and approve. Checking afterwards would spend that whole trip and
    THEN refuse, having also left a freshly paired machine behind for a run that
    failed. So: nothing is written and nothing is paired.
    """
    # SDK-47 / BA-OI-82, AND IT IS THE FIRST LINE FOR A REASON.
    #
    # The desktop client's launcher is also called `aurival`, so on a machine
    # that has it installed, typing `aurival init` before the venv's script is
    # on PATH launches the DESKTOP APP. Nothing about that failure says which
    # binary ran: the developer sees a window open and no bot appear.
    #
    # Printing the resolved path makes the wrong binary visible in one line
    # rather than in an afternoon. It is temporary — the owner keeps `aurival`
    # for the SDK and the desktop launcher is being renamed — but a diagnostic
    # that costs one line stays cheap either way.
    out(f"aurival: running {_running_as()}")

    if _bot_py_already_exists(out):
        return 1

    key_file = KeyFile()
    if key_file.load() is None:
        host = resolve_host()
        async with aiohttp.ClientSession() as session:
            http = HttpClient(session, host, logger=_log)
            key, machine = await pair(
                http, machine_label=machine_label(), host=host, out=out, logger=_log
            )
        key_file.save(key, machine)
    else:
        out(f"aurival: already paired ({key_file.path}), skipping")

    return _write_starter_bot(out)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="aurival", description="Aurival bot SDK command-line interface."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="pair this machine and write a starter bot.py")
    args = parser.parse_args(argv)

    if args.command == "init":
        return asyncio.run(init())
    return 1  # unreachable: argparse rejects any command that isn't a subparser above


if __name__ == "__main__":
    raise SystemExit(main())
