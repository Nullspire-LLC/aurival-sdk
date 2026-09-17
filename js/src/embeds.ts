/**
 * Discord-shaped `Embed` and `Button` builders (AMENDMENT-05). Mirrors
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
  CAP_BAD_BUTTON_STYLE,
  CAP_BUTTON_ID_TOO_LONG,
  CAP_DESCRIPTION_TOO_LONG,
  CAP_DUPLICATE_BUTTON_ID,
  CAP_IMAGE_URL_NOT_HTTPS,
  CAP_LABEL_TOO_LONG,
  CAP_LINK_STYLE_DEFERRED,
  CAP_TITLE_TOO_LONG,
  CAP_TOO_MANY_BUTTONS,
  CAP_TOO_MANY_EMBEDS,
  CAP_TOO_MANY_FIELDS,
  MAX_BUTTON_ID_LENGTH,
  MAX_BUTTONS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EMBED_FIELDS,
  MAX_EMBEDS,
  MAX_LABEL_RUNES,
  MAX_TITLE_LENGTH,
} from './caps.js';

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

function requireHttps(url: string): void {
  if (!url.startsWith('https://')) throw new Error(CAP_IMAGE_URL_NOT_HTTPS);
}

export interface EmbedFieldValue {
  name: string;
  value: string;
  inline: boolean;
}

export interface EmbedAuthorValue {
  name: string;
  icon?: string;
}

export interface EmbedThumbnailValue {
  url: string;
}

export interface EmbedImageValue {
  url: string;
}

export interface EmbedFooterValue {
  text: string;
}

export interface EmbedInit {
  title?: string;
  description?: string;
  color?: string;
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
  }

  /** Refuses the 7th field on ONE embed — the whole-message cap (summed across embeds) is enforced by `serialiseEmbeds`. */
  addField(name: string, value: string, inline = false): this {
    if (this.fields.length >= MAX_EMBED_FIELDS) throw new Error(CAP_TOO_MANY_FIELDS);
    this.fields.push({ name, value, inline });
    return this;
  }

  setAuthor(name: string, icon?: string): this {
    if (icon !== undefined) {
      requireHttps(icon);
      this.author = { name, icon };
    } else {
      this.author = { name };
    }
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

  setFooter(text: string): this {
    this.footer = { text };
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

    const authorRecord = asRecord(author);
    if (authorRecord) {
      const name = asOptionalString(authorRecord['name']) ?? '';
      const icon = asOptionalString(authorRecord['icon']);
      embed.author = icon !== undefined ? { name, icon } : { name };
    }

    const thumbnailRecord = asRecord(thumbnail);
    const thumbnailUrl = thumbnailRecord ? asOptionalString(thumbnailRecord['url']) : undefined;
    if (thumbnailUrl !== undefined) embed.thumbnail = { url: thumbnailUrl };

    const imageRecord = asRecord(image);
    const imageUrl = imageRecord ? asOptionalString(imageRecord['url']) : undefined;
    if (imageUrl !== undefined) embed.image = { url: imageUrl };

    const footerRecord = asRecord(footer);
    const footerText = footerRecord ? asOptionalString(footerRecord['text']) : undefined;
    if (footerText !== undefined) embed.footer = { text: footerText };

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
  if (embed.author?.icon !== undefined && !embed.author.icon.startsWith('https://')) {
    throw new Error(CAP_IMAGE_URL_NOT_HTTPS);
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
  if (graphemeLength(button.label) > MAX_LABEL_RUNES) throw new Error(CAP_LABEL_TOO_LONG);
  if (button.id.length > MAX_BUTTON_ID_LENGTH) throw new Error(CAP_BUTTON_ID_TOO_LONG);
  if (button.style === 'link') throw new Error(CAP_LINK_STYLE_DEFERRED);
  if (!(BUTTON_STYLES as readonly string[]).includes(button.style)) {
    throw new Error(CAP_BAD_BUTTON_STYLE);
  }
}

/** `new Button({ label: 'Pacific' })` — `id` defaults to a slug of `label`, `style` defaults to `'primary'`. */
export class Button {
  label: string;
  id: string;
  style: string;

  constructor(init: ButtonInit) {
    this.label = init.label;
    this.style = init.style ?? 'primary';
    this.id = init.id ?? slugify(init.label);
    validateButtonShape(this);
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, label: this.label, style: this.style };
  }

  /** Tolerant decode — never throws. See `Embed.fromJSON` for why. */
  static fromJSON(data: unknown): Button {
    const record = asRecord(data) ?? {};
    const label = asOptionalString(record['label']) ?? '';
    const id = asOptionalString(record['id']);
    const style = asOptionalString(record['style']);
    const button = Object.create(Button.prototype) as Button;
    button.label = label;
    button.style = style ?? 'primary';
    button.id = id ?? slugify(label);
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

/**
 * Validates and serialises the `buttons` a caller passed to `send`/`reply`.
 * `[]` when `buttons` is absent or empty, so the caller omits the key.
 */
export function serialiseButtons(
  buttons: ReadonlyArray<ButtonLike> | undefined,
): Record<string, unknown>[] {
  if (buttons === undefined || buttons.length === 0) return [];
  if (buttons.length > MAX_BUTTONS) throw new Error(CAP_TOO_MANY_BUTTONS);
  const normalised = buttons.map((entry) =>
    entry instanceof Button ? entry : Button.fromJSON(entry),
  );
  for (const button of normalised) validateButtonShape(button);
  const seen = new Set<string>();
  for (const button of normalised) {
    if (seen.has(button.id)) throw new Error(CAP_DUPLICATE_BUTTON_ID);
    seen.add(button.id);
  }
  return normalised.map((button) => button.toJSON());
}
