"""The developer-facing surface: declare commands, call run(), we hold the socket."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import math
import signal
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, overload

import aiohttp

from . import events as _events
from .auth import Auth, KeyFile, machine_label, pair, resolve_host
from .caps import CAP_TOO_MANY_ALIASES, COOLDOWN_COMMAND_NOTICE, MAX_ALIASES_PER_COMMAND
from .cooldown import UNSET, Cooldown, CooldownSpec, resolve_subject, validate_button_cooldown
from .errors import (
    AurivalAPIError,
    AurivalError,
    BotSuspended,
    ButtonAlreadyUsed,
    KeyRevoked,
    NotFound,
    RateLimitError,
    SessionSuperseded,
)
from .events import (
    AnyContext,
    BotContext,
    BotEventType,
    ButtonContext,
    ButtonEventType,
    Command,
    Context,
    Event,
    EventContext,
    MemberContext,
    MemberEventType,
    ReactionContext,
    ReactionEventType,
    context_for,
)
from .http import DEFAULT_HOST, HttpClient
from .socket import Socket
from .status import StatusReporter

# ERRORS-V1 has nothing to do with this cap — it never reaches the server. A
# sync past this size is refused server-side too (SyncCommands, backend-go),
# but catching it here means a bot author sees this line instead of a 400
# deep inside a sync call, and before we have made any network call at all.
MAX_COMMANDS = 50

Handler = Callable[[Context], Awaitable[None]]
MemberHandler = Callable[[MemberContext], Awaitable[None]]
BotHandler = Callable[[BotContext], Awaitable[None]]
ReactionHandler = Callable[[ReactionContext], Awaitable[None]]
ButtonHandler = Callable[[ButtonContext], Awaitable[None]]
EventHandler = Callable[[EventContext], Awaitable[None]]
# What the registry stores: every `on()` handler, whatever context class its
# overload promised it. `Any` because the overloads are the typed door and the
# registry is behind it — and because the plain-`str` overload has to accept
# any handler at all, or the checker reports it as overlapping the typed ones.
_AnyHandler = Callable[[Any], Awaitable[None]]
# The hook also receives a `backlog.overflowed` Event, which is operational
# rather than an exception — it never reaches a handler (SDK-28).
Reportable = BaseException | Event
ErrorHook = Callable[[Reportable, AnyContext | None], Awaitable[None] | None]

# AMENDMENT-08 §4: `(ctx, retry_after)` — the context the handler would have
# received, and the seconds remaining as a float. Registered bot-level via
# `@bot.on_cooldown`, or per-command via `bot.command(..., on_cooldown=)`;
# per-command wins, only one ever runs. There is no third door: `command()`
# returns the handler function unchanged, nothing is attached to it.
CooldownHook = Callable[[Context, float], Awaitable[None] | None]

# How long a clean shutdown waits for handlers that are still running (SDK-32).
SHUTDOWN_GRACE_SECONDS = 10.0

_log = logging.getLogger("aurival")


@dataclass
class _Registered:
    command: Command
    handler: Handler
    cooldown: Cooldown | None = None
    on_cooldown: CooldownHook | None = None


# How long a command handler runs before the chat is told the bot is thinking
# (SDK-41). Long enough that an ordinary reply never trips it, short enough
# that a slow one reads as work in progress rather than silence.
_AUTO_TYPING_DELAY_S = 0.3

# AMENDMENT-08 §11: the one event type `_has_event_handler` always claims,
# whether or not the developer registered anything for it.
EVENT_BUTTON_PRESSED = "button.pressed"


class _AutoTyping:
    """The per-dispatch state of the auto-typing timer."""

    task: asyncio.Task[None] | None = None
    armed: bool = False
    sent: bool = False


class Bot:
    """A bot. Register commands, then `run()`.

    First run pairs this machine: it prints a code, you approve it in the app, and
    the key lands in ./.aurival/. Every later run just starts.

    `button_cooldown` (AMENDMENT-08 §3) is the bot-wide default every button
    cooldown inherits unless a card or a button names its own — tri-state:
    leave it unset for the owner's default (one press per two seconds per
    user per bot, `Cooldown(1, 2.0, "user")`, no configuration required),
    pass `None` to disable button cooldowns for this bot entirely, or pass a
    `Cooldown` (bounded to 60 seconds, validated here at construction).

    **Buckets are process memory** — see `cooldown.py`'s module docstring.
    This default's counts reset whenever the bot process restarts, and two
    replicas behind a supervisor keep two independent counts; nothing here
    is shared across `Bot` instances or across processes.
    """

    # A convenience alias so `Bot.Context` resolves for a developer who only
    # imported `Bot` — the annotated signature everywhere else in the docs is
    # still `from aurival import Bot, Context`, this is a fallback, not the
    # taught path. Annotated through the module so the class-body name does
    # not shadow the type in the method signatures below.
    Context: ClassVar[type[_events.Context]] = _events.Context

    # Same reasoning as `Context` above: `Bot.Message` resolves for a
    # developer who only imported `Bot`, without requiring a second import.
    Message: ClassVar[type[_events.Message]] = _events.Message

    def __init__(
        self,
        *,
        host: str | None = None,
        key_path: str | Path | None = None,
        logger: logging.Logger | None = None,
        quiet: bool = False,
        auto_typing: bool = True,
        button_cooldown: CooldownSpec = UNSET,
    ) -> None:
        self._registered: dict[str, _Registered] = {}
        # Auto-typing (SDK-41): a command handler still running after
        # _AUTO_TYPING_DELAY_S shows the chat "is thinking", and the indicator
        # is cleared when the handler returns. A handler that replies inside
        # the delay sends nothing, so a fast bot never flickers. `False` keeps
        # typing entirely in the developer's hands (`async with ctx.typing()`).
        self._auto_typing = auto_typing
        self._event_handlers: dict[str, list[_AnyHandler]] = {}
        self._error_hook: ErrorHook | None = None
        self._cooldown_hook: CooldownHook | None = None
        self._log = logger or _log
        self._host = host
        self._key_path = Path(key_path) if key_path is not None else None
        self._auth: Auth | None = None
        self._http: HttpClient | None = None
        self._inflight: set[asyncio.Task[None]] = set()
        self._status = StatusReporter(quiet=quiet)
        # AMENDMENT-08 §3: the owner's default is one press per two seconds
        # per user per bot, on every bot, with no line of code — so `UNSET`
        # (the caller never passed the keyword) resolves to that `Cooldown`,
        # one fresh instance per `Bot`, never shared. `None` disables it
        # entirely for this bot; a `Cooldown` the caller passed is bounded to
        # 60 seconds here, at attachment, same as every other button cooldown.
        #
        # Buckets are process memory — see `cooldown.py`'s module docstring —
        # so this default's counts reset whenever the bot process restarts,
        # and two replicas behind a supervisor keep two independent counts.
        if button_cooldown is UNSET:
            self._button_cooldown_default: Cooldown | None = Cooldown(1, 2.0, "user")
        else:
            if button_cooldown is not None:
                validate_button_cooldown(button_cooldown)
            self._button_cooldown_default = button_cooldown

    # -- registration ------------------------------------------------------

    def command(
        self,
        name: str,
        description: str = "",
        *,
        aliases: Sequence[str] | None = None,
        cooldown: Cooldown | None = None,
        on_cooldown: CooldownHook | None = None,
    ) -> Callable[[Handler], Handler]:
        """Declare a command. The name is sent as written — the server is the
        validator (SDK-29), and it lowercases and trims before it checks.

        `aliases` (AMENDMENT-09 §2.1) names other ways to call this command —
        one handler, several spellings. Each token obeys exactly the rules a
        name obeys, and the server is the validator there too (the same
        `invalid_command_name` a bad name gets). The only check made here,
        locally, before any network call, is the count: more than
        `MAX_ALIASES_PER_COMMAND` raises with `caps.CAP_TOO_MANY_ALIASES`,
        the same local-cap style `Bot.start()`'s `MAX_COMMANDS` check uses.
        A handler registered with aliases still fires on `ctx.command`, the
        canonical name — see `ctx.invoked_as` for which spelling was typed.

        `cooldown` (AMENDMENT-08 §2) attaches a `Cooldown` to this command —
        no default, none unless asked, and unbounded (a command cooldown
        never reaches the wire, so a `Cooldown(1, 3600.0)` — once an hour —
        is legitimate). `on_cooldown` replaces the fixed `Slow down. Try
        /{name} again in {n} s.` reply for this command only, and beats a
        bot-level `@bot.on_cooldown`. There is no other way to set it: the
        returned handler is not touched, so it carries no `.on_cooldown`
        attribute — the kwarg here and `@bot.on_cooldown` are the only two
        doors."""
        alias_tuple = tuple(aliases) if aliases is not None else ()
        if len(alias_tuple) > MAX_ALIASES_PER_COMMAND:
            raise AurivalError(CAP_TOO_MANY_ALIASES)

        def decorate(fn: Handler) -> Handler:
            key = self._lookup_key(name)
            if key in self._registered:
                self._status.duplicate_command(name)
            self._registered[key] = _Registered(
                command=Command(name=name, description=description, aliases=alias_tuple),
                handler=fn,
                cooldown=cooldown,
                on_cooldown=on_cooldown,
            )
            return fn

        return decorate

    # Types a handler registered through `on()` can never run for. Both are
    # structural — routing this handler is not merely undocumented today, it
    # is architecturally impossible — unlike `reaction.removed`, which is
    # simply not a thing on the wire *yet* (AMENDMENT-04 A-2.1: un-reacting
    # emits no event at all today). Refusing `reaction.removed` here would be
    # a forward-compatibility trap: the day the server starts sending it,
    # every bot that pre-registered a handler for it would need a new SDK
    # release just to stop refusing what now works. `command.invoked` is
    # routed elsewhere (`@bot.command`); `backlog.overflowed` never reaches a
    # handler at all (SDK-28) — `Socket._handle_event` acks it before ever
    # consulting `has_handler`.
    _UNREGISTERABLE_EVENT_TYPES: ClassVar[dict[str, str]] = {
        "command.invoked": "routed through @bot.command, not bot.on()",
        "backlog.overflowed": "operational only — never reaches a handler (SDK-28)",
    }

    # One overload pair per event family, so `bot.on("` completes the five
    # known types and the handler is typed for exactly the context that type
    # delivers — `MemberContext` for `member.*`, `BotContext` for `bot.*`,
    # `ReactionContext` for `reaction.added`. The plain-`str` pair at the end
    # is the forward-compatibility door: a type this SDK does not know yet
    # still registers, and its handler receives an `EventContext`. That pair
    # takes `Any` for the handler on purpose — the checker would otherwise
    # report the `str` overload as overlapping the literal ones.
    @overload
    def on(self, event_type: MemberEventType) -> Callable[[MemberHandler], MemberHandler]: ...  # type: ignore[overload-overlap]

    @overload
    def on(self, event_type: MemberEventType, fn: MemberHandler) -> MemberHandler: ...

    @overload
    def on(self, event_type: BotEventType) -> Callable[[BotHandler], BotHandler]: ...  # type: ignore[overload-overlap]

    @overload
    def on(self, event_type: BotEventType, fn: BotHandler) -> BotHandler: ...

    @overload
    def on(self, event_type: ReactionEventType) -> Callable[[ReactionHandler], ReactionHandler]: ...  # type: ignore[overload-overlap]

    @overload
    def on(self, event_type: ReactionEventType, fn: ReactionHandler) -> ReactionHandler: ...

    @overload
    def on(self, event_type: ButtonEventType) -> Callable[[ButtonHandler], ButtonHandler]: ...  # type: ignore[overload-overlap]

    @overload
    def on(self, event_type: ButtonEventType, fn: ButtonHandler) -> ButtonHandler: ...

    # The plain-`str` pair is the forward-compatibility door: a type this SDK
    # does not name yet gets an `EventContext`. Typed against `EventHandler`,
    # not `Any`, so a handler of the wrong family is refused in the direct-call
    # form too. mypy flags the literal decorator forms above as overlapping
    # this one (a literal is a `str`, and the returned decorators differ);
    # that overlap is the intent, the literal wins when it matches, hence the
    # three `overload-overlap` ignores.
    @overload
    def on(self, event_type: str) -> Callable[[EventHandler], EventHandler]: ...

    @overload
    def on(self, event_type: str, fn: EventHandler) -> EventHandler: ...

    def on(self, event_type: str, fn: Any = None) -> Any:
        """Register a handler for an event other than a command — as a
        decorator, `@bot.on("member.joined")`, or a direct call,
        `bot.on("member.joined", fn)`. Each type hands its handler the
        context class made for it:

            member.joined, member.left   MemberContext    ctx.user
            bot.added, bot.removed       BotContext       ctx.actor
            reaction.added               ReactionContext  ctx.sender, ctx.message, ctx.emoji
            button.pressed               ButtonContext    ctx.button, ctx.interaction, ctx.ack()
            anything else                EventContext     every field optional

        Distinct registry from `@bot.command`; multiple handlers for the same
        type all run, in registration order. `command.invoked` itself is not
        routed through here — use `@bot.command`.

        Raises `AurivalError` at registration time for a type that can NEVER
        run (see `_UNREGISTERABLE_EVENT_TYPES`) — a handler that silently
        never fires is worse than one that fails loudly on `run()`. A type
        that merely doesn't exist on the wire yet is not refused: it builds
        an `EventContext` opportunistically the day the server ships it, so a
        handler registered ahead of the server is forward-compatible, not
        dead."""
        reason = self._UNREGISTERABLE_EVENT_TYPES.get(event_type)
        if reason is not None:
            raise AurivalError(f"bot.on({event_type!r}, ...) can never run: {reason}")

        if fn is not None:
            self._event_handlers.setdefault(event_type, []).append(fn)
            return fn

        def decorate(inner: _AnyHandler) -> _AnyHandler:
            self._event_handlers.setdefault(event_type, []).append(inner)
            return inner

        return decorate

    def _has_event_handler(self, event_type: str) -> bool:
        if event_type == EVENT_BUTTON_PRESSED:
            # The SDK's own cooldown check and automatic ack (AMENDMENT-08
            # §5) always need to see a press, whether or not the developer
            # registered a `bot.on("button.pressed", ...)` handler — so this
            # never reports "nothing registered" for it, unlike every other
            # generic event type.
            return True
        return bool(self._event_handlers.get(event_type))

    def on_error(self, fn: ErrorHook) -> ErrorHook:
        """Called with (error, context | None) for anything the SDK caught for you:
        a handler that raised, a `problem` frame, a backlog overflow."""
        self._error_hook = fn
        return fn

    def on_cooldown(self, fn: CooldownHook) -> CooldownHook:
        """Bot-level cooldown hook (AMENDMENT-08 §4): called `(ctx,
        retry_after)` once per bucket per window whenever a command cooldown
        refuses and that command has no `on_cooldown` of its own. Replaces
        the fixed `Slow down. Try /{name} again in {n} s.` reply entirely —
        the SDK sends nothing when a hook is registered, so a hook that does
        nothing means the bot is silent for that refusal. A hook that raises
        goes to `on_error` like any other handler, and the bot stays up.
        There is no button equivalent: a button cooldown's notice is a toast
        the client renders from a number, with nothing for a hook to
        replace (§9)."""
        self._cooldown_hook = fn
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
        except (SessionSuperseded, BotSuspended):
            # The friendly line was already printed by the reporter, inside
            # socket.run(), before this exception ever reached here — a
            # traceback on top of it would make a designed stop read like a
            # crash. Every other fatal bye keeps raising as before.
            sys.exit(1)

    async def start(self) -> None:
        if len(self._registered) > MAX_COMMANDS:
            raise AurivalError(
                f"{len(self._registered)} commands registered, but the cap is "
                f"{MAX_COMMANDS} per bot"
            )
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

                if not self._registered:
                    self._status.no_commands()
                self._status.connecting(machine.bot)
                socket = Socket(
                    http,
                    auth,
                    dispatch=self._dispatch,
                    on_problem=self._on_problem,
                    has_handler=self._has_event_handler,
                    logger=self._log,
                    reporter=self._status,
                    bot_name=machine.bot,
                    command_count=len(self._registered),
                )
                await socket.run(stop)
                # `run()` only returns (rather than raising) on a clean stop
                # (SIGINT/SIGTERM) — every fatal path raises instead. `getattr`
                # keeps this tolerant of a test double standing in for `Socket`.
                first_connected_at = getattr(socket, "first_connected_at", None)
                if first_connected_at is not None:
                    self._status.disconnected(duration_s=time.monotonic() - first_connected_at)
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
        payload: list[dict[str, object]] = []
        for r in self._registered.values():
            entry: dict[str, object] = {
                "name": r.command.name,
                "description": r.command.description,
            }
            # AMENDMENT-09 §2.1: absent and `[]` mean the same thing on the
            # wire, so the key is omitted rather than sent empty — matching
            # `send_message`'s own rule for `mentions`/`embeds`/`buttons`.
            if r.command.aliases:
                entry["aliases"] = list(r.command.aliases)
            payload.append(entry)
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
        payload: list[dict[str, object]],
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

    # -- auto-typing (SDK-41) ----------------------------------------------

    def _start_auto_typing(self, ctx: _events.Context) -> _AutoTyping | None:
        if not self._auto_typing or not ctx.chat.id:
            return None
        state = _AutoTyping()

        async def arm() -> None:
            await asyncio.sleep(_AUTO_TYPING_DELAY_S)
            # Past this point a cancel could abandon a request the server has
            # already applied, so the stop side awaits instead of cancelling.
            state.armed = True
            try:
                await ctx._http.set_typing(ctx.chat.id, True)
                state.sent = True
            except Exception as exc:  # typing is best-effort, never the reply's problem
                self._log.debug("auto typing start failed: %s", exc)

        state.task = asyncio.create_task(arm())
        return state

    async def _stop_auto_typing(self, state: _AutoTyping | None, ctx: _events.Context) -> None:
        if state is None or state.task is None:
            return
        if not state.armed:
            state.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await state.task
            return
        await state.task
        if not state.sent:
            return
        try:
            await ctx._http.set_typing(ctx.chat.id, False)
        except Exception as exc:
            self._log.debug("auto typing stop failed: %s", exc)

    async def _dispatch(self, event: Event) -> None:
        """One event. Runs the handler(s), never lets one take the bot down
        (SDK-16). Only reached for `command.invoked` or a type this bot has a
        generic handler for — `Socket` acks-and-ignores everything else itself.

        Note what is NOT in this frame: no key, no seed, no token. A crash
        reporter capturing locals here has nothing to capture.
        """
        # The socket runs each handler in its own task; registering it here is what
        # lets shutdown wait for the ones still going (SDK-32).
        running = asyncio.current_task()
        if running is not None:
            self._inflight.add(running)
            running.add_done_callback(self._inflight.discard)

        if event.type == "command.invoked":
            data = event.data
            name = str(data.get("command", ""))
            registered = self._registered.get(self._lookup_key(name))
            if registered is None:
                # The server routes by its own declared set, so this is a stale
                # sync or a name we just removed. Not an error.
                self._log.debug("no handler for command %r", name)
                return

            assert self._http is not None
            ctx = Context.from_event(event, http=self._http)

            # AMENDMENT-08 §3, §6: the cooldown check runs before auto-typing
            # and before the handler, and a refused invocation never reaches
            # either. A pass consumes a token; a refusal consumes nothing.
            if registered.cooldown is not None:
                subject = resolve_subject(
                    registered.cooldown.bucket, user_id=ctx.sender.id, chat_id=ctx.chat.id
                )
                key = ((), subject)
                retry_after = registered.cooldown.check(key)
                if retry_after is not None:
                    await self._notice_command_cooldown(registered, ctx, key, retry_after)
                    return

            typing = self._start_auto_typing(ctx)
            try:
                await registered.handler(ctx)
            # One bad command must not take the bot offline (SDK-16).
            except Exception as exc:
                self._log.exception("handler for %r raised", name)
                await self._call_error_hook(exc, ctx)
            finally:
                await self._stop_auto_typing(typing, ctx)
            return

        if event.type == EVENT_BUTTON_PRESSED:
            await self._dispatch_button_press(event)
            return

        handlers = self._event_handlers.get(event.type)
        if not handlers:
            return
        assert self._http is not None
        generic = context_for(event, http=self._http)
        for handler in handlers:
            try:
                await handler(generic)
            # Same rule as a command handler: one bad handler is not an outage.
            except Exception as exc:
                self._log.exception("handler for event %r raised", event.type)
                await self._call_error_hook(exc, generic)

    # -- command cooldown notice (AMENDMENT-08 §4) --------------------------

    async def _notice_command_cooldown(
        self,
        registered: _Registered,
        ctx: Context,
        key: object,
        retry_after: float,
    ) -> None:
        """Once per bucket per window: either the per-command hook, or the
        bot-level one, or — with neither registered — the fixed reply. A
        hook that raises goes through `_call_error_hook`, same as a command
        handler that raises."""
        assert registered.cooldown is not None
        if not registered.cooldown.should_notify(key):
            return
        hook = registered.on_cooldown or self._cooldown_hook
        if hook is not None:
            try:
                result = hook(ctx, retry_after)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                self._log.exception("on_cooldown hook raised")
                await self._call_error_hook(exc, ctx)
            return
        n = max(1, math.ceil(retry_after))
        # AMENDMENT-09 §13.1 (seat ruling): `{name}` renders the token the
        # human actually typed, not the canonical registration — `/r` gets
        # "Try /r again", never "Try /roll again". The bucket stays keyed on
        # the canonical command regardless (unchanged above); only the
        # rendered sentence changes.
        await ctx.reply(COOLDOWN_COMMAND_NOTICE.format(name=ctx.invoked_as, n=n))

    # -- button press cooldown + dispatch (AMENDMENT-08 §3, §5) -------------

    def _resolve_button_cooldown(self, ctx: ButtonContext) -> tuple[Cooldown | None, object]:
        """Precedence button > card > bot default (§3), resolved from the
        table `send()`/`reply()`/`edit()`/`ack()` record into — a message id
        missing from it (a restart, or a card another process sent) falls
        through to the bot default, exactly as an unrecorded card would.

        Returns the `Cooldown` to check (or `None` if disabled at every
        level that applies) and the key to check it with — `()` attachment
        scope for the bot default (one bucket per user per bot, §3), else
        `(message_id, button_id)` for a per-card/per-button `Cooldown`."""
        assert self._http is not None
        resolved: CooldownSpec = UNSET
        record = self._http.cooldowns.lookup(ctx.message.id) if ctx.message.id else None
        if record is not None:
            card_cooldown, button_cooldowns = record
            resolved = button_cooldowns.get(ctx.button, UNSET)
            if resolved is UNSET:
                resolved = card_cooldown

        if resolved is UNSET:
            cooldown = self._button_cooldown_default
            attachment_scope: object = ()
        elif resolved is None:
            return None, ()
        else:
            cooldown = resolved
            attachment_scope = (ctx.message.id, ctx.button)

        if cooldown is None:
            return None, ()
        subject = resolve_subject(cooldown.bucket, user_id=ctx.user.id, chat_id=ctx.chat.id)
        return cooldown, (attachment_scope, subject)

    async def _dispatch_button_press(self, event: Event) -> None:
        assert self._http is not None
        ctx = context_for(event, http=self._http)
        assert isinstance(ctx, ButtonContext)

        cooldown, key = self._resolve_button_cooldown(ctx)
        if cooldown is not None:
            retry_after = cooldown.check(key)
            if retry_after is not None:
                ms = max(1, math.ceil(retry_after * 1000))
                try:
                    await self._http.ack_interaction(ctx.interaction, cooldown_retry_after_ms=ms)
                    # The ack landed. Without this line a button cooldown is
                    # invisible to the bot author: the SDK answers the press
                    # itself, the handler never runs, and nothing is written
                    # anywhere — so a cooldown firing and a press vanishing
                    # look identical from the outside. INFO, not DEBUG,
                    # because the swallowed-refusal lines below are the ones
                    # a reader can ignore; this one is the cooldown working.
                    self._log.info(
                        "cooldown: acked press on %s/%s for %s, retry_after_ms=%d",
                        ctx.message.id,
                        ctx.button,
                        ctx.user.id,
                        ms,
                    )
                # AMENDMENT-08 §11 (D15): this ack is the SDK acting, not the
                # developer, so a press that is already moot — spent,
                # replaced, or the message is gone — is swallowed silently.
                # There is nothing a bot author can do about a request they
                # did not write.
                except (ButtonAlreadyUsed, NotFound) as exc:
                    self._log.debug(
                        "cooldown ack for interaction %s swallowed: %s", ctx.interaction, exc
                    )
                except Exception as exc:
                    self._log.exception(
                        "cooldown ack for interaction %s failed", ctx.interaction
                    )
                    await self._call_error_hook(exc, ctx)
                return

        handlers = self._event_handlers.get(event.type)
        if not handlers:
            return
        for handler in handlers:
            try:
                await handler(ctx)
            except Exception as exc:
                self._log.exception("handler for event %r raised", event.type)
                await self._call_error_hook(exc, ctx)

    def _on_problem(self, error: AurivalAPIError | Event) -> None:
        task = asyncio.create_task(self._call_error_hook(error, None))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    async def _call_error_hook(self, error: Reportable, ctx: AnyContext | None) -> None:
        if self._error_hook is None:
            return
        try:
            result = self._error_hook(error, ctx)
            if inspect.isawaitable(result):
                await result
        # An error hook that raises is not an outage either.
        except Exception:
            self._log.exception("error hook raised")
