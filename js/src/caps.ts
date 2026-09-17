/**
 * Cap numbers and cap sentences for embeds and buttons.
 *
 * These are the exact sentences the server sends back as `invalid_request`
 * for the same violation, so a caller sees one wording whichever side
 * refuses — client-side validation here or the backend behind it. Do not
 * reword; do not add a cap that is not listed. Mirrors
 * `sdk/python/aurival/caps.py` byte for byte.
 */

export const MAX_EMBEDS = 3;
export const MAX_EMBED_FIELDS = 6;
export const MAX_BUTTONS = 5;
export const MAX_LABEL_RUNES = 24;
export const MAX_BUTTON_ID_LENGTH = 32;
export const MAX_TITLE_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const BUTTON_STYLES = ['primary', 'secondary', 'danger'] as const;

export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const CAP_TOO_MANY_EMBEDS = 'a message carries at most 3 embeds';
export const CAP_TOO_MANY_FIELDS = 'a message carries at most 6 embed fields';
export const CAP_TOO_MANY_BUTTONS = 'a message carries at most 5 buttons';
export const CAP_LABEL_TOO_LONG = 'a button label is at most 24 characters';
export const CAP_BUTTON_ID_TOO_LONG = 'a button id is at most 32 characters';
export const CAP_DUPLICATE_BUTTON_ID = 'a button id must be unique within a message';
export const CAP_BAD_BUTTON_STYLE = 'a button style must be one of primary, secondary, danger';
export const CAP_LINK_STYLE_DEFERRED = 'link buttons are not supported in v1';
export const CAP_TITLE_TOO_LONG = 'an embed title is at most 256 characters';
export const CAP_DESCRIPTION_TOO_LONG = 'an embed description is at most 1024 characters';
export const CAP_IMAGE_URL_NOT_HTTPS = 'an image url must start with https://';

/**
 * The SDK's own precondition, not one of the server's cap sentences: a send
 * with no text, no embeds and no buttons has nothing to deliver, so it is
 * refused here rather than sent for the server to refuse as empty text.
 */
export const EMPTY_MESSAGE = 'a message needs text, embeds or buttons';
