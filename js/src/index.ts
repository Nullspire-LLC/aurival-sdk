/**
 * Aurival bot SDK.
 *
 * Declare commands, call run(), and the SDK holds the socket:
 *
 * ```ts
 * import { Bot } from "aurival";
 *
 * const bot = new Bot();
 *
 * bot.command("ping", async (ctx) => {
 *   await ctx.reply("pong");
 * });
 *
 * bot.run();
 * ```
 *
 * Everything a developer can name is exported here. The Python package mirrors
 * this list file for file (SDK-7), so a name missing here becomes a permanent
 * asymmetry: adding an export later is free, removing one is a break.
 */

export { Bot } from './bot.js';
export {
  APIError,
  AccessTokenExpired,
  AccessTokenInvalid,
  AckUnknownEvent,
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
  CODE_CLASSES,
  DOC_URL_PREFIX,
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
  RateLimitError,
  RateLimited,
  ServerRestarting,
  SessionSuperseded,
  SyncRateLimited,
  TYPE_CLASSES,
  TextTooLong,
  TooManyProblems,
  TransportError,
  UnknownOperation,
  UnknownParameter,
  fromEnvelope,
} from './errors.js';
export { Context, Event } from './events.js';
export type { Chat, Command, Message, User } from './events.js';
export { BYE_ACTIONS, ByeAction, actionForBye } from './socket.js';

export const version = '0.1.8';
