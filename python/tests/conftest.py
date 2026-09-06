from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
BACKEND = REPO / "backend-go"
SDK = REPO / "sdk" / "python"

DSN_ENV = "MIGRATE_TEST_DATABASE_URL"


class Testbed:
    """One running cmd/bot-api-testbed, and the handshake it printed."""

    # Not a test class, despite the name pytest pattern-matches on.
    __test__ = False

    def __init__(self, proc: subprocess.Popen[str], handshake: dict[str, str]) -> None:
        self.proc = proc
        self.handshake = handshake

    @property
    def host(self) -> str:
        return self.handshake["host"]

    def __getitem__(self, key: str) -> str:
        return self.handshake[key]


# Loader/toolchain variables a parent environment may need to hand its child
# interpreter so the interpreter can even START. `actions/setup-python`'s
# tool-cache CPython is built `--enable-shared`, so it needs `LD_LIBRARY_PATH`
# to find its own `libpython3.NN.so` — a system python (static, no such
# dependency) never surfaces the gap locally. None of these carry an
# event-allowlist or app secret, so passing them through does not reopen
# BA-R28/S14 (test_a_bot_gets_events_with_no_allowlist_anywhere_in_the_environment,
# in test_e2e_matrix.py): the scrub of `AURIVAL_*`/`BOT_*` parent state stays exactly as it was.
BOT_ENV_PASSTHROUGH = ("LD_LIBRARY_PATH",)


def bot_env(bed: Testbed, directory: Path) -> dict[str, str]:
    """The environment a spawned bot process gets.

    Built from a deliberately minimal, explicit base — never a copy of the
    parent environment — so no `AURIVAL_*`/`BOT_*` secret or allowlist var
    the test process happens to carry can reach the child. The only parent
    state that crosses is the small loader passthrough above, and only when
    the parent actually has it set.
    """
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(directory),
        "AURIVAL_API": bed.host,
        "PYTHONPATH": str(SDK),
        "PYTHONUNBUFFERED": "1",
    }
    for name in BOT_ENV_PASSTHROUGH:
        if name in os.environ:
            env[name] = os.environ[name]
    return env



def _skip_reason() -> str | None:
    if not os.environ.get(DSN_ENV):
        return (
            f"{DSN_ENV} is not set, so the SDK end-to-end suite cannot run against the real "
            "service and DID NOT RUN. It is not passing; it is absent. Start a throwaway "
            "Postgres and set the variable to exercise it."
        )
    if shutil.which("go") is None:
        return (
            "the Go toolchain is not on PATH, so cmd/bot-api-testbed cannot be built "
            "and the e2e DID NOT RUN"
        )
    if not BACKEND.is_dir():
        return f"{BACKEND} is missing, so the testbed cannot be built and the e2e DID NOT RUN"
    return None


def require_testbed() -> None:
    """Skip loudly, or return. Every entry point into the live suite goes
    through this so no path can quietly pass without a service."""
    reason = _skip_reason()
    if reason:
        print(f"\nSKIPPING THE SDK END-TO-END SUITE: {reason}", file=sys.stderr, flush=True)
        pytest.skip(reason, allow_module_level=True)


def build_testbed(out_dir: Path) -> Path:
    binary = out_dir / "bot-api-testbed"
    build = subprocess.run(
        ["go", "build", "-o", str(binary), "./cmd/bot-api-testbed"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        pytest.fail(f"building the testbed failed:\n{build.stderr}")
    return binary


def start_testbed(binary: Path, **env_overrides: str) -> Testbed:
    """One testbed process, serving, with its handshake already read.

    N PROCESSES ON ONE DSN IS SAFE BY CONSTRUCTION, which is what lets the
    matrix take a fresh one per test: the schema bootstrap is apply-once and
    recorded, and seedOwnerAndBot mints a NEW owner, bot and playground on every
    start. A fresh chat per test also keeps each one clear of Store.Send's
    six-per-ten-minutes per-conversation ceiling — a suppressed send writes no
    row and returns success, so hitting that ceiling looks exactly like a bot
    that stopped answering.
    """
    env = dict(os.environ)
    env["AURIVAL_TESTBED_ADDR"] = "127.0.0.1:0"
    env.update(env_overrides)
    proc = subprocess.Popen(
        [str(binary)],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    return Testbed(proc, _read_handshake(proc))


def stop_testbed(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def testbed_binary(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Built once for the whole session — every test wants the same binary,
    only its own process."""
    require_testbed()
    return build_testbed(tmp_path_factory.mktemp("testbed-build"))


@pytest.fixture
def testbed_factory(testbed_binary: Path) -> Iterator[Callable[..., Testbed]]:
    """Start testbeds inside one test and have them torn down afterwards.

    Function-scoped on purpose. The matrix needs a testbed it may SIGTERM (S4)
    and testbeds whose token TTL differs from the default (S5), neither of which
    a shared session-scoped process can offer.
    """
    started: list[Testbed] = []

    def factory(**env_overrides: str) -> Testbed:
        bed = start_testbed(testbed_binary, **env_overrides)
        started.append(bed)
        return bed

    try:
        yield factory
    finally:
        for bed in started:
            stop_testbed(bed.proc)


@pytest.fixture(scope="session")
def testbed(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Testbed]:
    """The real botapi.Server, seeded, on loopback.

    IT ANNOUNCES A SKIP RATHER THAN PASSING QUIETLY. A suite that reports green
    when it never reached the service is the thing this whole testbed exists to
    make impossible.
    """
    require_testbed()

    binary = build_testbed(tmp_path_factory.mktemp("testbed"))
    proc = subprocess.Popen(
        [str(binary)],
        cwd=BACKEND,
        env={**os.environ, "AURIVAL_TESTBED_ADDR": "127.0.0.1:0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    handshake = _read_handshake(proc)
    try:
        yield Testbed(proc, handshake)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def _read_handshake(proc: subprocess.Popen[str], timeout: float = 120.0) -> dict[str, str]:
    """The testbed prints one JSON line when it is serving. Reading it is how we
    know the schema bootstrap finished — it takes a while on a fresh cluster."""
    assert proc.stdout is not None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                err = proc.stderr.read() if proc.stderr else ""
                pytest.fail(f"the testbed exited before serving:\n{err}")
            continue
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    pytest.fail("the testbed never printed its handshake")
