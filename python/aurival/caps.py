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
