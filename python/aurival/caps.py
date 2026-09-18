"""Cap numbers and cap sentences for embeds and buttons.

These are the exact sentences the server sends back as `invalid_request` for
the same violation, so a caller sees one wording whichever side refuses —
client-side validation here or the backend behind it. Do not reword; do not
add a cap that is not listed.
"""

from __future__ import annotations

MAX_EMBEDS = 3
MAX_EMBED_FIELDS = 6
MAX_BUTTONS = 5
MAX_LABEL_RUNES = 24
MAX_BUTTON_ID_LENGTH = 32
MAX_TITLE_LENGTH = 256
MAX_DESCRIPTION_LENGTH = 1024
MAX_LINK_URL_RUNES = 2048
MAX_BUTTON_EMOJI_RUNES = 16
BUTTON_STYLES = ("primary", "secondary", "danger", "link")

CAP_TOO_MANY_EMBEDS = "a message carries at most 3 embeds"
CAP_TOO_MANY_FIELDS = "a message carries at most 6 embed fields"
CAP_TOO_MANY_BUTTONS = "a message carries at most 5 buttons"
CAP_LABEL_TOO_LONG = "a button label is at most 24 characters"
CAP_BUTTON_ID_TOO_LONG = "a button id is at most 32 characters"
CAP_DUPLICATE_BUTTON_ID = "a button id must be unique within a message"
CAP_BAD_BUTTON_STYLE = "a button style must be one of primary, secondary, danger, link"
CAP_TITLE_TOO_LONG = "an embed title is at most 256 characters"
CAP_DESCRIPTION_TOO_LONG = "an embed description is at most 1024 characters"
CAP_IMAGE_URL_NOT_HTTPS = "an image url must start with https://"

# AMENDMENT-06 §5. A link target is not an image, so it answers a link mistake
# with a link message rather than borrowing the image sentence above.
CAP_LINK_URL_NOT_HTTPS = "a link url must start with https://"
CAP_LINK_URL_TOO_LONG = "a link url is at most 2048 characters"
CAP_LINK_BUTTON_MISSING_URL = "a link button needs a url"
CAP_URL_ON_NON_LINK_BUTTON = "only a link button carries a url"
CAP_INVALID_BUTTON_EMOJI = "a button emoji is a single unicode emoji"
CAP_EMBED_URL_WITHOUT_TITLE = "an embed url needs a title to attach to"
CAP_AUTHOR_URL_WITHOUT_NAME = "an author url needs an author name to attach to"
CAP_EMBED_FOOTER_TEXT_REQUIRED = "an embed footer needs text"

# The server's own `button_missing_field` sentence, rendered for the one field
# a builder can leave empty. AMENDMENT-06 §3 keeps the label required so an
# emoji-only pill — unreadable to a screen reader — is refused before it is
# sent, rather than slugged to an id and delivered.
CAP_BUTTON_MISSING_LABEL = (
    "Every button needs `label`. A button without one cannot be rendered or pressed."
)

# The SDK's own precondition, not one of the server's cap sentences: a send
# with no text, no embeds and no buttons has nothing to deliver, so it is
# refused here rather than sent for the server to refuse as empty text.
EMPTY_MESSAGE = "a message needs text, embeds or buttons"

# The same precondition for the edit door (AMENDMENT-07 §9): `None` means "not
# present" on every part of an edit, so an edit naming none of the three parts
# has nothing to change and is refused here rather than sent. The sentence is
# copied verbatim from AMENDMENT-07 §7's `nothing_to_edit` row, because L1 has
# not landed that row in `errors_v1.go` yet — when it does, this constant and
# the Go catalogue must stay byte-identical.
NOTHING_TO_EDIT = "an edit needs text, embeds or buttons"

# AMENDMENT-08 §4: the fixed reply a command cooldown sends, one per bucket
# per window, when no `on_cooldown` hook is registered. `{name}` is the
# command as the developer registered it; `{n}` is `max(1, ceil(retry_after))`.
# Byte-identical to `sdk/js/src/caps.ts` and the docs page — it is never a Go
# template, because a command cooldown never reaches the server.
COOLDOWN_COMMAND_NOTICE = "Slow down. Try /{name} again in {n} s."

# AMENDMENT-08 §8. These two DO have server twins (`cooldown_with_body`,
# `cooldown_retry_after_invalid`) — unlike cooldown.py's four sentences,
# which guard a client-side-only refusal the wire can never send back.
CAP_COOLDOWN_WITH_BODY = "a cooldown ack carries no text, embeds or buttons"

# Same convention as `CAP_LINK_URL_TOO_LONG` above: the server's own template
# for this code carries `{min}`/`{max}` because Go's error catalogue refuses
# a digit literal in that string, but both SDKs render the bound into the
# sentence itself, so `min`/`max` here are the rendered numbers, not a
# format string — `CAP_COOLDOWN_RETRY_AFTER_INVALID` is byte-identical to
# `sdk/js/src/caps.ts`'s rendered constant, not to the Go template.
MIN_COOLDOWN_RETRY_AFTER_MS = 1
MAX_COOLDOWN_RETRY_AFTER_MS = 60000
CAP_COOLDOWN_RETRY_AFTER_INVALID = (
    "a cooldown retry_after_ms is a whole number of milliseconds between "
    f"{MIN_COOLDOWN_RETRY_AFTER_MS} and {MAX_COOLDOWN_RETRY_AFTER_MS}"
)

# AMENDMENT-09 §8.1. Both rows ship ahead of their Go row on the amendment's
# own authority — the same bet `CAP_COOLDOWN_WITH_BODY` and
# `CAP_COOLDOWN_RETRY_AFTER_INVALID` made and won for AMENDMENT-08: verified
# absent from `errors_v1.go` on origin/main at 12fa7874c, and landing the Go
# row later is a no-op here. `CAP_TOO_MANY_ALIASES` is RENDERED, not a
# `{max}` template — same convention as `CAP_LINK_URL_TOO_LONG` above — and
# `CAP_FOR_USER_NOT_MEMBER` carries no placeholder at all; both must stay
# byte-identical to `sdk/js/src/caps.ts` and to `errors_v1.go` once L1 lands
# its row.
MAX_ALIASES_PER_COMMAND = 3
CAP_TOO_MANY_ALIASES = f"a command declares at most {MAX_ALIASES_PER_COMMAND} aliases"
CAP_FOR_USER_NOT_MEMBER = "for_user must name a member of this chat"
