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
BUTTON_STYLES = ("primary", "secondary", "danger")

CAP_TOO_MANY_EMBEDS = "a message carries at most 3 embeds"
CAP_TOO_MANY_FIELDS = "a message carries at most 6 embed fields"
CAP_TOO_MANY_BUTTONS = "a message carries at most 5 buttons"
CAP_LABEL_TOO_LONG = "a button label is at most 24 characters"
CAP_BUTTON_ID_TOO_LONG = "a button id is at most 32 characters"
CAP_DUPLICATE_BUTTON_ID = "a button id must be unique within a message"
CAP_BAD_BUTTON_STYLE = "a button style must be one of primary, secondary, danger"
CAP_LINK_STYLE_DEFERRED = "link buttons are not supported in v1"
CAP_TITLE_TOO_LONG = "an embed title is at most 256 characters"
CAP_DESCRIPTION_TOO_LONG = "an embed description is at most 1024 characters"
CAP_IMAGE_URL_NOT_HTTPS = "an image url must start with https://"

# The SDK's own precondition, not one of the server's cap sentences: a send
# with no text, no embeds and no buttons has nothing to deliver, so it is
# refused here rather than sent for the server to refuse as empty text.
EMPTY_MESSAGE = "a message needs text, embeds or buttons"
