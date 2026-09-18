/**
 * Discord-shaped `Embed` and `Button` builders (AMENDMENT-05, extended by
 * AMENDMENT-06 with a footer icon, a button emoji and the three structured
 * link targets). Mirrors
 * python's builders field for field; the wire shape and every cap sentence
 * are contractual (`caps.ts`) and must not drift between the two SDKs.
 *
 * Two ways in: a builder chain (`new Embed().addField(...)`), validated as
 * each piece is added, or a plain object literal, accepted anywhere a
 * builder is (the way `mentions` already accepts a raw `{ user }`) and
 * validated to the exact same sentences by `serialiseEmbeds`/
 * `serialiseButtons` before it ever reaches the wire — a plain object is
 * never a bypass.
 *
 * Decoding off the wire (`fromJSON`, used by `embedsFromWire`/
 * `buttonsFromWire` in events.ts) is deliberately tolerant and never
 * throws — the caps are an outbound (client -> server) contract, not an
 * inbound one, and a message already stored by the server is assumed valid.
 */

import {
  BUTTON_STYLES,
  CAP_AUTHOR_URL_WITHOUT_NAME,
  CAP_BAD_BUTTON_STYLE,
  CAP_BUTTON_ID_TOO_LONG,
  CAP_BUTTON_MISSING_LABEL,
  CAP_DESCRIPTION_TOO_LONG,
  CAP_DUPLICATE_BUTTON_ID,
  CAP_EMBED_FOOTER_TEXT_REQUIRED,
  CAP_EMBED_URL_WITHOUT_TITLE,
  CAP_IMAGE_URL_NOT_HTTPS,
  CAP_INVALID_BUTTON_EMOJI,
  CAP_LABEL_TOO_LONG,
  CAP_LINK_BUTTON_MISSING_URL,
  CAP_LINK_URL_NOT_HTTPS,
  CAP_LINK_URL_TOO_LONG,
  CAP_TITLE_TOO_LONG,
  CAP_TOO_MANY_BUTTONS,
  CAP_TOO_MANY_EMBEDS,
  CAP_TOO_MANY_FIELDS,
  CAP_URL_ON_NON_LINK_BUTTON,
  MAX_BUTTON_EMOJI_RUNES,
  MAX_BUTTON_ID_LENGTH,
  MAX_BUTTONS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMBED_FIELDS,
  MAX_EMBEDS,
  MAX_LABEL_RUNES,
  MAX_LINK_URL_RUNES,
  MAX_TITLE_LENGTH,
} from './caps.js';
import { CAP_LINK_BUTTON_COOLDOWN, Cooldown, normalizeCooldownOption } from './cooldown.js';
import type { CooldownOption } from './cooldown.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function graphemeLength(text: string): number {
  return [...text].length;
}

/**
 * AMENDMENT-06 §11 asks every new url field to reuse this helper; §5 asks a
 * link field to answer with the LINK sentence rather than the image one. The
 * sentence is therefore a parameter: one https check, two wordings, and the
 * caller picks the one that tells its author what to fix.
 */
function requireHttps(url: string, sentence: string = CAP_IMAGE_URL_NOT_HTTPS): void {
  if (!url.startsWith('https://')) throw new Error(sentence);
}

/** https, then the rune bound — runes, not UTF-16 units, matching the server. */
function requireLinkUrl(url: string): void {
  requireHttps(url, CAP_LINK_URL_NOT_HTTPS);
  if (graphemeLength(url) > MAX_LINK_URL_RUNES) throw new Error(CAP_LINK_URL_TOO_LONG);
}

const RUNE_ZWJ = 0x200d;
const RUNE_VARIATION_TEXT = 0xfe0e;
const RUNE_VARIATION_EMOJI = 0xfe0f;
const RUNE_KEYCAP = 0x20e3;
const RUNE_SKIN_TONE_LOW = 0x1f3fb;
const RUNE_SKIN_TONE_HIGH = 0x1f3ff;
const RUNE_REGIONAL_LOW = 0x1f1e6;
const RUNE_REGIONAL_HIGH = 0x1f1ff;
const RUNE_TAG_LOW = 0xe0020;
const RUNE_TAG_HIGH = 0xe007f;
const RUNE_PICTO_BLOCK_LOW = 0x1f000;
const RUNE_PICTO_BLOCK_HIGH = 0x1faff;
const RUNE_SYMBOLS_BLOCK_LOW = 0x2600;
const RUNE_SYMBOLS_BLOCK_HIGH = 0x27bf;

/**
 * The unicode symbol classes as the server reads them, floored at U+0080 so
 * ASCII punctuation cannot pass: `+`, `<`, `=`, `|` and `~` are all Sm, and a
 * bare `+` in the emoji slot renders as a pill with a plus sign in it. The two
 * block ranges come first because they carry the emoji the classes miss.
 */
const SYMBOL_CLASSES = /[\p{So}\p{Sm}]/u;

function isPictographic(codePoint: number): boolean {
  if (codePoint < 0x80) return false;
  if (codePoint >= RUNE_SYMBOLS_BLOCK_LOW && codePoint <= RUNE_SYMBOLS_BLOCK_HIGH) return true;
  if (codePoint >= RUNE_PICTO_BLOCK_LOW && codePoint <= RUNE_PICTO_BLOCK_HIGH) return true;
  return SYMBOL_CLASSES.test(String.fromCodePoint(codePoint));
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= RUNE_REGIONAL_LOW && codePoint <= RUNE_REGIONAL_HIGH;
}

function isSkinTone(codePoint: number): boolean {
  return codePoint >= RUNE_SKIN_TONE_LOW && codePoint <= RUNE_SKIN_TONE_HIGH;
}

function isTagChar(codePoint: number): boolean {
  return codePoint >= RUNE_TAG_LOW && codePoint <= RUNE_TAG_HIGH;
}

/** A keycap's base is a digit, `#` or `*` — the only ASCII legal in an emoji. */
function isKeycapBase(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a;
}

/**
 * "Is this exactly one emoji", AMENDMENT-06 §3. This is a rule-for-rule port
 * of the server's `validEmoji` (`backend-go/internal/botapi/emoji.go`), in its
 * order, and the python SDK carries the same port: §3 lets an SDK be looser
 * than the server, but two SDKs that disagree with each other would hand two
 * bot authors two different answers to the same emoji.
 *
 * True grapheme segmentation is deliberately NOT used even though node has
 * `Intl.Segmenter`. The server approximates segmentation from the unicode
 * tables and is a little permissive on purpose; segmenting here would refuse
 * sequences the server accepts, and a refusal a developer cannot act on is the
 * worse failure (R-10).
 *
 * The empty string is refused rather than treated as absent: an absent emoji
 * is the key missing from the button entirely, so a blank one is a value its
 * author meant, and the honest answer to it is no.
 */
function isSingleEmoji(value: string): boolean {
  const runes = [...value].map((char) => char.codePointAt(0) ?? 0);
  const first = runes[0];
  if (first === undefined) return false;
  // The outer bound before the runes are looked at individually. A flag is
  // two, a keycap three, and the longest family sequence in common use is
  // seven; anything past the bound is a paste, not an emoji.
  if (runes.length > MAX_BUTTON_EMOJI_RUNES) return false;

  // A flag is EXACTLY TWO regional indicators and nothing else. One is half a
  // flag and renders as a letter in a box; four is two flags.
  if (isRegionalIndicator(first)) {
    const second = runes[1];
    return runes.length === 2 && second !== undefined && isRegionalIndicator(second);
  }

  // A keycap's base is the only place an ASCII rune is legal, and only when
  // U+20E3 actually follows. A bare "1" is a digit, not an emoji.
  if (isKeycapBase(first)) {
    if (runes.length === 2) return runes[1] === RUNE_KEYCAP;
    if (runes.length === 3) {
      return runes[1] === RUNE_VARIATION_EMOJI && runes[2] === RUNE_KEYCAP;
    }
    return false;
  }

  if (!isPictographic(first)) return false;

  // EXACTLY ONE BASE. A later pictographic rune is legal only when the rune
  // before it was a ZWJ, which is what makes a family one emoji and two dice
  // two.
  let prev = first;
  for (const rune of runes.slice(1)) {
    if (rune === RUNE_ZWJ || rune === RUNE_VARIATION_TEXT || rune === RUNE_VARIATION_EMOJI) {
      // A joiner or a variation selector rides along freely.
    } else if (isSkinTone(rune) || isTagChar(rune)) {
      // So do skin tones and the tag characters of a subdivision flag.
    } else if (isRegionalIndicator(rune)) {
      // Only ever the two-rune flag handled above; glued onto a pictographic
      // base it is a second emoji.
      return false;
    } else if (isPictographic(rune)) {
      if (prev !== RUNE_ZWJ) return false;
    } else {
      return false;
    }
    prev = rune;
  }
  // A sequence that ends on a joiner is joined to nothing.
  return prev !== RUNE_ZWJ;
}

function requireEmoji(emoji: string): void {
  if (!isSingleEmoji(emoji)) throw new Error(CAP_INVALID_BUTTON_EMOJI);
}

export interface EmbedFieldValue {
  name: string;
  value: string;
  inline: boolean;
}

export interface EmbedAuthorValue {
  name: string;
  icon?: string;
  url?: string;
}

export interface EmbedThumbnailValue {
  url: string;
}

export interface EmbedImageValue {
  url: string;
}

export interface EmbedFooterValue {
  text: string;
  icon?: string;
}

export interface EmbedInit {
  title?: string;
  description?: string;
  color?: string;
  url?: string;
}

/**
 * `Embed().addField(...)` builder. Every mutation is validated immediately
 * (the cap sentence, thrown as a plain `Error`); `toJSON()` emits the wire
 * shape, omitting absent keys and omitting `fields` when empty.
 */
export class Embed {
  title?: string;
  description?: string;
  color?: string;
  url?: string;
  author?: EmbedAuthorValue;
  thumbnail?: EmbedThumbnailValue;
  image?: EmbedImageValue;
  fields: EmbedFieldValue[] = [];
  footer?: EmbedFooterValue;
  timestamp?: string;
  #extra: Record<string, unknown> = {};

  constructor(init: EmbedInit = {}) {
    if (init.title !== undefined) {
      if (init.title.length > MAX_TITLE_LENGTH) throw new Error(CAP_TITLE_TOO_LONG);
      this.title = init.title;
    }
    if (init.description !== undefined) {
      if (init.description.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error(CAP_DESCRIPTION_TOO_LONG);
      }
      this.description = init.description;
    }
    if (init.color !== undefined) this.color = init.color;
    if (init.url !== undefined) {
      if (this.title === undefined || this.title === '') {
        throw new Error(CAP_EMBED_URL_WITHOUT_TITLE);
      }
      requireLinkUrl(init.url);
      this.url = init.url;
    }
  }

  /** Refuses the 7th field on ONE embed — the whole-message cap (summed across embeds) is enforced by `serialiseEmbeds`. */
  addField(name: string, value: string, inline = false): this {
    if (this.fields.length >= MAX_EMBED_FIELDS) throw new Error(CAP_TOO_MANY_FIELDS);
    this.fields.push({ name, value, inline });
    return this;
  }

  setAuthor(name: string, icon?: string, url?: string): this {
    if (icon !== undefined) requireHttps(icon);
    if (url !== undefined) {
      if (name === '') throw new Error(CAP_AUTHOR_URL_WITHOUT_NAME);
      requireLinkUrl(url);
    }
    const author: EmbedAuthorValue = { name };
    if (icon !== undefined) author.icon = icon;
    if (url !== undefined) author.url = url;
    this.author = author;
    return this;
  }

  setThumbnail(url: string): this {
    requireHttps(url);
    this.thumbnail = { url };
    return this;
  }

  setImage(url: string): this {
    requireHttps(url);
    this.image = { url };
    return this;
  }

  setFooter(text: string, icon?: string): this {
    if (text === '') throw new Error(CAP_EMBED_FOOTER_TEXT_REQUIRED);
    if (icon !== undefined) requireHttps(icon);
    const footer: EmbedFooterValue = { text };
    if (icon !== undefined) footer.icon = icon;
    this.footer = footer;
    return this;
  }

  /** A `Date` becomes UTC RFC3339 (`Z`); a string is assumed already in that form. */
  setTimestamp(value: Date | string): this {
    this.timestamp = value instanceof Date ? value.toISOString() : value;
    return this;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.#extra };
    if (this.title !== undefined) out['title'] = this.title;
    if (this.description !== undefined) out['description'] = this.description;
    if (this.color !== undefined) out['color'] = this.color;
    if (this.url !== undefined) out['url'] = this.url;
    if (this.author !== undefined) out['author'] = this.author;
    if (this.thumbnail !== undefined) out['thumbnail'] = this.thumbnail;
    if (this.image !== undefined) out['image'] = this.image;
    if (this.fields.length > 0) out['fields'] = this.fields;
    if (this.footer !== undefined) out['footer'] = this.footer;
    if (this.timestamp !== undefined) out['timestamp'] = this.timestamp;
    return out;
  }

  /**
   * Tolerant decode — never throws, never validates. Used both for wire
   * messages (already server-validated) and to normalise a plain object
   * literal before `serialiseEmbeds` validates it for real. Unknown
   * top-level keys are preserved so a round trip is lossless.
   */
  static fromJSON(data: unknown): Embed {
    const record = asRecord(data) ?? {};
    const {
      title,
      description,
      color,
      url,
      author,
      thumbnail,
      image,
      fields,
      footer,
      timestamp,
      ...rest
    } = record;

    const embed = new Embed();
    const titleStr = asOptionalString(title);
    if (titleStr !== undefined) embed.title = titleStr;
    const descriptionStr = asOptionalString(description);
    if (descriptionStr !== undefined) embed.description = descriptionStr;
    const colorStr = asOptionalString(color);
    if (colorStr !== undefined) embed.color = colorStr;
    const urlStr = asOptionalString(url);
    if (urlStr !== undefined) embed.url = urlStr;

    const authorRecord = asRecord(author);
    if (authorRecord) {
      const name = asOptionalString(authorRecord['name']) ?? '';
      const icon = asOptionalString(authorRecord['icon']);
      const authorUrl = asOptionalString(authorRecord['url']);
      const decoded: EmbedAuthorValue = { name };
      if (icon !== undefined) decoded.icon = icon;
      if (authorUrl !== undefined) decoded.url = authorUrl;
      embed.author = decoded;
    }

    const thumbnailRecord = asRecord(thumbnail);
    const thumbnailUrl = thumbnailRecord ? asOptionalString(thumbnailRecord['url']) : undefined;
    if (thumbnailUrl !== undefined) embed.thumbnail = { url: thumbnailUrl };

    const imageRecord = asRecord(image);
    const imageUrl = imageRecord ? asOptionalString(imageRecord['url']) : undefined;
    if (imageUrl !== undefined) embed.image = { url: imageUrl };

    // A footer object with no text still lands, as `{ text: '' }`, so the
    // footer-needs-text cap bites on the raw-object path instead of the key
    // vanishing and the mistake going undiscovered.
    const footerRecord = asRecord(footer);
    if (footerRecord) {
      const footerText = asOptionalString(footerRecord['text']) ?? '';
      const footerIcon = asOptionalString(footerRecord['icon']);
      const decoded: EmbedFooterValue = { text: footerText };
      if (footerIcon !== undefined) decoded.icon = footerIcon;
      embed.footer = decoded;
    }

    const timestampStr = asOptionalString(timestamp);
    if (timestampStr !== undefined) embed.timestamp = timestampStr;

    if (Array.isArray(fields)) {
      for (const raw of fields) {
        const fieldRecord = asRecord(raw);
        if (!fieldRecord) continue;
        embed.fields.push({
          name: asOptionalString(fieldRecord['name']) ?? '',
          value: asOptionalString(fieldRecord['value']) ?? '',
          inline: fieldRecord['inline'] === true,
        });
      }
    }

    embed.#extra = rest;
    return embed;
  }
}

/** Every cap `serialiseEmbeds` enforces on one already-decoded `Embed`, whichever path built it. */
function validateEmbedShape(embed: Embed): void {
  if (embed.title !== undefined && embed.title.length > MAX_TITLE_LENGTH) {
    throw new Error(CAP_TITLE_TOO_LONG);
  }
  if (embed.description !== undefined && embed.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(CAP_DESCRIPTION_TOO_LONG);
  }
  if (embed.author?.icon !== undefined) requireHttps(embed.author.icon);
  if (embed.url !== undefined) {
    if (embed.title === undefined || embed.title === '') {
      throw new Error(CAP_EMBED_URL_WITHOUT_TITLE);
    }
    requireLinkUrl(embed.url);
  }
  if (embed.author?.url !== undefined) {
    if (embed.author.name === '') throw new Error(CAP_AUTHOR_URL_WITHOUT_NAME);
    requireLinkUrl(embed.author.url);
  }
  if (embed.footer !== undefined) {
    if (embed.footer.text === '') throw new Error(CAP_EMBED_FOOTER_TEXT_REQUIRED);
    if (embed.footer.icon !== undefined) requireHttps(embed.footer.icon);
  }
  if (embed.thumbnail !== undefined && !embed.thumbnail.url.startsWith('https://')) {
    throw new Error(CAP_IMAGE_URL_NOT_HTTPS);
  }
  if (embed.image !== undefined && !embed.image.url.startsWith('https://')) {
    throw new Error(CAP_IMAGE_URL_NOT_HTTPS);
  }
  if (embed.fields.length > MAX_EMBED_FIELDS) throw new Error(CAP_TOO_MANY_FIELDS);
}

export interface ButtonInit {
  label: string;
  id?: string;
  style?: string;
  emoji?: string;
  url?: string;
  /**
   * AMENDMENT-08 §3: this button's own cooldown, overriding the card-level
   * and bot-default one for this button only (precedence button > card >
   * bot). `undefined` (the default) inherits; `null` disables the default
   * for this one button; a `Cooldown` or a plain `{ rate, per, bucket? }`
   * literal attaches one. Refused at construction — before this button ever
   * reaches the wire — if `per` exceeds 60s, or if this is a `link` button
   * (a link press never round-trips, so it can never carry a cooldown).
   */
  cooldown?: CooldownOption;
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > MAX_BUTTON_ID_LENGTH
    ? slug.slice(0, MAX_BUTTON_ID_LENGTH).replace(/-+$/g, '')
    : slug;
}

function validateButtonShape(button: Button): void {
  // The label goes first: an emoji-only button is a missing label, not an
  // emoji problem, and saying so is what sends its author to the right fix.
  if (button.label === '') throw new Error(CAP_BUTTON_MISSING_LABEL);
  if (graphemeLength(button.label) > MAX_LABEL_RUNES) throw new Error(CAP_LABEL_TOO_LONG);
  if (button.id.length > MAX_BUTTON_ID_LENGTH) throw new Error(CAP_BUTTON_ID_TOO_LONG);
  if (!(BUTTON_STYLES as readonly string[]).includes(button.style)) {
    throw new Error(CAP_BAD_BUTTON_STYLE);
  }
  if (button.style === 'link') {
    if (button.url === undefined) throw new Error(CAP_LINK_BUTTON_MISSING_URL);
  } else if (button.url !== undefined) {
    throw new Error(CAP_URL_ON_NON_LINK_BUTTON);
  }
  if (button.url !== undefined) requireLinkUrl(button.url);
  // The emoji never counts toward the label cap (§3): it is its own field,
  // and folding it in would make one cap mean two things.
  if (button.emoji !== undefined) requireEmoji(button.emoji);
  // AMENDMENT-08 §3/§7: a link button never round-trips as `button.pressed`
  // (`press.go:96-107`), so a cooldown on one can never do anything. `null`
  // (explicitly "no cooldown") is allowed through — it asserts nothing this
  // button cannot honour — but attaching a real one is refused here, at
  // construction, rather than silently discarded.
  if (button.cooldown !== undefined) {
    if (button.style === 'link' && button.cooldown !== null) {
      throw new Error(CAP_LINK_BUTTON_COOLDOWN);
    }
    // `button.cooldown` is not `undefined` here (the outer guard), so
    // `normalizeCooldownOption` cannot hand back `undefined` either.
    button.cooldown = normalizeCooldownOption(button.cooldown, { boundToButton: true }) as
      | Cooldown
      | null;
  }
}

/** `new Button({ label: 'Pacific' })` — `id` defaults to a slug of `label`, `style` defaults to `'primary'`. */
export class Button {
  label: string;
  id: string;
  style: string;
  emoji?: string;
  url?: string;
  /**
   * This button's own cooldown (AMENDMENT-08 §3), normalized to a real
   * `Cooldown` by `validateButtonShape` (a plain literal in, a `Cooldown`
   * out — `null` passes through unchanged). Absent entirely when the
   * developer never set one, which reads as "inherit" at resolution time.
   * Never serialized: `toJSON()` does not carry it, because a cooldown is
   * SDK-side state that never reaches the wire (§2).
   */
  cooldown?: Cooldown | null;

  constructor(init: ButtonInit) {
    this.label = init.label;
    this.style = init.style ?? 'primary';
    this.id = init.id ?? slugify(init.label);
    if (init.emoji !== undefined) this.emoji = init.emoji;
    if (init.url !== undefined) this.url = init.url;
    // Raw (possibly a literal, not yet a `Cooldown`) until `validateButtonShape`
    // normalizes it below — the field's public type is its POST-validation
    // shape, matching every other builder field this constructor validates
    // through the same call.
    if (init.cooldown !== undefined) this.cooldown = init.cooldown as unknown as Cooldown | null;
    validateButtonShape(this);
  }

  /**
   * The sanctioned way to build a link pill (AMENDMENT-06 §11): a url is not
   * optional here, so the shape that raises `a link button needs a url` is
   * one a caller has to go out of their way to write. A tap opens the url on
   * the device and stops — a link button never round-trips as `button.pressed`
   * and never flips the row.
   */
  static link(init: { label: string; url: string; id?: string; emoji?: string }): Button {
    const build: ButtonInit = { label: init.label, style: 'link', url: init.url };
    if (init.id !== undefined) build.id = init.id;
    if (init.emoji !== undefined) build.emoji = init.emoji;
    return new Button(build);
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { id: this.id, label: this.label, style: this.style };
    if (this.emoji !== undefined) out['emoji'] = this.emoji;
    if (this.url !== undefined) out['url'] = this.url;
    return out;
  }

  /** Tolerant decode — never throws. See `Embed.fromJSON` for why. */
  static fromJSON(data: unknown): Button {
    const record = asRecord(data) ?? {};
    const label = asOptionalString(record['label']) ?? '';
    const id = asOptionalString(record['id']);
    const style = asOptionalString(record['style']);
    const emoji = asOptionalString(record['emoji']);
    const url = asOptionalString(record['url']);
    const button = Object.create(Button.prototype) as Button;
    button.label = label;
    button.style = style ?? 'primary';
    button.id = id ?? slugify(label);
    if (emoji !== undefined) button.emoji = emoji;
    if (url !== undefined) button.url = url;
    // Never present on a real wire button (cooldowns never reach the wire,
    // §2) — this only matters for the OTHER caller of `fromJSON`,
    // `serialiseButtonsWithCooldowns` decoding a plain-object `ButtonLike` a
    // developer passed straight to `send`/`reply`/`edit`/`ack`. Carried
    // through raw (possibly still a literal); `validateButtonShape`
    // normalizes it, exactly as it does for a real `new Button(...)`.
    if ('cooldown' in record) {
      button.cooldown = record['cooldown'] as unknown as Cooldown | null;
    }
    return button;
  }
}

export interface ButtonUsed {
  button: string;
  user: string;
  at: string;
}

/** `null` for both an absent key and a JSON `null` — a message's `button_used` is never `undefined`. */
export function buttonUsedFromWire(value: unknown): ButtonUsed | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    button: asOptionalString(record['button']) ?? '',
    user: asOptionalString(record['user']) ?? '',
    at: asOptionalString(record['at']) ?? '',
  };
}

/** `[]` for both an absent key and a JSON `null` — `Message.embeds` is never `null`/`undefined`. */
export function embedsFromWire(value: unknown): Embed[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Embed.fromJSON(entry));
}

/** `[]` for both an absent key and a JSON `null` — `Message.buttons` is never `null`/`undefined`. */
export function buttonsFromWire(value: unknown): Button[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Button.fromJSON(entry));
}

export type EmbedLike = Embed | Record<string, unknown>;
export type ButtonLike = Button | Record<string, unknown>;

/**
 * Validates and serialises the `embeds` a caller passed to `send`/`reply`,
 * to shape (a). A plain object literal is decoded (tolerant) then validated
 * exactly as a builder is — never a bypass. `[]` when `embeds` is absent or
 * empty, so the caller omits the key.
 */
export function serialiseEmbeds(
  embeds: ReadonlyArray<EmbedLike> | undefined,
): Record<string, unknown>[] {
  if (embeds === undefined || embeds.length === 0) return [];
  if (embeds.length > MAX_EMBEDS) throw new Error(CAP_TOO_MANY_EMBEDS);
  const normalised = embeds.map((entry) =>
    entry instanceof Embed ? entry : Embed.fromJSON(entry),
  );
  for (const embed of normalised) validateEmbedShape(embed);
  const totalFields = normalised.reduce((sum, embed) => sum + embed.fields.length, 0);
  if (totalFields > MAX_EMBED_FIELDS) throw new Error(CAP_TOO_MANY_FIELDS);
  return normalised.map((embed) => embed.toJSON());
}

/** `serialiseButtonsWithCooldowns`'s return shape: the wire JSON, plus every button's cooldown (only the buttons that carried one — inherited buttons are simply absent from the map). */
export interface SerialisedButtons {
  json: Record<string, unknown>[];
  /** button id -> its own `Cooldown` (`null` means explicitly disabled). A button not in this map inherits from the card, then the bot default (§3). */
  cooldowns: ReadonlyMap<string, Cooldown | null>;
}

/**
 * Validates and serialises the `buttons` a caller passed to
 * `send`/`reply`/`edit`/`ack`, exactly as `serialiseButtons` does, and ALSO
 * returns each button's own resolved cooldown (AMENDMENT-08 §3) — the
 * per-button overrides `bot.ts`'s card lookup table (`cooldown.ts`'s
 * `CardCooldownTable`) needs to resolve a later press, since the
 * `button.pressed` event that press produces carries only ids, never the
 * `Button` objects this call was given. One validation pass; `serialiseButtons`
 * is a thin wrapper around this for callers that only want the wire shape.
 */
export function serialiseButtonsWithCooldowns(
  buttons: ReadonlyArray<ButtonLike> | undefined,
): SerialisedButtons {
  if (buttons === undefined || buttons.length === 0) return { json: [], cooldowns: new Map() };
  if (buttons.length > MAX_BUTTONS) throw new Error(CAP_TOO_MANY_BUTTONS);
  const normalised = buttons.map((entry) =>
    entry instanceof Button ? entry : Button.fromJSON(entry),
  );
  for (const button of normalised) validateButtonShape(button);
  const seen = new Set<string>();
  const cooldowns = new Map<string, Cooldown | null>();
  for (const button of normalised) {
    if (seen.has(button.id)) throw new Error(CAP_DUPLICATE_BUTTON_ID);
    seen.add(button.id);
    if (button.cooldown !== undefined) cooldowns.set(button.id, button.cooldown);
  }
  return { json: normalised.map((button) => button.toJSON()), cooldowns };
}

/**
 * Validates and serialises the `buttons` a caller passed to `send`/`reply`.
 * `[]` when `buttons` is absent or empty, so the caller omits the key.
 */
export function serialiseButtons(
  buttons: ReadonlyArray<ButtonLike> | undefined,
): Record<string, unknown>[] {
  return serialiseButtonsWithCooldowns(buttons).json;
}
