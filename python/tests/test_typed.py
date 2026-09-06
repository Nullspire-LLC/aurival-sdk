"""PEP 561: editors and checkers only trust an untyped-looking package if it
ships `py.typed`. It shipped nowhere before this — the source had type hints,
but a wheel install looked untyped to every tool that checks the marker
rather than reading the source.
"""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

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
