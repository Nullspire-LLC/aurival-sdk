"""`aurival init` (SDK-43): no network, no testbed — pairing is faked by
seeding an already-loaded key file."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from aurival import auth, cli


def _fake_paired(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make `KeyFile.load` behave as if this machine paired already, so
    `init` never touches the network."""
    key = auth.MachineKey.generate()
    machine = auth.Machine(bot="bot_1", machine="mch_1", host=auth.DEFAULT_HOST, created="now")
    monkeypatch.setattr(auth.KeyFile, "load", lambda self: (key, machine))


async def test_init_writes_bot_py_and_prints_one_next_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)
    lines: list[str] = []

    code = await cli.init(out=lines.append)

    assert code == 0
    assert (tmp_path / "bot.py").exists()
    assert lines[-1] == "python bot.py"


async def test_init_refuses_to_overwrite_existing_bot_py(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)
    bot_path = tmp_path / "bot.py"
    original = "# my own bot, hand-written\n"
    bot_path.write_text(original, encoding="utf-8")
    lines: list[str] = []

    code = await cli.init(out=lines.append)

    assert code != 0
    assert bot_path.read_text(encoding="utf-8") == original
    assert "python bot.py" not in lines


async def test_written_bot_py_is_the_readme_quickstart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)

    await cli.init(out=lambda _line: None)

    source = (tmp_path / "bot.py").read_text(encoding="utf-8")
    compile(source, "bot.py", "exec")  # must be valid, runnable Python
    assert '@bot.command("ping"' in source
    assert "bot.run()" in source


def test_help_mentions_init(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["--help"])

    assert excinfo.value.code == 0
    out = capsys.readouterr().out
    assert "init" in out


async def test_init_prints_exactly_one_next_step_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)
    lines: list[str] = []

    await cli.init(out=lines.append)

    next_step_lines = [line for line in lines if "bot.py" in line and line.startswith("python ")]
    assert next_step_lines == ["python bot.py"]


async def test_init_names_the_executable_it_is_running_as_on_its_first_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SDK-47 / BA-OI-82. The desktop client's launcher is also called
    `aurival`, so `aurival init` on a machine that has it can open the DESKTOP
    APP instead — and nothing about that failure says which binary ran.

    FIRST, not merely present: the whole value is that the developer sees it
    before the output they were expecting fails to appear.
    """
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)
    monkeypatch.setattr(sys, "argv", ["/somewhere/.venv/bin/aurival", "init"])
    lines: list[str] = []

    await cli.init(out=lines.append)

    assert lines[0] == "aurival: running /somewhere/.venv/bin/aurival", lines


async def test_init_still_names_an_executable_when_argv0_is_junk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A diagnostic must never be the thing that crashes the tool.
    monkeypatch.chdir(tmp_path)
    _fake_paired(monkeypatch)
    monkeypatch.setattr(sys, "argv", [""])
    lines: list[str] = []

    assert await cli.init(out=lines.append) == 0
    assert lines[0].startswith("aurival: running "), lines


async def test_the_overwrite_refusal_happens_before_any_pairing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """PAIRING IS NOT A LOCAL STEP. It prints a code and then waits for a human
    to walk to their phone, compare a fingerprint and approve. Checking the
    overwrite afterwards spends that entire trip and THEN refuses, having also
    left a freshly paired machine behind for a run that failed.

    So the ORDER is asserted, not just the outcome: with no key file at all and
    a `bot.py` present, `pair` must never be reached. JS does the same.
    """
    monkeypatch.chdir(tmp_path)
    (tmp_path / "bot.py").write_text("# mine\n", encoding="utf-8")

    paired = False

    async def _explode(*args: object, **kwargs: object) -> None:
        nonlocal paired
        paired = True
        raise AssertionError("init paired the machine before checking for an existing bot.py")

    monkeypatch.setattr(cli, "pair", _explode)
    lines: list[str] = []

    code = await cli.init(out=lines.append)

    assert code == 1
    assert not paired, "init reached the pairing flow with a bot.py already on disk"
    assert (tmp_path / "bot.py").read_text(encoding="utf-8") == "# mine\n"
    assert any("refusing to overwrite" in line for line in lines), lines
