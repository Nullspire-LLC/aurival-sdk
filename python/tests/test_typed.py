"""PEP 561: editors and checkers only trust an untyped-looking package if it
ships `py.typed`. It shipped nowhere before this — the source had type hints,
but a wheel install looked untyped to every tool that checks the marker
rather than reading the source.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path

import pytest

import aurival
from aurival import Bot, Context
from aurival.cli import BOT_TEMPLATE


def test_the_wheel_ships_py_typed(tmp_path: Path) -> None:
    sdk_root = Path(__file__).resolve().parents[1]
    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--outdir", str(tmp_path), str(sdk_root)],
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(tmp_path.glob("*.whl"))
    assert wheels, "build produced no wheel"
    with zipfile.ZipFile(wheels[0]) as zf:
        names = zf.namelist()
    assert "aurival/py.typed" in names, (
        f"aurival/py.typed is missing from the wheel, so type checkers and editors "
        f"treat the package as untyped. Wheel contents: {names}"
    )


def test_bot_context_is_an_alias_for_context() -> None:
    assert Bot.Context is Context


def test_the_init_template_annotates_ctx_with_the_taught_import() -> None:
    assert "from aurival import Bot, Context" in BOT_TEMPLATE
    assert "async def ping(ctx: Context):" in BOT_TEMPLATE


def test_bot_on_decorator_and_direct_call_are_both_still_callable_at_runtime() -> None:
    """`Bot.on` has `@overload` stubs (decorator form vs. direct-call form, one
    pair per event family). This is the runtime smoke test that both call
    shapes the overloads promise actually work; the static side is
    `test_the_typed_sample_passes_the_checkers` below."""
    bot = Bot()

    @bot.on("member.joined")
    async def decorated(ctx: Context) -> None:
        pass

    async def direct(ctx: Context) -> None:
        pass

    result = bot.on("member.left", direct)

    assert result is direct
    assert bot._has_event_handler("member.joined")
    assert bot._has_event_handler("member.left")


# --- 0.3.0: the version the package reports is the version it ships as -----


def test_dunder_version_matches_pyproject() -> None:
    """0.2.1 shipped with `__version__ = "0.2.0"` because nothing pinned the
    two together. The wheel's metadata comes from `pyproject.toml`; the
    runtime constant is hand-written. This keeps them equal. (Regex rather
    than `tomllib`: the package supports 3.10, which has no `tomllib`.)"""
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert match, "pyproject.toml has no [project] version"
    assert aurival.__version__ == match.group(1)


# --- 0.3.0: one context class per event family, checked statically ---------
#
# The point of BA-R68 is that an editor can tell a developer what `ctx`
# carries without them opening the docs. That only holds if the checkers
# agree with the runtime, so this sample is run through whichever of mypy
# and pyright is installed. It must (a) type-check clean and (b) reject the
# one line that the old flat `Context` let through — reading `ctx.emoji` on a
# member event — so a regression that widens the classes back into one is
# caught, not just a regression that narrows them.

_TYPED_SAMPLE = """
from aurival import (
    Bot,
    BotContext,
    ButtonContext,
    Context,
    EventContext,
    MemberContext,
    Message,
    ReactionContext,
    User,
    mention,
)

bot = Bot()


@bot.command("ping")
async def ping(ctx: Context) -> None:
    sender: User = ctx.sender
    sent: Message = await ctx.reply(f"pong, {sender.name}")
    edited: Message = await ctx.edit(sent, "pong, again")
    await ctx.delete(edited)
    await ctx.react(ctx.message, "👍")
    async with ctx.typing():
        pass


@bot.on("member.joined")
async def welcome(ctx: MemberContext) -> None:
    who: User = ctx.user
    m = mention(who)
    await ctx.send(ctx.chat, f"welcome {m}", mentions=[m])


@bot.on("bot.added")
async def added(ctx: BotContext) -> None:
    actor: User = ctx.actor
    await ctx.reply(f"thanks, {actor.name}")


@bot.on("reaction.added")
async def reacted(ctx: ReactionContext) -> None:
    emoji: str = ctx.emoji
    message: Message = ctx.message
    await ctx.react(message, emoji)


@bot.on("some.future.type")
async def future(ctx: EventContext) -> None:
    if ctx.user is not None:
        await ctx.reply(ctx.user.handle)


@bot.on("button.pressed")
async def pressed(ctx: ButtonContext) -> None:
    button_id: str = ctx.button
    interaction: str = ctx.interaction
    presser: User = ctx.user
    message: Message = ctx.message
    await ctx.ack()
    await ctx.reply(f"{presser.name} pressed {button_id} ({interaction}, {message.id})")
"""

_MISTYPED_LINE = """

@bot.on("member.left")
async def wrong(ctx: MemberContext) -> None:
    print(ctx.emoji)


@bot.on("member.left")
async def wrong_button(ctx: ButtonContext) -> None:
    pass
"""


def _checker(name: str) -> list[str] | None:
    """Prefer the module in this interpreter (the scratch venv installs both),
    fall back to a binary on PATH, else None so the test skips."""
    if importlib.util.find_spec(name) is not None:
        return [sys.executable, "-m", name]
    exe = shutil.which(name)
    return [exe] if exe else None


@pytest.mark.parametrize("name", ["mypy", "pyright"])
def test_the_typed_sample_passes_the_checkers(name: str, tmp_path: Path) -> None:
    cmd = _checker(name)
    if cmd is None:
        pytest.skip(f"{name} is not installed")
    good = tmp_path / "good_bot.py"
    good.write_text(textwrap.dedent(_TYPED_SAMPLE), encoding="utf-8")
    bad = tmp_path / "bad_bot.py"
    bad.write_text(textwrap.dedent(_TYPED_SAMPLE + _MISTYPED_LINE), encoding="utf-8")
    sdk_root = Path(__file__).resolve().parents[1]
    # A trimmed environment so a developer's own mypy/pyright config is not
    # picked up. `HOME` stays real: the pip `pyright` wrapper keeps its node
    # runtime under `~/.cache`, and a throwaway home would re-download it on
    # every run, which is a network fetch inside a unit test.
    env = {"PYTHONPATH": str(sdk_root), "PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "")}
    for passthrough in ("PYRIGHT_PYTHON_CACHE_DIR", "PYRIGHT_PYTHON_FORCE_VERSION"):
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]
    if name == "mypy":
        flags = ["--strict", "--no-error-summary", "--cache-dir", str(tmp_path / ".mypy")]
    else:
        flags = ["--pythonpath", sys.executable]
    ok = subprocess.run([*cmd, *flags, str(good)], capture_output=True, text=True, env=env)
    assert ok.returncode == 0, f"{name} rejected the typed sample:\n{ok.stdout}{ok.stderr}"
    rejected = subprocess.run([*cmd, *flags, str(bad)], capture_output=True, text=True, env=env)
    assert rejected.returncode != 0, (
        f"{name} accepted `ctx.emoji` on a MemberContext — the per-family "
        f"classes have collapsed back into one:\n{rejected.stdout}"
    )
    assert "emoji" in rejected.stdout
