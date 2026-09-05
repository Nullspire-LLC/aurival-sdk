"""Aurival bot SDK.

Declare commands, call run(), and the SDK holds the socket::

    from aurival import Bot

    bot = Bot()

    @bot.command("ping")
    async def ping(ctx):
        await ctx.reply("pong")

    bot.run()
"""

from __future__ import annotations

from .bot import Bot
from .errors import (
    CODE_CLASSES,
    DOC_URL_PREFIX,
    TYPE_CLASSES,
    AccessTokenExpired,
    AccessTokenInvalid,
    AckUnknownEvent,
    APIError,
    AssertionExpired,
    AssertionReplay,
    AurivalAPIError,
    AurivalError,
    AuthenticationError,
    BadAssertion,
    BadProof,
    BadPublicKey,
    BotLinkNotAllowed,
    BotPlaygroundOnly,
    BotSuspended,
    EmptyText,
    FrameInvalid,
    FrameTooLarge,
    IdempotencyKeyInvalid,
    IdempotencyKeyReused,
    IdleTimeout,
    InternalError,
    InvalidCommandName,
    InvalidJSON,
    InvalidRequestError,
    KeyAlreadyPaired,
    KeyRevoked,
    NotFound,
    PairRateLimited,
    ParameterInvalid,
    ParameterMissing,
    PermissionDeniedError,
    ProtocolError,
    RateLimited,
    RateLimitError,
    ServerRestarting,
    SessionSuperseded,
    SyncRateLimited,
    TextTooLong,
    TooManyProblems,
    TransportError,
    UnknownOperation,
    UnknownParameter,
    from_envelope,
)
from .events import Chat, Command, Context, Event, User
from .socket import BYE_ACTIONS, ByeAction, action_for_bye

__version__ = "0.1.2"

# Everything a developer can name. The JS package mirrors this list file for file
# (SDK-7), so a name missing here becomes a permanent asymmetry: adding an export
# later is free, removing one is a break.
__all__ = [
    "BYE_ACTIONS",
    "CODE_CLASSES",
    "DOC_URL_PREFIX",
    "TYPE_CLASSES",
    "APIError",
    "AccessTokenExpired",
    "AccessTokenInvalid",
    "AckUnknownEvent",
    "AssertionExpired",
    "AssertionReplay",
    "AurivalAPIError",
    "AurivalError",
    "AuthenticationError",
    "BadAssertion",
    "BadProof",
    "BadPublicKey",
    "Bot",
    "BotLinkNotAllowed",
    "BotPlaygroundOnly",
    "BotSuspended",
    "ByeAction",
    "Chat",
    "Command",
    "Context",
    "EmptyText",
    "Event",
    "FrameInvalid",
    "FrameTooLarge",
    "IdempotencyKeyInvalid",
    "IdempotencyKeyReused",
    "IdleTimeout",
    "InternalError",
    "InvalidCommandName",
    "InvalidJSON",
    "InvalidRequestError",
    "KeyAlreadyPaired",
    "KeyRevoked",
    "NotFound",
    "PairRateLimited",
    "ParameterInvalid",
    "ParameterMissing",
    "PermissionDeniedError",
    "ProtocolError",
    "RateLimitError",
    "RateLimited",
    "ServerRestarting",
    "SessionSuperseded",
    "SyncRateLimited",
    "TextTooLong",
    "TooManyProblems",
    "TransportError",
    "UnknownOperation",
    "UnknownParameter",
    "User",
    "__version__",
    "action_for_bye",
    "from_envelope",
]
