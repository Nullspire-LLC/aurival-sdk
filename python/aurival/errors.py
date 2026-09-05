"""ERRORS-V1 as Python exceptions.

One class per `type` (§1), then one subclass per `code` the SDK acts on
(errors_v1.go's `errCatalogue`, the closed catalogue). `from_envelope` turns a
wire envelope into the right instance and never raises itself.
"""

from __future__ import annotations


class AurivalError(Exception):
    """Base for everything this SDK raises."""


class TransportError(AurivalError):
    """A network fault: dial refused, DNS, reset. Never an aiohttp exception."""


class ProtocolError(AurivalError):
    """The server said something we cannot parse as the documented envelope."""


class AurivalAPIError(AurivalError):
    """One ERRORS-V1 envelope. Every instance carries `code` and `doc_url`."""

    def __init__(
        self,
        *,
        type: str,
        code: str,
        message: str,
        doc_url: str,
        request_id: str | None,
        retry_after: float | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.type = type
        self.code = code
        self.message = message
        self.doc_url = doc_url
        self.request_id = request_id
        self.retry_after = retry_after
        self.status = status


# --- one class per type (§1) ------------------------------------------------


class AuthenticationError(AurivalAPIError):
    """`authentication_error` — 401, re-sign and retry once."""


class InvalidRequestError(AurivalAPIError):
    """`invalid_request_error` — 400/404/409, never retry."""


class PermissionDeniedError(AurivalAPIError):
    """`permission_error` — 403, never retry. Not `PermissionError`: builtin."""


class RateLimitError(AurivalAPIError):
    """`rate_limit_error` — 429, honour `Retry-After`."""


class APIError(AurivalAPIError):
    """`api_error` — 5xx, our fault, retry with backoff."""


# --- one subclass per code the SDK acts on ----------------------------------


class AccessTokenExpired(AuthenticationError): ...


class AccessTokenInvalid(AuthenticationError): ...


class KeyRevoked(AuthenticationError): ...


class BadAssertion(AuthenticationError): ...


class AssertionExpired(AuthenticationError): ...


class AssertionReplay(AuthenticationError): ...


class BadProof(AuthenticationError): ...


class BadPublicKey(AuthenticationError): ...


class KeyAlreadyPaired(AuthenticationError): ...


class NotFound(InvalidRequestError): ...


class InvalidCommandName(InvalidRequestError): ...


class EmptyText(InvalidRequestError): ...


class TextTooLong(InvalidRequestError): ...


class InvalidJSON(InvalidRequestError): ...


class ParameterMissing(InvalidRequestError): ...


class ParameterInvalid(InvalidRequestError): ...


class UnknownParameter(InvalidRequestError): ...


class IdempotencyKeyReused(InvalidRequestError): ...


class IdempotencyKeyInvalid(InvalidRequestError): ...


class BotLinkNotAllowed(InvalidRequestError): ...


class SessionSuperseded(InvalidRequestError): ...


class FrameTooLarge(InvalidRequestError): ...


class FrameInvalid(InvalidRequestError): ...


class UnknownOperation(InvalidRequestError): ...


class AckUnknownEvent(InvalidRequestError): ...


class TooManyProblems(InvalidRequestError):
    """`too_many_problems`: the `bye` a connection earns by answering
    `MaxSocketProblemsBeforeBye` frames with a `problem`.

    SDK-39 shipped this class while BA-R23 was ruled and unimplemented, on the
    bet that landing it later would be a no-op here. BA-R23 has since landed
    (gateway.go:170) and it was.
    """


class BotSuspended(PermissionDeniedError): ...


class BotPlaygroundOnly(PermissionDeniedError): ...


class RateLimited(RateLimitError): ...


class PairRateLimited(RateLimitError): ...


class SyncRateLimited(RateLimitError): ...


class InternalError(APIError): ...


class ServerRestarting(APIError): ...


class IdleTimeout(APIError): ...


DOC_URL_PREFIX = "https://bots.aurival.com/docs/errors#"

TYPE_CLASSES: dict[str, type[AurivalAPIError]] = {
    "authentication_error": AuthenticationError,
    "invalid_request_error": InvalidRequestError,
    "permission_error": PermissionDeniedError,
    "rate_limit_error": RateLimitError,
    "api_error": APIError,
}

CODE_CLASSES: dict[str, type[AurivalAPIError]] = {
    "access_token_expired": AccessTokenExpired,
    "access_token_invalid": AccessTokenInvalid,
    "bad_assertion": BadAssertion,
    "assertion_expired": AssertionExpired,
    "assertion_replay": AssertionReplay,
    "bad_proof": BadProof,
    "bad_public_key": BadPublicKey,
    "key_revoked": KeyRevoked,
    "key_already_paired": KeyAlreadyPaired,
    "not_found": NotFound,
    "invalid_command_name": InvalidCommandName,
    "empty_text": EmptyText,
    "text_too_long": TextTooLong,
    "bot_link_not_allowed": BotLinkNotAllowed,
    "invalid_json": InvalidJSON,
    "parameter_missing": ParameterMissing,
    "parameter_invalid": ParameterInvalid,
    "unknown_parameter": UnknownParameter,
    "idempotency_key_reused": IdempotencyKeyReused,
    "idempotency_key_invalid": IdempotencyKeyInvalid,
    "bot_suspended": BotSuspended,
    "bot_playground_only": BotPlaygroundOnly,
    "rate_limited": RateLimited,
    "pair_rate_limited": PairRateLimited,
    "sync_rate_limited": SyncRateLimited,
    "internal_error": InternalError,
    "session_superseded": SessionSuperseded,
    "frame_too_large": FrameTooLarge,
    "server_restarting": ServerRestarting,
    "idle_timeout": IdleTimeout,
    "frame_invalid": FrameInvalid,
    "unknown_operation": UnknownOperation,
    "ack_unknown_event": AckUnknownEvent,
    # SDK-39: no wire sender at HEAD. See TooManyProblems.
    "too_many_problems": TooManyProblems,
}


def from_envelope(
    payload: dict[str, object],
    *,
    status: int | None = None,
    retry_after: float | None = None,
) -> AurivalAPIError:
    """Build an exception from an ERRORS-V1 envelope.

    `payload` is the whole body/frame data: `{"error": {...}}` or already the
    inner object. Unknown code -> its type's class. Unknown type -> the base
    `AurivalAPIError`. Never raises.
    """
    inner = payload.get("error")
    body = inner if isinstance(inner, dict) else payload

    code = body.get("code")
    code_str = code if isinstance(code, str) else ""
    error_type = body.get("type")
    type_str = error_type if isinstance(error_type, str) else ""
    message = body.get("message")
    message_str = message if isinstance(message, str) else ""
    doc_url = body.get("doc_url")
    doc_url_str = doc_url if isinstance(doc_url, str) else DOC_URL_PREFIX + code_str
    request_id = body.get("request_id")
    request_id_str = request_id if isinstance(request_id, str) else None

    cls = CODE_CLASSES.get(code_str)
    if cls is None:
        cls = TYPE_CLASSES.get(type_str, AurivalAPIError)

    return cls(
        type=type_str,
        code=code_str,
        message=message_str,
        doc_url=doc_url_str,
        request_id=request_id_str,
        retry_after=retry_after,
        status=status,
    )
