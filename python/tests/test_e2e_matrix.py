"""The seamlessness matrix, S4 to S12, each against the real Go service.

These are the proofs the SDK plan claimed and nothing had run. Every one drives
a real bot process against a real `botapi.Server` on a real Postgres, and every
one announces a skip rather than passing when the DSN is absent — a suite that
reports green without reaching the service is the exact failure this testbed
exists to make impossible.

Each test takes its OWN testbed, so it gets its own owner, bot and playground
chat. That is not tidiness: `Store.Send` refuses a bot more than six messages
per ten minutes in one conversation, a suppressed send writes no row and still
answers 201, and a shared chat would therefore start failing partway down this
file in a way indistinguishable from a bot that stopped replying.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.conftest import Testbed

REPO = Path(__file__).resolve().parents[3]
SDK = REPO / "sdk" / "python"

CODE_RE = re.compile(r"pairing code\s+([0-9A-Z]{4}-[0-9A-Z]{4})")

# The bot every test runs unless it needs something special. `logging.DEBUG` so
# the socket's own `bye`/`problem` lines reach the transcript, which is what
# most of these tests read.
PING_BOT = """
import logging
from aurival import Bot

logging.basicConfig(level=logging.DEBUG)
bot = Bot()

@bot.command("ping", "Check that the bot is alive")
async def ping(ctx):
    await ctx.reply("pong")

bot.run()
"""


# --- driving the real thing -------------------------------------------------


def post(host: str, path: str, body: dict[str, object]) -> dict[str, object]:
    req = urllib.request.Request(
        host + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def get(host: str, path: str) -> dict[str, object]:
    with urllib.request.urlopen(host + path, timeout=15) as resp:
        return json.loads(resp.read())


class BotProcess:
    """A developer's bot, run the way a developer runs it.

    stdout is drained by a THREAD for the whole life of the process rather than
    read on demand: several tests assert on what happened during a window they
    were not watching (a reconnect, a redelivery), and on-demand reading would
    leave exactly those windows uncaptured.
    """

    def __init__(self, proc: subprocess.Popen[str], directory: Path) -> None:
        self.proc = proc
        self.directory = directory
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._eof = threading.Event()
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                with self._lock:
                    self._lines.append(line.rstrip("\n"))
        finally:
            self._eof.set()

    def transcript(self) -> str:
        with self._lock:
            return "\n".join(self._lines)

    def wait_for(self, pattern: str | re.Pattern[str], timeout: float = 60.0) -> str:
        """Block until a line matches, and fail with the whole transcript."""
        rx = re.compile(pattern) if isinstance(pattern, str) else pattern
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            drained = self._eof.is_set()
            match = rx.search(self.transcript())
            if match:
                return match.group(0)
            if drained and self.proc.poll() is not None:
                raise AssertionError(
                    f"the bot exited (code {self.proc.poll()}) while waiting for "
                    f"{rx.pattern!r}:\n{self.transcript()}"
                )
            time.sleep(0.1)
        raise AssertionError(f"timed out waiting for {rx.pattern!r}:\n{self.transcript()}")

    def count(self, pattern: str) -> int:
        return len(re.findall(pattern, self.transcript()))

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# Loader/toolchain variables a parent environment may need to hand its child
# interpreter so the interpreter can even START. `actions/setup-python`'s
# tool-cache CPython is built `--enable-shared`, so it needs `LD_LIBRARY_PATH`
# to find its own `libpython3.NN.so` — a system python (static, no such
# dependency) never surfaces the gap locally. None of these carry an
# event-allowlist or app secret, so passing them through does not reopen
# BA-R28/S14 (test_a_bot_gets_events_with_no_allowlist_anywhere_in_the_environment
# above): the scrub of `AURIVAL_*`/`BOT_*` parent state stays exactly as it was.
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


@pytest.fixture
def run_bot(tmp_path: Path) -> Callable[..., BotProcess]:
    """Start a bot process in its own directory, torn down at the end."""
    started: list[BotProcess] = []

    def start(bed: Testbed, source: str = PING_BOT, *, directory: Path | None = None) -> BotProcess:
        directory = directory or tmp_path / f"bot{len(started)}"
        directory.mkdir(parents=True, exist_ok=True)
        script = directory / "bot.py"
        script.write_text(source)
        proc = subprocess.Popen(
            [sys.executable, str(script)],
            cwd=directory,
            env=bot_env(bed, directory),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        bot = BotProcess(proc, directory)
        started.append(bot)
        return bot

    yield start
    for bot in started:
        bot.stop()


def test_bot_env_passes_through_the_loader_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """CI-2026-09: every python e2e bot died with exit code 127, `libpython3.10.so.1.0`
    not found. `actions/setup-python`'s tool-cache interpreter is `--enable-shared`
    and relies on `LD_LIBRARY_PATH`, which the old hand-built env dict dropped —
    invisible locally where the system python is static. This is the RED that
    fix pins: the loader variable must reach the child when the parent has it.
    """
    monkeypatch.setenv("LD_LIBRARY_PATH", "/opt/tool-cache/python/3.10.21/x64/lib")
    bed = SimpleNamespace(host="http://127.0.0.1:0")
    env = bot_env(bed, tmp_path)
    assert env["LD_LIBRARY_PATH"] == "/opt/tool-cache/python/3.10.21/x64/lib"


def test_bot_env_omits_the_loader_path_when_the_parent_has_none(tmp_path: Path) -> None:
    """The passthrough is conditional, not a blanket copy of the parent
    environment — no `LD_LIBRARY_PATH` key should appear from nowhere."""
    bed = SimpleNamespace(host="http://127.0.0.1:0")
    env = bot_env(bed, tmp_path)
    assert "LD_LIBRARY_PATH" not in env


def test_bot_env_never_leaks_an_event_allowlist_or_app_secret(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """BA-R28/S14 must hold through this change: the passthrough is a named
    allowlist, not a door for `AURIVAL_*`/`BOT_*` parent state to cross."""
    monkeypatch.setenv("BOT_EVENT_CONVERSATIONS", "chat_should_never_cross")
    monkeypatch.setenv("AURIVAL_TESTBED_SIGNING_KEY", "should-never-cross")
    bed = SimpleNamespace(host="http://127.0.0.1:0")
    env = bot_env(bed, tmp_path)
    assert "BOT_EVENT_CONVERSATIONS" not in env
    assert "AURIVAL_TESTBED_SIGNING_KEY" not in env
    assert env["AURIVAL_API"] == bed.host


def pair_and_approve(bed: Testbed, bot: BotProcess) -> None:
    """Read the code off stdout and approve it as the owner would in the app."""
    code = CODE_RE.search(bot.wait_for(CODE_RE, timeout=90))
    assert code, bot.transcript()
    approved = post(bed.host, "/__test/approve", {"user_code": code.group(1)})
    assert approved == {"approved": True}, approved


def wait_until(fn: Callable[[], object], message: str, timeout: float = 60.0) -> object:
    deadline = time.monotonic() + timeout
    last: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            result = fn()
        except (urllib.error.URLError, OSError) as exc:
            last, result = exc, None
        if result:
            return result
        time.sleep(0.4)
    raise AssertionError(f"{message} (last error: {last})")


def invoke(bed: Testbed, text: str = "/ping") -> dict[str, object]:
    """A real message from the owner, then the emit.

    `queued` is checked because 0 is this lane's silent failure: not
    events disabled, not a command, or no bot bound to the chat all return 200
    with nothing queued, and a caller that ignores it spends the evening blaming the
    SDK.
    """
    result = post(bed.host, "/__test/invoke", {"chat": bed["chat"], "text": text})
    assert result.get("queued") == 1, f"the invoke queued nothing: {result}"
    return result


def replies(bed: Testbed, text: str = "pong") -> list[dict[str, object]]:
    listing = get(bed.host, f"/__test/messages?chat={bed['chat']}")
    owner = f"usr_{bed['owner']}"
    return [m for m in listing["data"] if m["text"] == text and m["sender"] != owner]


def wait_for_reply(bed: Testbed, text: str = "pong", timeout: float = 60.0) -> dict[str, object]:
    found = wait_until(
        lambda: (replies(bed, text) or [None])[0], f"no {text!r} arrived in the chat", timeout
    )
    assert isinstance(found, dict)
    return found


def invoke_when_routed(bed: Testbed, bot: BotProcess, text: str = "/ping") -> dict[str, object]:
    """Retry the invoke until the server routes it.

    `queued` is 0 until the bot's command sync has landed, because the server
    routes by its own declared set and an undeclared command fires nothing
    (BotForCommand fails closed). That is a startup race, not a failure — the
    invoke is retried rather than the test sleeping a guessed interval.
    """
    deadline = time.monotonic() + 90
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        last = post(bed.host, "/__test/invoke", {"chat": bed["chat"], "text": text})
        if last.get("queued") == 1:
            return last
        if bot.proc.poll() is not None:
            raise AssertionError(f"the bot exited before command sync landed:\n{bot.transcript()}")
        time.sleep(0.5)
    raise AssertionError(
        f"the invoke never queued an event, so command sync never landed: {last}\n"
        f"{bot.transcript()}"
    )


def ready_bot(bed: Testbed, run_bot: Callable[..., BotProcess], **kwargs: object) -> BotProcess:
    """A paired, approved bot that has proved it is connected by answering."""
    bot = run_bot(bed, **kwargs)
    pair_and_approve(bed, bot)
    invoke_when_routed(bed, bot)
    wait_for_reply(bed)
    return bot


# --- S4: a real `server_restarting` -----------------------------------------


def test_s4_a_deploy_is_a_short_wait_not_a_failure(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """SIGTERM is what Fly sends on a deploy, and the whole point of BA-OI-32's
    fix is that a bot hears WHY.

    The distinction being measured is not cosmetic. A `bye` carrying
    `server_restarting` tells the SDK to wait once, 1-5s, and come back; a bare
    close tells it a network fault happened and to escalate a backoff toward a
    minute. Same socket, same close code (there are none in this API), entirely
    different behaviour — and until the testbed drained its sockets in the right
    order, every SDK test of a deploy was silently measuring the second.
    """
    # A STABLE SIGNING KEY ACROSS THE RESTART, because that is what a deploy is.
    # BOT_TOKEN_SIGNING_KEY is a Fly secret and survives a release, so a bot's
    # unexpired token is still valid against the new process. Letting the testbed
    # roll a fresh key would answer `access_token_invalid` to the reconnect and
    # the SDK would raise — correctly — and this test would be measuring the
    # harness instead of the deploy. (Measured: without this, the bot reads the
    # bye and never comes back.)
    signing = "s4-deploy-signing-key-that-is-long-enough-000000"
    bed = testbed_factory(AURIVAL_TESTBED_SIGNING_KEY=signing)
    bot = ready_bot(bed, run_bot)
    address = bed["addr"]

    bed.proc.send_signal(signal.SIGTERM)
    bot.wait_for(r"bot-api bye: server_restarting", timeout=30)
    assert bed.proc.wait(timeout=15) == 0, "the testbed did not shut down cleanly"

    # STILL ALIVE is necessary and NOT SUFFICIENT, which is the whole reason the
    # service comes back below. `server_restarting` is an api_error and the SDK
    # reconnects on its own, so a bot that merely has not exited yet is
    # indistinguishable from one stuck in a reconnect loop that never completes.
    assert bot.proc.poll() is None, (
        f"the bot exited on a deploy instead of waiting to reconnect:\n{bot.transcript()}"
    )

    # THE SAME ADDRESS AND THE SAME DATABASE — a deploy, not a new service. The
    # bot's key, its command rows and its chat are all in Postgres, so the
    # replacement process authenticates the same machine; only the token signing
    # key differs, and the SDK re-signs an assertion to get a new token, which is
    # exactly what a real rolling deploy makes it do.
    #
    # No event allowlist is carried across, and none is needed: BA-R28 retired
    # BOT_EVENT_CONVERSATIONS, so the replacement emits for the original chat
    # because that chat contains a bot.
    replacement = testbed_factory(
        AURIVAL_TESTBED_ADDR=address,
        AURIVAL_TESTBED_SIGNING_KEY=signing,
    )

    # AND IT ANSWERS AGAIN. This is the assertion that separates "reconnected"
    # from "did not crash": nothing else in this test can tell them apart.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        result = post(
            replacement.host, "/__test/invoke", {"chat": bed["chat"], "text": "/ping"}
        )
        if result.get("queued") == 1:
            break
        assert bot.proc.poll() is None, f"the bot died while reconnecting:\n{bot.transcript()}"
        time.sleep(1)
    else:
        raise AssertionError(f"the replacement never queued an event:\n{bot.transcript()}")

    listing = get(replacement.host, f"/__test/messages?chat={bed['chat']}")
    before = len([m for m in listing["data"] if m["text"] == "pong"])

    def answered_again() -> bool:
        rows = get(replacement.host, f"/__test/messages?chat={bed['chat']}")["data"]
        return len([m for m in rows if m["text"] == "pong"]) > before

    wait_until(
        answered_again,
        f"the bot never answered after the deploy, so it read `server_restarting` and then "
        f"failed to come back:\n{bot.transcript()}",
        timeout=120,
    )


# --- S5: a real access token expiring on a live socket ----------------------


def test_s5_a_token_expiring_mid_session_is_invisible_to_the_developer(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """Every healthy bot meets this every fifteen minutes in production.

    The server closes the socket at its own token's `exp` regardless of what the
    client believes (gateway.go:432-443), so this is not a client-side timer
    being tested: the bye really arrives. The SDK must re-sign, exchange and
    reconnect IMMEDIATELY with no backoff, and the developer's bot must keep
    answering across it.

    75 seconds, not 15 minutes: AURIVAL_TESTBED_TOKEN_TTL exists for this. It is
    above the SDK's own 60s refresh headroom on purpose — below it the client
    would re-exchange before every call and this would be testing the proactive
    path while claiming to test expiry (the testbed refuses such a value).
    """
    bed = testbed_factory(AURIVAL_TESTBED_TOKEN_TTL="75")
    bot = ready_bot(bed, run_bot)

    bot.wait_for(r"bot-api bye: access_token_expired", timeout=150)

    # THE PROOF IS THAT IT STILL WORKS, not that a line was logged. A reconnect
    # that fails leaves the same line in the transcript.
    assert bot.proc.poll() is None, f"the bot exited on token expiry:\n{bot.transcript()}"
    invoke(bed, "/ping")
    wait_until(
        lambda: len(replies(bed)) >= 2,
        "the bot did not answer after its token expired and it reconnected",
        timeout=60,
    )


# --- S6: two machines, one bot ----------------------------------------------


def test_s6_a_second_machine_supersedes_the_first(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """One bot, two paired machines, one live socket.

    `session_superseded` is an invalid_request_error and the SDK must RAISE:
    another process is running this bot, and reconnecting on our own would be
    two processes fighting for one socket, each kicking the other off forever.
    """
    bed = testbed_factory()
    first = ready_bot(bed, run_bot)

    # A second machine, paired to the same bot — /__test/approve binds whatever
    # code it is given to the seeded bot.
    second = run_bot(bed)
    pair_and_approve(bed, second)

    first.wait_for(r"bot-api bye: session_superseded", timeout=60)
    # The loser stops rather than fighting for the socket.
    wait_until(
        lambda: first.proc.poll() is not None,
        f"the superseded bot kept running:\n{first.transcript()}",
        timeout=30,
    )

    # And the winner is a working bot, not merely a connected one.
    invoke(bed)
    wait_for_reply(bed)
    assert second.proc.poll() is None


# --- S7: revocation --------------------------------------------------------


def test_s7_a_revoked_key_stops_the_bot_and_names_the_file_to_delete(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """Revoking a machine is what an owner does after losing a laptop, so it has
    to actually stop the bot — and then tell whoever restarts it what to do.

    The second half is the one that was missing. `key_revoked`'s server sentence
    is correct and useless on its own: the only fix is deleting a key file whose
    path the developer has probably never typed.
    """
    bed = testbed_factory()
    bot = ready_bot(bed, run_bot)

    machine = json.loads((bot.directory / ".aurival" / "machine.json").read_text())["machine"]
    revoked = post(bed.host, "/__test/revoke", {"machine": machine})
    assert revoked["machine"]["revoked_at"], f"the revoke did not take: {revoked}"

    wait_until(
        lambda: bot.proc.poll() is not None,
        f"a revoked key did not stop the bot:\n{bot.transcript()}",
        timeout=60,
    )
    transcript = bot.transcript()
    assert "key_revoked" in transcript, transcript

    # THE PATH, IN THE MESSAGE, ON THE RESTART. The key file is still there, so
    # a second run meets the same wall — and that is the run that must explain.
    again = run_bot(bed, directory=bot.directory)
    again.wait_for(r"machine\.json", timeout=60)
    assert "Remove" in again.transcript(), (
        f"the restart did not name the key file to remove:\n{again.transcript()}"
    )


# --- S8: suspend and unsuspend ----------------------------------------------


def test_s8_suspending_a_bot_stops_it_and_unsuspending_lets_it_back(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """`bot_suspended` is a permission_error: the SDK raises rather than
    reconnecting, because a suspended bot reconnecting in a loop is a bot
    arguing with a moderator."""
    bed = testbed_factory()
    bot = ready_bot(bed, run_bot)

    suspended = post(bed.host, "/__test/suspend", {"suspended": True})
    assert suspended["suspended"] is True, f"the suspend did not take: {suspended}"

    wait_until(
        lambda: bot.proc.poll() is not None,
        f"a suspended bot kept running:\n{bot.transcript()}",
        timeout=60,
    )
    assert "bot_suspended" in bot.transcript(), bot.transcript()

    # UNSUSPENDING HAS TO BE REVERSIBLE IN PRACTICE, not just in the column. The
    # same key file, restarted, must be a working bot again.
    restored = post(bed.host, "/__test/suspend", {"suspended": False})
    assert restored["suspended"] is False, restored

    again = run_bot(bed, directory=bot.directory)
    invoke(bed)
    wait_until(
        lambda: len(replies(bed)) >= 2, "an unsuspended bot never answered again", timeout=60
    )
    assert again.proc.poll() is None


# --- S9: a frozen process past the idle reap --------------------------------


def test_s9_a_frozen_bot_reconnects_and_loses_nothing(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """SIGSTOP is the honest way to simulate a process that stopped answering:
    a GC pause, a blocking call in a handler, a suspended container.

    THE ARITHMETIC, STATED so a future config change cannot erode it silently:
    the testbed sets HeartbeatMS = 2000 and the service's read deadline is
    `HeartbeatMS * socketIdleFactor` with a factor of 3 (limits.go), so the reap
    lands at 6s. The freeze is 15s — a 9s margin, and driven by a TCP read
    deadline rather than a sleep race, so a loaded machine does not shorten it.

    What is asserted afterwards is the OUTCOME rather than the frame: whether
    the `bye` is still readable off a socket reaped while the process was
    stopped depends on TCP buffering, but the event invoked during the freeze
    must arrive, and must arrive once.
    """
    bed = testbed_factory()
    bot = ready_bot(bed, run_bot)

    bot.proc.send_signal(signal.SIGSTOP)
    time.sleep(15)
    # Queued while the bot is frozen — it cannot possibly have acked this.
    invoke(bed, "/ping")
    time.sleep(2)
    bot.proc.send_signal(signal.SIGCONT)

    wait_until(
        lambda: len(replies(bed)) >= 2,
        f"the bot never answered the event queued while it was frozen:\n{bot.transcript()}",
        timeout=90,
    )
    assert bot.proc.poll() is None, f"the bot died on the idle reap:\n{bot.transcript()}"

    # EXACTLY ONCE — as a regression net on the reconnect path, and stated
    # honestly rather than over-claimed.
    #
    # MEASURED: deleting the SDK's seen-set leaves this test GREEN. On this
    # timeline the frozen socket is reaped before the event is ever delivered,
    # so the event arrives once on the new connection, runs once and is acked
    # once — the dedupe never engages, and a comment here claiming this proves
    # it would be describing a check that cannot fail. The seen-set is proven
    # instead by `test_socket.py`'s duplicate-id and stale-ack tests, both of
    # which do go red when it is removed. What this line does catch is the
    # double delivery a broken reconnect would produce.
    time.sleep(5)
    assert len(replies(bed)) == 2, (
        f"expected exactly two pongs (one per invoke), got {len(replies(bed))}. A redelivered "
        f"event was handled twice:\n{bot.transcript()}"
    )


# --- S10: a rate-limited command sync ---------------------------------------


def test_s10_a_rate_limited_sync_does_not_take_the_bot_offline(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """SDK-35, and the reasoning is the whole point: command rows are DURABLE.

    `SyncPerHour` is 60. Burn the budget, then start a bot. Raising would be the
    crash loop ERRORS-V1 §5 names, and waiting would be an hour offline for
    nothing (the 429's Retry-After is a fixed 60s default, not the time to the
    rolling window clearing). So it connects with what the server already has
    and retries the sync in the background — and it must ANSWER while doing so.
    """
    bed = testbed_factory()
    # Pair a machine and get a token the ordinary way, then spend the budget
    # over the real HTTP lane rather than by restarting 61 processes.
    primer = run_bot(bed)
    pair_and_approve(bed, primer)
    invoke_when_routed(bed, primer)
    wait_for_reply(bed)
    key = json.loads((primer.directory / ".aurival" / "machine.json").read_text())
    primer.stop()

    burned = _burn_sync_budget(bed, key, attempts=70)
    assert burned, "never provoked sync_rate_limited, so this proves nothing about SDK-35"

    bot = run_bot(bed, directory=primer.directory)
    bot.wait_for(r"command sync is rate limited", timeout=60)

    # THE PROMISE IS THAT IT STILL WORKS. The command rows from the primer's own
    # sync are durable, so the server still routes /ping to this bot.
    invoke(bed)
    wait_until(
        lambda: len(replies(bed)) >= 2,
        f"a rate-limited sync took the bot offline:\n{bot.transcript()}",
        timeout=60,
    )
    assert bot.proc.poll() is None


def _burn_sync_budget(bed: Testbed, key: dict[str, str], *, attempts: int) -> bool:
    """Drive PUT /v1/bots/{bot}/commands until the server answers
    `sync_rate_limited`. Uses the SDK's own auth so nothing here re-implements
    assertion signing."""
    sys.path.insert(0, str(SDK))
    import asyncio

    import aiohttp

    from aurival import auth as auth_mod
    from aurival.errors import RateLimitError
    from aurival.http import HttpClient

    async def burn() -> bool:
        machine_key = auth_mod.MachineKey.from_seed_b64(key["seed"])
        machine = auth_mod.Machine(
            bot=key["bot"], machine=key["machine"], host=bed.host, created=key["created"]
        )
        async with aiohttp.ClientSession() as session:
            unauth = HttpClient(session, bed.host)
            a = auth_mod.Auth(unauth, machine_key, machine)
            http = HttpClient(session, bed.host, a)
            for _ in range(attempts):
                try:
                    await http.sync_commands(
                        machine.bot,
                        [{"name": "ping", "description": "Check that the bot is alive"}],
                    )
                except RateLimitError:
                    return True
            return False

    return asyncio.run(burn())


# --- S11: conflicts surfaced at sync ----------------------------------------


def test_s11_a_shadowed_command_is_reported_with_the_chat_that_shadows_it(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """The developer whose command silently never fires is `conflicts`' named
    consumer, and BOTH SDKs dropped the field on the floor.

    A conflict cannot be manufactured client-side: it needs a second bot, in
    this chat, holding this command name — three rows only an owner can create.
    `/__test/shadow` is that owner, and it returns the server's own conflict
    count so a run that seeded nothing cannot be mistaken for an SDK that
    reported nothing.
    """
    bed = testbed_factory()

    # THE REAL BOT SYNCS FIRST, AND THE ORDER IS LOAD-BEARING. ConflictsFor
    # joins the syncing bot's OWN command rows against other bots' — with no
    # rows of its own there is nothing to shadow, so a shadow created before the
    # first sync produces a conflict count of zero and the whole test would then
    # be asserting against an empty fixture.
    first = ready_bot(bed, run_bot)
    directory = first.directory
    first.stop()

    shadow = post(bed.host, "/__test/shadow", {"command": "ping"})
    assert shadow["conflicts"] >= 1, (
        f"the testbed did not actually create a conflict ({shadow}), so a silent SDK and a "
        "working one would look identical here. This is the server's own ConflictsFor answer, "
        "not our guess about it"
    )

    # Same key file, so this is the same machine syncing again — and this time
    # the server's response carries the conflict.
    bot = run_bot(bed, directory=directory)

    # One warning line, naming the command and the chat it is shadowed in.
    bot.wait_for(r"is shadowed in chat chat_", timeout=60)
    line = next(
        (ln for ln in bot.transcript().splitlines() if "is shadowed in chat" in ln), None
    )
    assert line is not None, f"the warning vanished between reads:\n{bot.transcript()}"
    assert "'ping'" in line or '"ping"' in line, line
    assert bed["chat"] in line, f"the warning does not name the chat: {line!r}"

    # A CONFLICT IS A DIAGNOSTIC, NOT A FAILURE. The bot still starts.
    assert bot.proc.poll() is None, bot.transcript()


# --- S12: a handler slower than RedeliverAfter ------------------------------


SLOW_BOT = """
import asyncio, logging
from aurival import Bot

logging.basicConfig(level=logging.DEBUG)
bot = Bot()

@bot.command("ping", "Check that the bot is alive")
async def ping(ctx):
    await asyncio.sleep(35)
    await ctx.reply("pong")

bot.run()
"""


def test_s12_a_handler_slower_than_redelivery_still_answers_once(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """`RedeliverAfter` is 30 seconds and an event is acked only AFTER its
    handler returns, so a 35-second handler is guaranteed to see its own event
    delivered a second time while the first call is still running.

    SDK-27 is what makes that survivable: dedupe on event id, and never dispatch
    an id whose handler is in flight. Without it the developer's handler runs
    twice and the chat gets two answers — from code that looks perfectly correct.
    """
    bed = testbed_factory()
    bot = run_bot(bed, SLOW_BOT)
    pair_and_approve(bed, bot)
    # Give the sync and the socket time to settle before the one invoke.
    time.sleep(6)

    invoke(bed, "/ping")
    wait_for_reply(bed, timeout=120)

    # Well past a second RedeliverAfter window, so a duplicate has had every
    # chance to appear.
    time.sleep(35)
    assert len(replies(bed)) == 1, (
        f"a 35s handler answered {len(replies(bed))} times. The event was redelivered at 30s and "
        f"dispatched again while the first handler was still running:\n{bot.transcript()}"
    )
    assert bot.proc.poll() is None


def test_a_bot_gets_events_with_no_allowlist_anywhere_in_the_environment(
    testbed_factory: Callable[..., Testbed], run_bot: Callable[..., BotProcess]
) -> None:
    """BA-R28 / S14. Events flow for any chat containing a bot, and the
    hand-maintained `BOT_EVENT_CONVERSATIONS` allowlist is gone.

    THE VARIABLE IS ASSERTED ABSENT FROM THE WHOLE ENVIRONMENT, not merely left
    unset by this test. The testbed used to write it itself, so a suite that
    only refrained from passing it would still have been running against a
    process that set it internally — proving nothing about the production path,
    where no such secret is edited. That dead write is now gone, and this is
    what stops it coming back: a real bot, answering, with the variable nowhere.
    """
    assert "BOT_EVENT_CONVERSATIONS" not in os.environ, (
        "the test environment itself names an event allowlist, so this proves nothing about a "
        "bot that has no secret edited for it"
    )
    bed = testbed_factory()
    ready_bot(bed, run_bot)
    assert len(replies(bed)) == 1


def test_the_matrix_ran_against_a_real_service(testbed_factory: Callable[..., Testbed]) -> None:
    """A guard on the file itself.

    Every test above skips as a group when the DSN is absent, which is correct —
    but "the matrix is green" must never be readable off a run where nothing
    started. This asserts the service really answered.
    """
    bed = testbed_factory()
    assert os.environ.get("MIGRATE_TEST_DATABASE_URL")
    assert bed["bot"].startswith("bot_") and bed["chat"].startswith("chat_")
    listing = get(bed.host, f"/__test/messages?chat={bed['chat']}")
    assert listing["data"] == []
