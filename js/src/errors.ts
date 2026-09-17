/**
 * ERRORS-V1 as JavaScript errors.
 *
 * One class per `type` (§1), then one subclass per `code` the SDK acts on
 * (errors_v1.go's `errCatalogue`, the closed catalogue). `fromEnvelope` turns a
 * wire envelope into the right instance and never throws itself.
 */

/** Base for everything this SDK throws. */
export class AurivalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A network fault: dial refused, DNS, reset. Never an undici exception. */
export class TransportError extends AurivalError {}

/** The server said something we cannot parse as the documented envelope. */
export class ProtocolError extends AurivalError {}

export interface AurivalAPIErrorInit {
  type: string;
  code: string;
  message: string;
  doc_url: string;
  request_id?: string | null;
  retry_after?: number | null;
  status?: number | null;
}

/** One ERRORS-V1 envelope. Every instance carries `code` and `doc_url`. */
export class AurivalAPIError extends AurivalError {
  readonly type: string;
  readonly code: string;
  readonly doc_url: string;
  readonly request_id: string | null;
  readonly retry_after: number | null;
  readonly status: number | null;

  constructor(init: AurivalAPIErrorInit) {
    super(init.message);
    this.type = init.type;
    this.code = init.code;
    this.doc_url = init.doc_url;
    this.request_id = init.request_id ?? null;
    this.retry_after = init.retry_after ?? null;
    this.status = init.status ?? null;
  }
}

// --- one class per type (§1) ------------------------------------------------

/** `authentication_error` — 401, re-sign and retry once. */
export class AuthenticationError extends AurivalAPIError {}

/** `invalid_request_error` — 400/404/409, never retry. */
export class InvalidRequestError extends AurivalAPIError {}

/** `permission_error` — 403, never retry. */
export class PermissionDeniedError extends AurivalAPIError {}

/** `rate_limit_error` — 429, honour `Retry-After`. */
export class RateLimitError extends AurivalAPIError {}

/** `api_error` — 5xx, our fault, retry with backoff. */
export class APIError extends AurivalAPIError {}

// --- one subclass per code the SDK acts on ----------------------------------

export class AccessTokenExpired extends AuthenticationError {}
export class AccessTokenInvalid extends AuthenticationError {}
export class KeyRevoked extends AuthenticationError {}
export class BadAssertion extends AuthenticationError {}
export class AssertionExpired extends AuthenticationError {}
export class AssertionReplay extends AuthenticationError {}
export class BadProof extends AuthenticationError {}
export class BadPublicKey extends AuthenticationError {}
export class KeyAlreadyPaired extends AuthenticationError {}

export class NotFound extends InvalidRequestError {}
export class InvalidCommandName extends InvalidRequestError {}
export class EmptyText extends InvalidRequestError {}
export class TextTooLong extends InvalidRequestError {}
export class InvalidJSON extends InvalidRequestError {}
export class ParameterMissing extends InvalidRequestError {}
export class ParameterInvalid extends InvalidRequestError {}
export class UnknownParameter extends InvalidRequestError {}
export class IdempotencyKeyReused extends InvalidRequestError {}
export class IdempotencyKeyInvalid extends InvalidRequestError {}
export class BotLinkNotAllowed extends InvalidRequestError {}
export class SessionSuperseded extends InvalidRequestError {}
export class FrameTooLarge extends InvalidRequestError {}
export class FrameInvalid extends InvalidRequestError {}
export class UnknownOperation extends InvalidRequestError {}
export class AckUnknownEvent extends InvalidRequestError {}

/**
 * `too_many_problems` (SDK-39). BA-R23 was ruled and has since landed on main
 * (`a522dcb4`), so this is a real row rather than a placeholder.
 */
export class TooManyProblems extends InvalidRequestError {}

/**
 * `reaction_emoji_too_long` — the emoji argument to `react()`/`unreact()`
 * exceeded the server's >32-byte length clamp (AMENDMENT-04 A-2). This is a
 * size limit, not an allowlist check — there is no disallowed-emoji list to
 * go looking for; any emoji under the byte clamp is accepted.
 */
export class ReactionEmojiTooLong extends InvalidRequestError {}

/**
 * `mention_not_member` — a `mentions` entry named a user id that is not a
 * member of the target chat. Deliberately indistinguishable from a
 * nonexistent user id (AMENDMENT-04 A-4, R-8): both answer with this same
 * code, so the response can never be used as an existence oracle for a
 * user id the caller does not already know is valid.
 */
export class MentionNotMember extends InvalidRequestError {}

/** `mention_token_missing` — a `mentions` entry's `@handle` never appeared in `text`. */
export class MentionTokenMissing extends InvalidRequestError {}

export class BotSuspended extends PermissionDeniedError {}
export class BotPlaygroundOnly extends PermissionDeniedError {}

/** `message_not_yours` — 403, `edit()`/`delete()` only work on the bot's own messages. */
export class MessageNotYours extends PermissionDeniedError {}

// AMENDMENT-05 §2. The card's caps and per-field refusals — every one a 400,
// and every sentence quotes card.go's CapTemplate* constants (mirrored in
// caps.ts) so a cap cannot move in the validator without moving here too.

/** `too_many_embeds` — a message carries more than `MAX_EMBEDS` embeds. */
export class TooManyEmbeds extends InvalidRequestError {}

/** `too_many_embed_fields` — one embed carries more than `MAX_EMBED_FIELDS` fields. */
export class TooManyEmbedFields extends InvalidRequestError {}

/** `too_many_buttons` — a message carries more than `MAX_BUTTONS` buttons. */
export class TooManyButtons extends InvalidRequestError {}

/** `button_missing_field` — a button is missing a field it needs to be rendered or pressed. */
export class ButtonMissingField extends InvalidRequestError {}

/** `button_id_too_long` — a button id is longer than `MAX_BUTTON_ID_LENGTH`. */
export class ButtonIDTooLong extends InvalidRequestError {}

/** `duplicate_button_id` — two buttons in the same message share an id. Button ids must be unique within a message. */
export class DuplicateButtonID extends InvalidRequestError {}

/** `button_label_too_long` — a button label is longer than `MAX_LABEL_RUNES`. */
export class ButtonLabelTooLong extends InvalidRequestError {}

/** `link_button_not_supported` — link-style buttons are not supported in v1. */
export class LinkButtonNotSupported extends InvalidRequestError {}

/** `invalid_button_style` — a button's style is not one of `BUTTON_STYLES`. */
export class InvalidButtonStyle extends InvalidRequestError {}

/** `embed_title_too_long` — an embed title is longer than `MAX_TITLE_LENGTH`. */
export class EmbedTitleTooLong extends InvalidRequestError {}

/** `embed_description_too_long` — an embed description is longer than `MAX_DESCRIPTION_LENGTH`. */
export class EmbedDescriptionTooLong extends InvalidRequestError {}

/** `embed_url_not_https` — an embed image url does not start with `https://`. */
export class EmbedURLNotHTTPS extends InvalidRequestError {}

/**
 * `embed_empty` — an embed carries none of a title, a description, a field or
 * a footer. A colour on its own is a coloured rectangle, not a message.
 */
export class EmbedEmpty extends InvalidRequestError {}

/** `buttons_without_message` — buttons were sent with nothing under them. Send text, embeds, or both alongside them. */
export class ButtonsWithoutMessage extends InvalidRequestError {}

/**
 * `button_already_used` — a row of actions is spent once a button on it has
 * been pressed; send a new message for another press.
 */
export class ButtonAlreadyUsed extends InvalidRequestError {}

export class RateLimited extends RateLimitError {}
export class PairRateLimited extends RateLimitError {}
export class SyncRateLimited extends RateLimitError {}

export class InternalError extends APIError {}
export class ServerRestarting extends APIError {}
export class IdleTimeout extends APIError {}

export const DOC_URL_PREFIX = 'https://bots.aurival.com/docs/errors#';

export type AurivalAPIErrorClass = new (init: AurivalAPIErrorInit) => AurivalAPIError;

export const TYPE_CLASSES: Readonly<Record<string, AurivalAPIErrorClass>> = {
  authentication_error: AuthenticationError,
  invalid_request_error: InvalidRequestError,
  permission_error: PermissionDeniedError,
  rate_limit_error: RateLimitError,
  api_error: APIError,
};

export const CODE_CLASSES: Readonly<Record<string, AurivalAPIErrorClass>> = {
  access_token_expired: AccessTokenExpired,
  access_token_invalid: AccessTokenInvalid,
  bad_assertion: BadAssertion,
  assertion_expired: AssertionExpired,
  assertion_replay: AssertionReplay,
  bad_proof: BadProof,
  bad_public_key: BadPublicKey,
  key_revoked: KeyRevoked,
  key_already_paired: KeyAlreadyPaired,
  not_found: NotFound,
  invalid_command_name: InvalidCommandName,
  empty_text: EmptyText,
  text_too_long: TextTooLong,
  bot_link_not_allowed: BotLinkNotAllowed,
  invalid_json: InvalidJSON,
  parameter_missing: ParameterMissing,
  parameter_invalid: ParameterInvalid,
  unknown_parameter: UnknownParameter,
  idempotency_key_reused: IdempotencyKeyReused,
  idempotency_key_invalid: IdempotencyKeyInvalid,
  bot_suspended: BotSuspended,
  bot_playground_only: BotPlaygroundOnly,
  rate_limited: RateLimited,
  pair_rate_limited: PairRateLimited,
  sync_rate_limited: SyncRateLimited,
  internal_error: InternalError,
  session_superseded: SessionSuperseded,
  frame_too_large: FrameTooLarge,
  server_restarting: ServerRestarting,
  idle_timeout: IdleTimeout,
  frame_invalid: FrameInvalid,
  unknown_operation: UnknownOperation,
  ack_unknown_event: AckUnknownEvent,
  too_many_problems: TooManyProblems,
  reaction_emoji_too_long: ReactionEmojiTooLong,
  mention_not_member: MentionNotMember,
  mention_token_missing: MentionTokenMissing,
  message_not_yours: MessageNotYours,
  too_many_embeds: TooManyEmbeds,
  too_many_embed_fields: TooManyEmbedFields,
  too_many_buttons: TooManyButtons,
  button_missing_field: ButtonMissingField,
  button_id_too_long: ButtonIDTooLong,
  duplicate_button_id: DuplicateButtonID,
  button_label_too_long: ButtonLabelTooLong,
  link_button_not_supported: LinkButtonNotSupported,
  invalid_button_style: InvalidButtonStyle,
  embed_title_too_long: EmbedTitleTooLong,
  embed_description_too_long: EmbedDescriptionTooLong,
  embed_url_not_https: EmbedURLNotHTTPS,
  embed_empty: EmbedEmpty,
  buttons_without_message: ButtonsWithoutMessage,
  button_already_used: ButtonAlreadyUsed,
};

export interface FromEnvelopeOptions {
  status?: number | null;
  retryAfter?: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Build an error from an ERRORS-V1 envelope.
 *
 * `payload` is the whole body/frame data: `{"error": {...}}` or already the
 * inner object. Unknown code -> its type's class. Unknown type -> the base
 * `AurivalAPIError`. Never throws.
 */
export function fromEnvelope(
  payload: Record<string, unknown>,
  options: FromEnvelopeOptions = {},
): AurivalAPIError {
  const body = asRecord(payload['error']) ?? payload;

  const code = asString(body['code']) ?? '';
  const type = asString(body['type']) ?? '';
  const message = asString(body['message']) ?? '';
  const doc_url = asString(body['doc_url']) ?? DOC_URL_PREFIX + code;
  const request_id = asString(body['request_id']);

  const cls = CODE_CLASSES[code] ?? TYPE_CLASSES[type] ?? AurivalAPIError;

  return new cls({
    type,
    code,
    message,
    doc_url,
    request_id,
    retry_after: options.retryAfter ?? null,
    status: options.status ?? null,
  });
}
