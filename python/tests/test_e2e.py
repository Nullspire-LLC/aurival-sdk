"""A real bot answering /ping, through the real service.

This is the acceptance bar for the whole package (PLAN.md, "Tests"): pair, print a
code, approve it, sync commands, invoke, read `pong` back. Nothing here is mocked —
if the testbed cannot run, the suite says it SKIPPED rather than passing.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.conftest import bot_env

BOT_SOURCE = """
import logging
from aurival import Bot

logging.basicConfig(level=logging.DEBUG)
bot = Bot()

@bot.command("ping", "Check that the bot is alive")
async def ping(ctx):
    await ctx.reply("pong")

bot.run()
"""

# MATCHED ON ITS LABEL, NOT ITS SHAPE. newUserCode() and Fingerprint() produce the
# same XXXX-XXXX shape and both print during pairing, so a shape-only match picks
# up whichever came first and then fails at approval with no explanation.
CODE_RE = re.compile(r"pairing code\s+([0-9A-Z]{4}-[0-9A-Z]{4})")
FINGERPRINT_RE = re.compile(r"fingerprint\s+([0-9A-Z]{4}-[0-9A-Z]{4})")


def _post(host: str, path: str, body: dict[str, object]) -> dict[str, object]:
    req = urllib.request.Request(
        host + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _get(host: str, path: str) -> dict[str, object]:
    with urllib.request.urlopen(host + path, timeout=10) as resp:
        return json.loads(resp.read())


class _Bot:
    """The developer's process, run exactly as a developer would run it.

    A reader THREAD drains stdout for the whole session, rather than the test
    reading only until it finds what it wanted. The difference is the redaction
    assertion at the end: reading on demand would leave the sync, connect and
    dispatch phases uncaptured, which is exactly the window a token leak would
    appear in.
    """

    def __init__(self, proc: subprocess.Popen[str]) -> None:
        self.proc = proc
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._eof = threading.Event()
        self._reader = threading.Thread(target=self._drain, daemon=True)
        self._reader.start()

    def _drain(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                with self._lock:
                    self._lines.append(line.rstrip("\n"))
        finally:
            self._eof.set()

    def read_until(self, pattern: re.Pattern[str], timeout: float = 90.0) -> str:
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            # EOF ON THE READER, not proc.poll(). The process can exit with lines
            # still in the thread's buffer, and giving up on poll() would report
            # "the bot exited" while the line we want is in flight.
            drained = self._eof.is_set()
            with self._lock:
                lines = self._lines[seen:]
                seen = len(self._lines)
            for line in lines:
                match = pattern.search(line)
                if match:
                    return match.group(1)
            if drained:
                raise AssertionError(f"the bot exited:\n{self.transcript()}")
            time.sleep(0.1)
        raise AssertionError(f"timed out waiting on the bot's stdout:\n{self.transcript()}")

    def transcript(self) -> str:
        with self._lock:
            return "\n".join(self._lines)


@pytest.fixture
def running_bot(testbed, tmp_path: Path):
    """A bot process in a clean directory, so ./.aurival is this test's own."""
    script = tmp_path / "ping_bot.py"
    script.write_text(BOT_SOURCE)
    proc = subprocess.Popen(
        [sys.executable, str(script)],
        cwd=tmp_path,
        env=bot_env(testbed, tmp_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    bot = _Bot(proc)
    try:
        yield bot
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_a_real_bot_answers_ping(testbed, running_bot: _Bot, tmp_path: Path) -> None:
    host = testbed.host

    # 1. The code prints to STDOUT, not through the logger — a developer whose
    #    logger is at WARNING must still see it (SDK-31).
    code = running_bot.read_until(CODE_RE)
    assert code, running_bot.transcript()

    # 2. The owner approves. In production this is a screen in the app behind the
    #    device lane; here it is the testbed standing in for it.
    approved = _post(host, "/__test/approve", {"user_code": code})
    assert approved == {"approved": True}, approved

    # 3. The key file lands where SDK-22 says, with the mode it says, and with a
    #    .gitignore beside it so it can never be committed by accident.
    key_file = tmp_path / ".aurival" / "machine.json"
    _wait_for(lambda: key_file.exists(), "the key file was never written")
    assert (key_file.stat().st_mode & 0o777) == 0o600
    assert (key_file.parent.stat().st_mode & 0o777) == 0o700
    assert (key_file.parent / ".gitignore").read_text().strip() == "*"
    saved = json.loads(key_file.read_text())
    assert set(saved) == {"seed", "bot", "machine", "host", "created"}
    assert saved["bot"] == testbed["bot"]

    # 4. Command sync landed, so the server routes /ping to this bot. `queued` is
    #    the honest signal: 0 means the emit fired nothing, and the invoke would
    #    otherwise look like an SDK failure.
    def invoked() -> dict[str, object] | None:
        result = _post(host, "/__test/invoke", {"chat": testbed["chat"], "text": "/ping"})
        return result if result.get("queued") == 1 else None

    invoke = _wait_for(
        invoked,
        "the invoke never queued an event — command sync did not land",
        alive=running_bot,
        diagnose=lambda: _diagnose(running_bot, testbed),
    )
    assert invoke["queued"] == 1

    # 5. pong, read back out of the chat.
    def answered() -> dict[str, object] | None:
        listing = _get(host, f"/__test/messages?chat={testbed['chat']}")
        for message in listing["data"]:
            if message["text"] == "pong" and message["sender"] != f"usr_{testbed['owner']}":
                return message
        return None

    reply = _wait_for(
        answered,
        "no pong arrived",
        alive=running_bot,
        diagnose=lambda: _diagnose(running_bot, testbed),
    )
    assert reply["text"] == "pong"

    # 6. And nothing in that whole transcript is a credential.
    assert saved["seed"] not in running_bot.transcript()
    assert "access_token" not in running_bot.transcript()


def _diagnose(bot: _Bot, testbed) -> str:
    """Everything a reader needs to tell an SDK bug from a dead process. Waiting
    out a 90s timeout and reporting only "no pong" says nothing about which."""
    exited = bot.proc.poll()
    err = ""
    if testbed.proc.stderr is not None:
        # Non-blocking: the testbed is still running, so this must not hang.
        os.set_blocking(testbed.proc.stderr.fileno(), False)
        try:
            err = testbed.proc.stderr.read() or ""
        except (OSError, ValueError):
            err = "(unreadable)"
    return (
        f"\nbot process: {'exited ' + str(exited) if exited is not None else 'still running'}"
        f"\n--- bot transcript ---\n{bot.transcript()}"
        f"\n--- testbed stderr (tail) ---\n{err[-2000:]}"
    )


def _wait_for(
    fn,
    message: str,
    timeout: float = 90.0,
    interval: float = 0.5,
    alive: _Bot | None = None,
    diagnose=None,
):
    deadline = time.monotonic() + timeout
    last: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            result = fn()
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            result = None
        if result:
            return result
        if alive is not None and alive.proc.poll() is not None:
            # Fail NOW rather than after the full timeout: a bot that raised is a
            # different bug from a bot that answered nothing, and waiting 90s to
            # report the second when it was the first is how an evening goes.
            raise AssertionError(
                f"{message}: the bot process exited{diagnose() if diagnose else ''}"
            )
        time.sleep(interval)
    detail = diagnose() if diagnose else ""
    raise AssertionError(f"{message} (last error: {last}){detail}")


def test_a_second_run_does_not_pair_again(testbed, tmp_path: Path) -> None:
    """ "Every later run just starts" is a promise in the README, and it is the
    whole point of the key file. Pair once, then start a second process in the
    same directory and assert it never prints a code."""
    script = tmp_path / "ping_bot.py"
    script.write_text(BOT_SOURCE)

    def spawn() -> _Bot:
        return _Bot(
            subprocess.Popen(
                [sys.executable, str(script)],
                cwd=tmp_path,
                env=bot_env(testbed, tmp_path),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        )

    first = spawn()
    try:
        code = first.read_until(CODE_RE)
        _post(testbed.host, "/__test/approve", {"user_code": code})
        key_file = tmp_path / ".aurival" / "machine.json"
        _wait_for(key_file.exists, "the key file was never written")
        saved = key_file.read_text()
    finally:
        first.proc.terminate()
        first.proc.wait(timeout=15)

    second = spawn()
    try:
        # Give it well past the point where the first run had already printed.
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            if CODE_RE.search(second.transcript()):
                raise AssertionError(f"the second run paired again:\n{second.transcript()}")
            time.sleep(0.5)
        assert key_file.read_text() == saved, "the second run rewrote the key file"
    finally:
        second.proc.terminate()
        second.proc.wait(timeout=15)
