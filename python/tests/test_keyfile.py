"""Tests for `aurival.auth.KeyFile` — mode, atomicity, and the `.gitignore`
rule (SDK-22).
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from aurival import auth


def _perm(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_default_path_is_dot_aurival_machine_json() -> None:
    assert auth.KeyFile.default_path() == Path(".aurival") / "machine.json"


def test_no_path_no_env_uses_default_and_is_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AURIVAL_KEY_PATH", raising=False)
    kf = auth.KeyFile()
    assert kf.path == auth.KeyFile.default_path()
    assert kf.is_default is True


def test_env_override_sets_path_and_clears_is_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    override = tmp_path / "elsewhere" / "creds.json"
    monkeypatch.setenv("AURIVAL_KEY_PATH", str(override))
    kf = auth.KeyFile()
    assert kf.path == override
    assert kf.is_default is False


def test_explicit_path_argument_clears_is_default(tmp_path: Path) -> None:
    kf = auth.KeyFile(tmp_path / "custom.json")
    assert kf.is_default is False


def test_save_writes_0600_file_in_0700_dir(tmp_path: Path) -> None:
    kf = auth.KeyFile(tmp_path / ".aurival" / "machine.json")
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    assert _perm(kf.path) == 0o600
    assert _perm(kf.path.parent) == 0o700


def test_save_then_load_round_trips(tmp_path: Path) -> None:
    kf = auth.KeyFile(tmp_path / "machine.json")
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)

    loaded = kf.load()
    assert loaded is not None
    loaded_key, loaded_machine = loaded
    assert loaded_machine == machine
    assert loaded_key.public_key_b64 == key.public_key_b64
    assert loaded_key.fingerprint == key.fingerprint


def test_load_missing_file_returns_none(tmp_path: Path) -> None:
    kf = auth.KeyFile(tmp_path / "nope.json")
    assert kf.load() is None


def test_save_is_atomic_no_stray_tmp_files_on_success(tmp_path: Path) -> None:
    kf = auth.KeyFile(tmp_path / "machine.json")
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    leftovers = list(tmp_path.glob(".machine-*.tmp"))
    assert leftovers == []


def test_save_crash_mid_write_leaves_old_file_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kf = auth.KeyFile(tmp_path / "machine.json")
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    original_bytes = kf.path.read_bytes()

    key2 = auth.MachineKey.generate()
    machine2 = auth.Machine(
        bot="bot_c", machine="machine_d", host="https://y", created="2026-02-02T00:00:00Z"
    )

    def blow_up(*args: object, **kwargs: object) -> None:
        raise RuntimeError("simulated crash mid-write")

    monkeypatch.setattr(auth.json, "dump", blow_up)
    with pytest.raises(RuntimeError):
        kf.save(key2, machine2)

    assert kf.path.read_bytes() == original_bytes
    assert list(tmp_path.glob(".machine-*.tmp")) == []


def test_gitignore_written_only_at_default_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("AURIVAL_KEY_PATH", raising=False)
    kf = auth.KeyFile()  # default path, relative to cwd
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    gitignore = tmp_path / ".aurival" / ".gitignore"
    assert gitignore.exists()
    assert gitignore.read_text() == "*\n"


def test_gitignore_absent_beside_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    override_dir = tmp_path / "custom-creds"
    monkeypatch.setenv("AURIVAL_KEY_PATH", str(override_dir / "machine.json"))
    kf = auth.KeyFile()
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    assert not (override_dir / ".gitignore").exists()


def test_load_never_holds_the_seed_string_after_return(tmp_path: Path) -> None:
    """`load()`'s local `doc["seed"]` dict is not retained by the returned
    objects — the returned `Machine` has no seed field at all.
    """
    kf = auth.KeyFile(tmp_path / "machine.json")
    key = auth.MachineKey.generate()
    machine = auth.Machine(
        bot="bot_a", machine="machine_b", host="https://x", created="2026-01-01T00:00:00Z"
    )
    kf.save(key, machine)
    on_disk = json.loads(kf.path.read_text())
    seed_b64 = on_disk["seed"]

    loaded_key, loaded_machine = kf.load()  # type: ignore[misc]
    assert seed_b64 not in {v for v in vars(loaded_machine).values()}
    assert not hasattr(loaded_key, "seed")
    assert not hasattr(loaded_key, "_seed")
