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

export class BotSuspended extends PermissionDeniedError {}
export class BotPlaygroundOnly extends PermissionDeniedError {}

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
