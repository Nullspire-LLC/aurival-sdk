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
export const MAX_BUTTON_EMOJI_RUNES = 16;
export const MAX_LINK_URL_RUNES = 2048;
export const BUTTON_STYLES = ['primary', 'secondary', 'danger', 'link'] as const;

export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const CAP_TOO_MANY_EMBEDS = 'a message carries at most 3 embeds';
export const CAP_TOO_MANY_FIELDS = 'a message carries at most 6 embed fields';
export const CAP_TOO_MANY_BUTTONS = 'a message carries at most 5 buttons';
export const CAP_LABEL_TOO_LONG = 'a button label is at most 24 characters';
export const CAP_BUTTON_ID_TOO_LONG = 'a button id is at most 32 characters';
export const CAP_DUPLICATE_BUTTON_ID = 'a button id must be unique within a message';
export const CAP_BAD_BUTTON_STYLE =
  'a button style must be one of primary, secondary, danger, link';
export const CAP_TITLE_TOO_LONG = 'an embed title is at most 256 characters';
export const CAP_DESCRIPTION_TOO_LONG = 'an embed description is at most 1024 characters';
export const CAP_IMAGE_URL_NOT_HTTPS = 'an image url must start with https://';

/**
 * AMENDMENT-06 §5. Link targets live in structured fields, never in prose,
 * and they answer a link mistake with a link sentence: `an image url ...`
 * would tell a bot author to fix the wrong thing. The one sentence that
 * names a number renders it from `MAX_LINK_URL_RUNES`, exactly as the
 * label and title caps above render theirs, because the server's template
 * refuses a digit literal.
 */
export const CAP_LINK_URL_NOT_HTTPS = 'a link url must start with https://';
export const CAP_LINK_URL_TOO_LONG = `a link url is at most ${MAX_LINK_URL_RUNES} characters`;
export const CAP_LINK_BUTTON_MISSING_URL = 'a link button needs a url';
export const CAP_URL_ON_NON_LINK_BUTTON = 'only a link button carries a url';
export const CAP_INVALID_BUTTON_EMOJI = 'a button emoji is a single unicode emoji';
export const CAP_EMBED_URL_WITHOUT_TITLE = 'an embed url needs a title to attach to';
export const CAP_AUTHOR_URL_WITHOUT_NAME = 'an author url needs an author name to attach to';
export const CAP_EMBED_FOOTER_TEXT_REQUIRED = 'an embed footer needs text';

/**
 * The server's `button_missing_field` sentence, rendered for the one field
 * an SDK caller can actually leave empty. AMENDMENT-06 §3 keeps the label
 * required so an emoji-only pill cannot ship: a pill with no words is
 * unreadable to a screen reader and unguessable to everyone else.
 */
export const CAP_BUTTON_MISSING_LABEL =
  'Every button needs `label`. A button without one cannot be rendered or pressed.';

/**
 * The SDK's own precondition, not one of the server's cap sentences: a send
 * with no text, no embeds and no buttons has nothing to deliver, so it is
 * refused here rather than sent for the server to refuse as empty text.
 */
export const EMPTY_MESSAGE = 'a message needs text, embeds or buttons';

/**
 * AMENDMENT-07 §7's one new code, `nothing_to_edit`: a PATCH body carrying
 * none of `text`, `embeds` or `buttons` has nothing to change, so the SDK
 * refuses it here rather than spending a round trip on it.
 *
 * The sentence is copied VERBATIM from AMENDMENT-07 §7's table because L1 has
 * not landed `errors_v1.go`'s row yet — when it does, this string and the Go
 * catalogue's must stay byte-identical, as they are for every other sentence
 * shared between `errors_v1.go`, `ERRORS-V1.md` §3, `sdk/python/aurival/caps.py`
 * and this file.
 */
export const NOTHING_TO_EDIT = 'an edit needs text, embeds or buttons';

/**
 * AMENDMENT-08 §4: the command-cooldown notice, sent through `ctx.reply`
 * once per bucket per window. `{name}` is the command as the developer
 * registered it; `{n}` is `Math.max(1, Math.ceil(retryAfterSeconds))`
 * (`cooldown.ts`'s `roundSeconds`) — the SAME rounding rule the button
 * toast's `{n}` uses (§5.4), stated once there. Lives byte-identically in
 * `sdk/python/aurival/caps.py` and the docs page; never a Go template, since
 * the server has no part in a command cooldown.
 */
export const COMMAND_COOLDOWN_NOTICE_TEMPLATE = 'Slow down. Try /{name} again in {n} s.';

/** Renders {@link COMMAND_COOLDOWN_NOTICE_TEMPLATE} for one refusal. */
export function commandCooldownNotice(name: string, n: number): string {
  return COMMAND_COOLDOWN_NOTICE_TEMPLATE.replace('{name}', name).replace('{n}', String(n));
}

/**
 * AMENDMENT-08 §5.1/§8's two new ack refusals: `cooldown` mixed with a
 * `text`/`embeds`/`buttons` body, and a `retry_after_ms` outside
 * `[MIN_COOLDOWN_RETRY_AFTER_MS, MAX_COOLDOWN_RETRY_AFTER_MS]`. These DO
 * have a Go twin (`errors_v1.go`'s `CodeCooldownWithBody` /
 * `CodeCooldownRetryAfterInvalid`, §8's table) — unlike `cooldown.ts`'s four
 * attachment-time sentences, which never reach the wire and so are never
 * Go's to send back. L1 has not landed `errors_v1.go`'s rows yet (verified
 * empty on `origin/main`); these ship ahead on §8's authority, following the
 * `NOTHING_TO_EDIT` precedent above.
 */
export const MIN_COOLDOWN_RETRY_AFTER_MS = 1;
export const MAX_COOLDOWN_RETRY_AFTER_MS = 60000;

export const CAP_COOLDOWN_WITH_BODY = 'a cooldown ack carries no text, embeds or buttons';
export const CAP_COOLDOWN_RETRY_AFTER_INVALID = `a cooldown retry_after_ms is a whole number of milliseconds between ${MIN_COOLDOWN_RETRY_AFTER_MS} and ${MAX_COOLDOWN_RETRY_AFTER_MS}`;

/**
 * AMENDMENT-09 §2.1/§4.1: two caps that ship ahead of their Go rows, on the
 * same authority as `NOTHING_TO_EDIT` and `CAP_COOLDOWN_WITH_BODY` above —
 * verified absent on `origin/main` at `12fa7874c`. `MAX_ALIASES_PER_COMMAND`
 * bounds how many alternate spellings one command may declare;
 * `CAP_TOO_MANY_ALIASES` is the sentence a caller sees when they exceed it,
 * RENDERED (not a `{max}` template) exactly as `CAP_LINK_URL_TOO_LONG` is
 * above. `CAP_FOR_USER_NOT_MEMBER` answers a `for_user` naming someone who
 * is not a live member of the chat at write time — no placeholder, and the
 * SAME sentence for a nonexistent id and a real non-member (§4.1, R-8: any
 * daylight would be an existence oracle). Both are byte-identical to
 * `sdk/python/aurival/caps.py`'s mirrors.
 */
export const MAX_ALIASES_PER_COMMAND = 3;
export const CAP_TOO_MANY_ALIASES = `a command declares at most ${MAX_ALIASES_PER_COMMAND} aliases`;
export const CAP_FOR_USER_NOT_MEMBER = 'for_user must name a member of this chat';
