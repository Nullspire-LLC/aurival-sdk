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
  ButtonAlreadyUsed,
  ButtonIDTooLong,
  ButtonLabelTooLong,
  ButtonMissingField,
  ButtonsWithoutMessage,
  CODE_CLASSES,
  CooldownRetryAfterInvalid,
  CooldownWithBody,
  DOC_URL_PREFIX,
  DuplicateButtonID,
  EmbedAuthorNameTooLong,
  EmbedDescriptionTooLong,
  EmbedEmpty,
  EmbedFieldNameTooLong,
  EmbedFieldValueTooLong,
  EmbedFooterTextTooLong,
  EmbedsTooLong,
  EmbedTitleTooLong,
  EmbedURLNotHTTPS,
  EmptyText,
  ForUserNotMember,
  FrameInvalid,
  FrameTooLarge,
  IdempotencyKeyInvalid,
  IdempotencyKeyReused,
  IdleTimeout,
  ImageURLTooLong,
  InternalError,
  InvalidButtonStyle,
  InvalidCommandName,
  InvalidJSON,
  InvalidRequestError,
  KeyAlreadyPaired,
  KeyRevoked,
  LinkButtonNotSupported,
  AuthorURLWithoutName,
  EmbedFooterTextRequired,
  EmbedURLWithoutTitle,
  InvalidButtonEmoji,
  LinkButtonMissingURL,
  LinkURLNotHTTPS,
  LinkURLTooLong,
  URLOnNonLinkButton,
  MentionNotMember,
  MentionTokenMissing,
  MessageNotYours,
  NotFound,
  NothingToEdit,
  PairRateLimited,
  ParameterInvalid,
  ParameterMissing,
  PermissionDeniedError,
  ProtocolError,
  RateLimitError,
  RateLimited,
  ReactionEmojiTooLong,
  ServerRestarting,
  SessionSuperseded,
  SyncRateLimited,
  TYPE_CLASSES,
  TextTooLong,
  TooManyAliases,
  TooManyButtons,
  TooManyEmbedFields,
  TooManyEmbeds,
  TooManyProblems,
  TransportError,
  UnknownOperation,
  UnknownParameter,
  fromEnvelope,
} from './errors.js';
export {
  BaseContext,
  BotContext,
  ButtonContext,
  Context,
  Event,
  EventContext,
  MemberContext,
  Mention,
  ReactionContext,
  mention,
} from './events.js';
export type {
  AnyContext,
  Chat,
  Command,
  EventType,
  MemberPage,
  Message,
  MentionLike,
  User,
} from './events.js';
export { Button, Embed } from './embeds.js';
export type { ButtonUsed } from './embeds.js';
export { BYE_ACTIONS, ByeAction, actionForBye } from './socket.js';
export { Cooldown } from './cooldown.js';

/** The package version. Pinned to `package.json` by test/index.test.ts. */
export const version = '0.9.0';
