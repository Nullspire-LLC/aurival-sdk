"""The developer-facing surface: declare commands, call run(), we hold the socket."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import signal
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import aiohttp

from .auth import Auth, KeyFile, machine_label, pair, resolve_host
from .errors import AurivalAPIError, AurivalError, KeyRevoked, RateLimitError
from .events import Command, Context, Event
from .http import DEFAULT_HOST, HttpClient
from .socket import Socket

Handler = Callable[[Context], Awaitable[None]]
# The hook also receives a `backlog.overflowed` Event, which is operational
# rather than an exception — it never reaches a handler (SDK-28).
Reportable = BaseException | Event
ErrorHook = Callable[[Reportable, Context | None], Awaitable[None] | None]

# How long a clean shutdown waits for handlers that are still running (SDK-32).
SHUTDOWN_GRACE_SECONDS = 10.0

_log = logging.getLogger("aurival")


@dataclass
class _Registered:
    command: Command
    handler: Handler


class Bot:
    """A bot. Register commands, then `run()`.

    First run pairs this machine: it prints a code, you approve it in the app, and
    the key lands in ./.aurival/. Every later run just starts.
    """

    def __init__(
        self,
        *,
        host: str | None = None,
        key_path: str | Path | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._registered: dict[str, _Registered] = {}
        self._error_hook: ErrorHook | None = None
        self._log = logger or _log
        self._host = host
        self._key_path = Path(key_path) if key_path is not None else None
        self._auth: Auth | None = None
        self._http: HttpClient | None = None
        self._inflight: set[asyncio.Task[None]] = set()

    # -- registration ------------------------------------------------------

    def command(self, name: str, description: str = "") -> Callable[[Handler], Handler]:
        """Declare a command. The name is sent as written — the server is the
        validator (SDK-29), and it lowercases and trims before it checks."""

        def decorate(fn: Handler) -> Handler:
            self._registered[self._lookup_key(name)] = _Registered(
                command=Command(name=name, description=description), handler=fn
            )
            return fn

        return decorate

    def on_error(self, fn: ErrorHook) -> ErrorHook:
        """Called with (error, context | None) for anything the SDK caught for you:
        a handler that raised, a `problem` frame, a backlog overflow."""
        self._error_hook = fn
        return fn

    @staticmethod
    def _lookup_key(name: str) -> str:
        # Mirrors the server's own normalisation (commands.go) so `Ping` finds the
        # handler for the `ping` that comes back on the wire. Not validation.
        return name.strip().lower()

    # -- running -----------------------------------------------------------

    def run(self) -> None:
        """Blocks until SIGINT/SIGTERM, or until something fatal happens."""
        try:
            asyncio.run(self.start())
        except KeyboardInterrupt:
            pass

    async def start(self) -> None:
        host = self._host or resolve_host()
        if host != DEFAULT_HOST:
            # Printed, not logged: a redirected host is the first thing to check
            # when nothing works, and a logger set to WARNING would hide it.
            print(f"aurival: using {host}", file=sys.stdout, flush=True)

        stop = asyncio.Event()
        async with aiohttp.ClientSession() as session:
            unauth = HttpClient(session, host, logger=self._log)
            key_file = KeyFile(self._key_path)
            loaded = key_file.load()
            if loaded is None:
                key, machine = await pair(
                    unauth, machine_label=machine_label(), host=host, logger=self._log
                )
                key_file.save(key, machine)
            else:
                key, machine = loaded

            auth = Auth(unauth, key, machine, logger=self._log)
            http = HttpClient(session, host, auth, logger=self._log)
            self._auth, self._http = auth, http

            # S7. THE WHOLE AUTHENTICATED STARTUP IS COVERED, not just the socket.
            #
            # A revoked key is met by the FIRST authenticated call, and on a
            # restart that is the command sync's token exchange — long before
            # any socket is opened (`/v1/token` answers `key_revoked` directly,
            # server.go:612-616). Wrapping only `socket.run` left the common
            # case, a developer restarting a bot whose machine was revoked
            # yesterday, raising the bare server sentence.
            sync_task: asyncio.Task[None] | None = None
            try:
                sync_task = await self._sync_commands(http, machine.bot)
                self._install_signal_handlers(stop)

                socket = Socket(
                    http,
                    auth,
                    dispatch=self._dispatch,
                    on_problem=self._on_problem,
                    logger=self._log,
                )
                await socket.run(stop)
            except KeyRevoked as exc:
                # The server's sentence is correct and useless on its own: the
                # developer is looking at a process that will not start, and the
                # only fix is deleting a file whose path they have probably
                # never typed (`./.aurival/machine.json` by default, or wherever
                # AURIVAL_KEY_PATH pointed). Naming it turns a dead end into one
                # command. Re-raised as the same class so `except KeyRevoked`
                # keeps working, and carrying the wire fields rather than a
                # re-worded string.
                raise KeyRevoked(
                    type=exc.type,
                    code=exc.code,
                    message=(
                        f"{exc.message} This machine's key was revoked. Remove "
                        f"{key_file.path} and run again to pair a new machine."
                    ),
                    doc_url=exc.doc_url,
                    request_id=exc.request_id,
                    retry_after=exc.retry_after,
                    status=exc.status,
                ) from None
            finally:
                if sync_task is not None:
                    sync_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await sync_task
                await self._drain_handlers()

    def _install_signal_handlers(self, stop: asyncio.Event) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, RuntimeError):
                # Windows, or a loop that will not take handlers. run() still
                # unwinds on KeyboardInterrupt.
                pass

    async def _drain_handlers(self) -> None:
        """A bounded wait, then go anyway. A clean close earns no `bye`, correctly."""
        if not self._inflight:
            return
        _, still_running = await asyncio.wait(list(self._inflight), timeout=SHUTDOWN_GRACE_SECONDS)
        for task in still_running:
            task.cancel()

    # -- command sync ------------------------------------------------------

    async def _sync_commands(self, http: HttpClient, bot: str) -> asyncio.Task[None] | None:
        """Sync on every run. A rate limit does NOT take the bot offline (SDK-35):
        command rows are durable, so we connect with whatever the server already
        has and land the sync in the background."""
        payload = [
            {"name": r.command.name, "description": r.command.description}
            for r in self._registered.values()
        ]
        try:
            self._report_conflicts(await http.sync_commands(bot, payload))
            return None
        except RateLimitError as exc:
            self._log.warning(
                "command sync is rate limited (%s); connecting with the server's current "
                "set and retrying in the background",
                exc.code,
            )
            return asyncio.create_task(self._retry_sync(http, bot, payload, exc))

    async def _retry_sync(
        self,
        http: HttpClient,
        bot: str,
        payload: list[dict[str, str]],
        first: RateLimitError,
    ) -> None:
        delay = first.retry_after or 60.0
        while True:
            await asyncio.sleep(delay)
            try:
                resp = await http.sync_commands(bot, payload)
            except RateLimitError as exc:
                delay = exc.retry_after or 60.0
                continue
            except AurivalError:
                self._log.exception("command sync failed")
                return
            print("aurival: command sync landed", file=sys.stdout, flush=True)
            # REPORTED HERE TOO, not only on the first-attempt path. A bot that
            # started rate limited is exactly the one whose sync landed out of
            # sight, and dropping the diagnosis on this branch would mean the
            # conflict is silent precisely when nobody was watching.
            self._report_conflicts(resp)
            return

    def _report_conflicts(self, response: dict) -> None:
        """S11. One warning per shadowed chat, naming the command and the chat.

        A conflict is the server telling us this command will NEVER FIRE in that
        chat because another bot already holds the name — the sync succeeded,
        the rows are stored, and the handler is simply dead there. Dropping this
        (both SDKs did) leaves the developer with a bot that works in one chat
        and is inert in another, with nothing anywhere to read. It is a warning
        rather than an error because the rest of the sync is fine.
        """
        data = response.get("data")
        if not isinstance(data, list):
            return
        for entry in data:
            if not isinstance(entry, dict):
                continue
            conflicts = entry.get("conflicts")
            # `[]` is the normal answer and means no conflict — §2.1 makes the
            # field always present, so absence is a server we do not understand
            # rather than "none", and either way there is nothing to report.
            if not isinstance(conflicts, list):
                continue
            name = entry.get("name")
            for chat in conflicts:
                self._log.warning(
                    "command %r is shadowed in chat %s by another bot's command with the "
                    "same name, and will never fire there",
                    name,
                    chat,
                )

    # -- dispatch ----------------------------------------------------------

    async def _dispatch(self, event: Event) -> None:
        """One event. Runs the handler, never lets it take the bot down (SDK-16).

        Note what is NOT in this frame: no key, no seed, no token. A crash
        reporter capturing locals here has nothing to capture.
        """
        if event.type != "command.invoked":
            return
        # The socket runs each handler in its own task; registering it here is what
        # lets shutdown wait for the ones still going (SDK-32).
        running = asyncio.current_task()
        if running is not None:
            self._inflight.add(running)
            running.add_done_callback(self._inflight.discard)
        data = event.data
        name = str(data.get("command", ""))
        registered = self._registered.get(self._lookup_key(name))
        if registered is None:
            # The server routes by its own declared set, so this is a stale sync
            # or a name we just removed. Not an error.
            self._log.debug("no handler for command %r", name)
            return

        assert self._http is not None
        ctx = Context.from_event(event, http=self._http)
        try:
            await registered.handler(ctx)
        # One bad command must not take the bot offline (SDK-16).
        except Exception as exc:
            self._log.exception("handler for %r raised", name)
            await self._call_error_hook(exc, ctx)

    def _on_problem(self, error: AurivalAPIError | Event) -> None:
        task = asyncio.create_task(self._call_error_hook(error, None))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _call_error_hook(self, error: Reportable, ctx: Context | None) -> None:
        if self._error_hook is None:
            return
        try:
            result = self._error_hook(error, ctx)
            if inspect.isawaitable(result):
                await result
        # An error hook that raises is not an outage either.
        except Exception:
            self._log.exception("error hook raised")
