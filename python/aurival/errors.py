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


class NothingToEdit(InvalidRequestError):
    """`nothing_to_edit`: a `PATCH /v1/messages/{msg}` whose body carries none
    of `text`, `embeds` or `buttons`.

    Ships ahead of its Go row on AMENDMENT-07 §7's authority — the same bet
    `TooManyProblems` made and won: the catalogue row is ruled, L1 has not
    landed `errors_v1.go`'s entry yet, and landing it later is a no-op here.
    Until then the SDK refuses this case itself, with §7's sentence verbatim
    (`caps.NOTHING_TO_EDIT`), as a `ValueError` before the round trip.
    """


class CooldownWithBody(InvalidRequestError):
    """`cooldown_with_body`: a `POST /v1/interactions/{id}/ack` body carried
    `cooldown` alongside `text`/`embeds`/`buttons` (AMENDMENT-08 §5.1) — the
    two are mutually exclusive: `used` cannot be both untouched (a cooldown
    ack) and reset (a replacing body) in the same request.

    Ships ahead of its Go row on AMENDMENT-08 §8's authority — same bet
    `NothingToEdit`/`TooManyProblems` made and won: L1 has not landed
    `errors_v1.go`'s entry yet, and landing it later is a no-op here.
    """


class CooldownRetryAfterInvalid(InvalidRequestError):
    """`cooldown_retry_after_invalid`: a `cooldown.retry_after_ms` on a
    button-press ack was not a whole number of milliseconds between the
    server's minimum and maximum (AMENDMENT-08 §5.1). The SDK itself never
    produces an out-of-range value — it validates a button cooldown's bound
    at attachment time (`cooldown.validate_button_cooldown`) — so this only
    ever surfaces if the server disagrees with what the SDK computed.

    Ships ahead of its Go row on AMENDMENT-08 §8's authority; see
    `CooldownWithBody`.
    """


class BotSuspended(PermissionDeniedError): ...


class BotPlaygroundOnly(PermissionDeniedError): ...


class RateLimited(RateLimitError): ...


class PairRateLimited(RateLimitError): ...


class SyncRateLimited(RateLimitError): ...


class InternalError(APIError): ...


class ServerRestarting(APIError): ...


class IdleTimeout(APIError): ...


class ReactionEmojiTooLong(InvalidRequestError):
    """`reaction_emoji_too_long` — the emoji exceeded the server's byte-length
    clamp (>32 bytes). Not an emoji allowlist: the server does not validate
    that the value is a real emoji at all, only that it fits (AMENDMENT-04
    A-2)."""


class MentionNotMember(InvalidRequestError):
    """`mention_not_member` — the mentioned user is not a member of the chat.

    Deliberately identical whether the id names a real user who just isn't a
    member, or doesn't exist at all (AMENDMENT-04 A-4, R-8) — collapsing the
    two prevents a mention field from being used as a user-existence oracle.
    """


class MentionTokenMissing(InvalidRequestError):
    """`mention_token_missing` — a `mentions` entry's `@handle` token was not
    found in `text`."""


class MessageNotYours(PermissionDeniedError):
    """`message_not_yours` — `edit`/`delete`/react actions only work on the
    bot's own messages."""


# AMENDMENT-05 §2. The card's caps and per-field refusals — every one a 400,
# and every sentence quotes card.go's CapTemplate* constants (mirrored in
# caps.py) so a cap cannot move in the validator without moving here too.


class TooManyEmbeds(InvalidRequestError):
    """`too_many_embeds` — a message carries more than `MAX_EMBEDS` embeds."""


class TooManyEmbedFields(InvalidRequestError):
    """`too_many_embed_fields` — one embed carries more than `MAX_EMBED_FIELDS`
    fields."""


class TooManyButtons(InvalidRequestError):
    """`too_many_buttons` — a message carries more than `MAX_BUTTONS` buttons."""


class ButtonMissingField(InvalidRequestError):
    """`button_missing_field` — a button is missing a field it needs to be
    rendered or pressed."""


class ButtonIDTooLong(InvalidRequestError):
    """`button_id_too_long` — a button id is longer than
    `MAX_BUTTON_ID_LENGTH`."""


class DuplicateButtonID(InvalidRequestError):
    """`duplicate_button_id` — two buttons in the same message share an id.
    Button ids must be unique within a message."""


class ButtonLabelTooLong(InvalidRequestError):
    """`button_label_too_long` — a button label is longer than
    `MAX_LABEL_RUNES`."""


class LinkButtonNotSupported(InvalidRequestError):
    """`link_button_not_supported` — link-style buttons are not supported in
    v1."""


class InvalidButtonStyle(InvalidRequestError):
    """`invalid_button_style` — a button's style is not one of
    `BUTTON_STYLES`."""


class EmbedTitleTooLong(InvalidRequestError):
    """`embed_title_too_long` — an embed title is longer than
    `MAX_TITLE_LENGTH`."""


class EmbedDescriptionTooLong(InvalidRequestError):
    """`embed_description_too_long` — an embed description is longer than
    `MAX_DESCRIPTION_LENGTH`."""


class EmbedURLNotHTTPS(InvalidRequestError):
    """`embed_url_not_https` — an embed image url does not start with
    `https://`."""


class LinkURLNotHTTPS(InvalidRequestError):
    """`link_url_not_https` — a link target does not start with `https://`.
    Separate from `EmbedURLNotHTTPS` on purpose: that one says "an image url",
    and a button target is not an image (AMENDMENT-06 §5)."""


class LinkURLTooLong(InvalidRequestError):
    """`link_url_too_long` — a link target is longer than
    `MAX_LINK_URL_RUNES`."""


class LinkButtonMissingURL(InvalidRequestError):
    """`link_button_missing_url` — a button with style `link` carries no url,
    so there is nothing for the pill to open."""


class URLOnNonLinkButton(InvalidRequestError):
    """`url_on_non_link_button` — only a link button carries a url. Refused
    rather than ignored, matching the contract's stance that a typo is loud."""


class InvalidButtonEmoji(InvalidRequestError):
    """`invalid_button_emoji` — a button emoji is not a single unicode
    emoji."""


class EmbedURLWithoutTitle(InvalidRequestError):
    """`embed_url_without_title` — an embed carries a url with no title for
    the tap to attach to."""


class AuthorURLWithoutName(InvalidRequestError):
    """`author_url_without_name` — an embed author carries a url with no name
    for the tap to attach to."""


class EmbedFooterTextRequired(InvalidRequestError):
    """`embed_footer_text_required` — a footer carries an icon but no text,
    which would render a floating glyph on a line with nothing to say."""


class EmbedEmpty(InvalidRequestError):
    """`embed_empty` — an embed carries none of a title, a description, a
    field or a footer. A colour on its own is a coloured rectangle, not a
    message."""


class ButtonsWithoutMessage(InvalidRequestError):
    """`buttons_without_message` — buttons were sent with nothing under them.
    Send text, embeds, or both alongside them."""


class ButtonAlreadyUsed(InvalidRequestError):
    """`button_already_used` — a row of actions is spent once a button on it
    has been pressed; send a new message for another press."""


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
    "link_url_not_https": LinkURLNotHTTPS,
    "link_url_too_long": LinkURLTooLong,
    "link_button_missing_url": LinkButtonMissingURL,
    "url_on_non_link_button": URLOnNonLinkButton,
    "invalid_button_emoji": InvalidButtonEmoji,
    "embed_url_without_title": EmbedURLWithoutTitle,
    "author_url_without_name": AuthorURLWithoutName,
    "embed_footer_text_required": EmbedFooterTextRequired,
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
    "reaction_emoji_too_long": ReactionEmojiTooLong,
    "mention_not_member": MentionNotMember,
    "mention_token_missing": MentionTokenMissing,
    "message_not_yours": MessageNotYours,
    "too_many_embeds": TooManyEmbeds,
    "too_many_embed_fields": TooManyEmbedFields,
    "too_many_buttons": TooManyButtons,
    "button_missing_field": ButtonMissingField,
    "button_id_too_long": ButtonIDTooLong,
    "duplicate_button_id": DuplicateButtonID,
    "button_label_too_long": ButtonLabelTooLong,
    "link_button_not_supported": LinkButtonNotSupported,
    "invalid_button_style": InvalidButtonStyle,
    "embed_title_too_long": EmbedTitleTooLong,
    "embed_description_too_long": EmbedDescriptionTooLong,
    "embed_url_not_https": EmbedURLNotHTTPS,
    "embed_empty": EmbedEmpty,
    "buttons_without_message": ButtonsWithoutMessage,
    "button_already_used": ButtonAlreadyUsed,
    # AMENDMENT-07 §7: no wire sender at HEAD. See NothingToEdit.
    "nothing_to_edit": NothingToEdit,
    # AMENDMENT-08 §8: no wire sender at HEAD. See CooldownWithBody.
    "cooldown_with_body": CooldownWithBody,
    "cooldown_retry_after_invalid": CooldownRetryAfterInvalid,
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
