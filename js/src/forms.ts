/**
 * Bot card forms (AMENDMENT-10). A form button opens a sheet of up to five
 * typed fields; the person submits and only the bot receives the answers, as
 * a `form.submitted` event.
 *
 * Two pieces live here:
 *
 *   - `Field.string / paragraph / integer / decimal / email / url / phone /
 *     select / boolean`, one constructor per wire type. Each validates its
 *     options against AMENDMENT-10 §1 the moment it is called (the allowed
 *     properties table, the length caps, the bounds, the typed prefill) and
 *     throws a plain `Error` whose message starts with a JSON pointer, the
 *     same style `embeds.ts` uses for its caps.
 *   - `defineForm({ id, title, fields })`, which checks the form-level caps
 *     and returns a `FormDefinition`. Its type carries the shape of the
 *     answers, so `bot.onForm(form, (ctx) => ctx.values.seats)` is typed
 *     from the fields with no annotation.
 *
 * A `FormDefinition` serialises (`toJSON`) to the `form` object of the wire
 * button, snake_case, `fields` as an array in declaration order.
 */

import {
  CAP_BUTTON_ID_TOO_LONG,
  DEFAULT_DECIMAL_SCALE,
  DEFAULT_PARAGRAPH_MAX_LENGTH,
  DEFAULT_STRING_MAX_LENGTH,
  FORM_SUBMISSIONS,
  MAX_DECIMAL_SCALE,
  MAX_EMAIL_LENGTH,
  MAX_FORM_DECIMAL_ABS,
  MAX_FORM_FIELDS,
  MAX_FORM_FIELD_ID_LENGTH,
  MAX_FORM_FIELD_LABEL_RUNES,
  MAX_FORM_INTEGER,
  MAX_FORM_OPTIONS,
  MAX_FORM_OPTION_LABEL_RUNES,
  MAX_FORM_OPTION_VALUE_LENGTH,
  MAX_FORM_PLACEHOLDER_RUNES,
  MAX_FORM_SUBMIT_LABEL_RUNES,
  MAX_FORM_TITLE_RUNES,
  MAX_FORM_URL_LENGTH,
  MAX_BUTTON_ID_LENGTH,
  MAX_PARAGRAPH_MAX_LENGTH,
  MAX_STRING_MAX_LENGTH,
  MIN_FORM_OPTIONS,
} from './caps.js';

/** The nine wire field types (AMENDMENT-10 §1). */
export const FIELD_TYPES = [
  'string',
  'paragraph',
  'integer',
  'decimal',
  'email',
  'url',
  'phone',
  'select',
  'boolean',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type FormSubmission = (typeof FORM_SUBMISSIONS)[number];

/** One entry of a `select` field. `value` is `[a-z0-9_]` up to 32; `label` up to 45. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface TextOpts {
  label: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  value?: string;
}

/** `Field.string`: one line. `maxLength` defaults to 100, cap 200. */
export type StringOpts = TextOpts;
/** `Field.paragraph`: several lines. `maxLength` defaults to 1000, cap 4000. */
export type ParagraphOpts = TextOpts;
/** `Field.email`: `maxLength` is at most 254. */
export type EmailOpts = TextOpts;
/** `Field.url`: `maxLength` is at most 2048. */
export type UrlOpts = TextOpts;
/** `Field.phone`: 7 to 15 digits, kept as a string. */
export type PhoneOpts = TextOpts;

/** `Field.integer`: a whole number within +/-(2^53 - 1). */
export interface IntegerOpts {
  label: string;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  value?: number;
}

/**
 * `Field.decimal`: `min`/`max` may be numbers or decimal strings (a string is
 * how a bound beyond 15 significant digits stays exact). `scale` is 0 to 6,
 * default 2. The answer arrives as a JS `number`; use `ctx.rawValues` when
 * the exact text matters.
 */
export interface DecimalOpts {
  label: string;
  placeholder?: string;
  required?: boolean;
  min?: number | string;
  max?: number | string;
  scale?: number;
  value?: number;
}

/** `Field.select`: 2 to 10 options, shown as rows in the sheet. No placeholder. */
export interface SelectOpts {
  label: string;
  required?: boolean;
  options: readonly SelectOption[];
  value?: string;
}

/** `Field.boolean`: a switch. Always answered (default false), so no `required` and no placeholder. */
export interface BooleanOpts {
  label: string;
  value?: boolean;
}

/**
 * `required: false` makes the answer nullable. `required: true` or an absent
 * `required` is the default and keeps the plain type. A non-literal
 * `required: boolean` could be either, so it widens to `T | null`.
 */
type WithRequired<O, T> = 'required' extends keyof O
  ? O extends { readonly required: true }
    ? T
    : O extends { readonly required: false }
      ? T | null
      : T | null
  : T;

type OptionValue<O> = O extends { readonly options: ReadonlyArray<{ readonly value: infer V }> }
  ? V extends string
    ? V
    : never
  : never;

const FIELD_ALLOWED: Readonly<Record<FieldType, ReadonlySet<string>>> = {
  string: new Set(['label', 'placeholder', 'required', 'minLength', 'maxLength', 'value']),
  paragraph: new Set(['label', 'placeholder', 'required', 'minLength', 'maxLength', 'value']),
  integer: new Set(['label', 'placeholder', 'required', 'min', 'max', 'value']),
  decimal: new Set(['label', 'placeholder', 'required', 'min', 'max', 'scale', 'value']),
  email: new Set(['label', 'placeholder', 'required', 'minLength', 'maxLength', 'value']),
  url: new Set(['label', 'placeholder', 'required', 'minLength', 'maxLength', 'value']),
  phone: new Set(['label', 'placeholder', 'required', 'minLength', 'maxLength', 'value']),
  select: new Set(['label', 'required', 'options', 'value']),
  boolean: new Set(['label', 'value']),
};

/** camelCase option -> snake_case wire key, in the order the wire object is written. */
const WIRE_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['label', 'label'],
  ['placeholder', 'placeholder'],
  ['required', 'required'],
  ['minLength', 'min_length'],
  ['maxLength', 'max_length'],
  ['min', 'min'],
  ['max', 'max'],
  ['scale', 'scale'],
  ['options', 'options'],
  ['value', 'value'],
];

function runes(text: string): number {
  return [...text].length;
}

function fail(pointer: string, reason: string): never {
  throw new Error(`${pointer}: ${reason}`);
}

function isWhole(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

const OPTION_VALUE = /^[a-z0-9_]+$/;
const FIELD_ID = /^[a-z0-9_]+$/;
const DECIMAL_TEXT = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** A decimal bound as a JS number, for comparison only; `null` when it is not a bound at all. */
function decimalBound(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && DECIMAL_TEXT.test(raw)) return Number(raw);
  return null;
}

/** Digits after the decimal point of a finite JS number's shortest text, or `null` for exponent notation. */
function placesOf(n: number): number | null {
  const text = String(n);
  if (/e/i.test(text)) return null;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * One validated field, without its id (the id is the key in `defineForm`'s
 * `fields`). The `V` parameter is the type of the answer a bot receives for
 * it and exists only for the compiler.
 */
export class FieldSpec<V = unknown> {
  /** Type-only carrier for the answer type; never set at runtime. */
  declare readonly _value: V;
  readonly type: FieldType;
  readonly #wire: Readonly<Record<string, unknown>>;

  /** @internal Use `Field.*`; the constructor trusts an already validated wire object. */
  constructor(type: FieldType, wire: Record<string, unknown>) {
    this.type = type;
    this.#wire = Object.freeze({ ...wire });
  }

  /** The wire field without its `id`: `{ type, label, ... }`, snake_case. */
  toJSON(): Record<string, unknown> {
    return { type: this.type, ...this.#wire };
  }

  /** The wire field with its id first, as it appears in `form.fields`. */
  toWire(id: string): Record<string, unknown> {
    return { id, type: this.type, ...this.#wire };
  }
}

/** Common checks, then the type's own. Returns the wire object (without `type`). */
function build(type: FieldType, opts: unknown): Record<string, unknown> {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error(`/: Field.${type} takes an options object`);
  }
  const given = opts as Record<string, unknown>;
  const allowed = FIELD_ALLOWED[type];
  for (const key of Object.keys(given)) {
    if (given[key] === undefined) continue;
    if (!allowed.has(key)) {
      fail(`/${key}`, `a ${type} field does not allow ${key}`);
    }
  }

  const label = given['label'];
  if (typeof label !== 'string' || label === '') {
    fail('/label', 'a field needs a label');
  }
  if (runes(label) > MAX_FORM_FIELD_LABEL_RUNES) {
    fail('/label', `a field label is at most ${MAX_FORM_FIELD_LABEL_RUNES} characters`);
  }

  const placeholder = given['placeholder'];
  if (placeholder !== undefined) {
    if (typeof placeholder !== 'string') fail('/placeholder', 'a placeholder is text');
    if (runes(placeholder) > MAX_FORM_PLACEHOLDER_RUNES) {
      fail(
        '/placeholder',
        `a field placeholder is at most ${MAX_FORM_PLACEHOLDER_RUNES} characters`,
      );
    }
  }
  const required = given['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    fail('/required', 'required is true or false');
  }

  switch (type) {
    case 'string':
    case 'paragraph':
    case 'email':
    case 'url':
    case 'phone':
      checkText(type, given);
      break;
    case 'integer':
      checkInteger(given);
      break;
    case 'decimal':
      checkDecimal(given);
      break;
    case 'select':
      checkSelect(given);
      break;
    case 'boolean':
      if (given['value'] !== undefined && typeof given['value'] !== 'boolean') {
        fail('/value', 'a boolean field is prefilled with true or false');
      }
      break;
  }

  const wire: Record<string, unknown> = {};
  for (const [camel, snake] of WIRE_ORDER) {
    const v = given[camel];
    if (v === undefined) continue;
    wire[snake] = camel === 'options' ? (v as readonly SelectOption[]).map(optionWire) : v;
  }
  return wire;
}

function optionWire(option: SelectOption): Record<string, unknown> {
  return { value: option.value, label: option.label };
}

/** The server's max_length cap and default for a text type; phone has no default or cap of its own. */
function textLimits(type: FieldType): { fallback: number | null; cap: number | null } {
  switch (type) {
    case 'string':
      return { fallback: DEFAULT_STRING_MAX_LENGTH, cap: MAX_STRING_MAX_LENGTH };
    case 'paragraph':
      return { fallback: DEFAULT_PARAGRAPH_MAX_LENGTH, cap: MAX_PARAGRAPH_MAX_LENGTH };
    case 'email':
      return { fallback: MAX_EMAIL_LENGTH, cap: MAX_EMAIL_LENGTH };
    case 'url':
      return { fallback: MAX_FORM_URL_LENGTH, cap: MAX_FORM_URL_LENGTH };
    default:
      return { fallback: null, cap: null };
  }
}

function checkText(type: FieldType, given: Record<string, unknown>): void {
  const { fallback, cap } = textLimits(type);
  const min = given['minLength'];
  const max = given['maxLength'];
  if (min !== undefined && (!isWhole(min) || min < 0)) {
    fail('/minLength', 'minLength is a whole number, 0 or more');
  }
  if (max !== undefined && (!isWhole(max) || max < 1)) {
    fail('/maxLength', 'maxLength is a whole number, 1 or more');
  }
  if (max !== undefined && cap !== null && (max as number) > cap) {
    fail('/maxLength', `a ${type} field's maxLength is at most ${cap}`);
  }
  const effectiveMax = (max as number | undefined) ?? fallback;
  if (min !== undefined && effectiveMax !== null && (min as number) > effectiveMax) {
    fail('/minLength', 'minLength must not exceed maxLength');
  }
  const value = given['value'];
  if (value !== undefined) {
    if (typeof value !== 'string') fail('/value', `a ${type} field is prefilled with text`);
    const length = runes(value);
    if (effectiveMax !== null && length > effectiveMax) {
      fail('/value', `the prefill is longer than maxLength (${effectiveMax})`);
    }
    if (min !== undefined && length < (min as number)) {
      fail('/value', 'the prefill is shorter than minLength');
    }
  }
}

function checkInteger(given: Record<string, unknown>): void {
  const min = given['min'];
  const max = given['max'];
  for (const [key, bound] of [
    ['min', min],
    ['max', max],
  ] as const) {
    if (bound !== undefined && !(typeof bound === 'number' && Number.isSafeInteger(bound))) {
      fail(`/${key}`, `an integer field's ${key} is a whole number within +/-${MAX_FORM_INTEGER}`);
    }
  }
  if (min !== undefined && max !== undefined && (min as number) > (max as number)) {
    fail('/min', 'min must not exceed max');
  }
  const value = given['value'];
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      fail('/value', 'an integer field is prefilled with a whole number');
    }
    if (min !== undefined && value < (min as number)) fail('/value', 'the prefill is below min');
    if (max !== undefined && value > (max as number)) fail('/value', 'the prefill is above max');
  }
}

function checkDecimal(given: Record<string, unknown>): void {
  const scale = given['scale'];
  if (scale !== undefined && !(isWhole(scale) && scale >= 0 && scale <= MAX_DECIMAL_SCALE)) {
    fail('/scale', `scale is a whole number from 0 to ${MAX_DECIMAL_SCALE}`);
  }
  const effectiveScale = (scale as number | undefined) ?? DEFAULT_DECIMAL_SCALE;
  const bounds: Record<string, number> = {};
  for (const key of ['min', 'max'] as const) {
    const raw = given[key];
    if (raw === undefined) continue;
    const n = decimalBound(raw);
    if (n === null || Math.abs(n) > MAX_FORM_DECIMAL_ABS) {
      fail(`/${key}`, `a decimal field's ${key} is a number within +/-${MAX_FORM_DECIMAL_ABS}`);
    }
    bounds[key] = n;
  }
  const lo = bounds['min'];
  const hi = bounds['max'];
  if (lo !== undefined && hi !== undefined && lo > hi) fail('/min', 'min must not exceed max');
  const value = given['value'];
  if (value !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('/value', 'a decimal field is prefilled with a number');
    }
    if (Math.abs(value) > MAX_FORM_DECIMAL_ABS) {
      fail('/value', `the prefill is beyond +/-${MAX_FORM_DECIMAL_ABS}`);
    }
    const places = placesOf(value);
    if (places === null || places > effectiveScale) {
      fail('/value', `the prefill has more than ${effectiveScale} decimal places`);
    }
    if (lo !== undefined && value < lo) fail('/value', 'the prefill is below min');
    if (hi !== undefined && value > hi) fail('/value', 'the prefill is above max');
  }
}

function checkSelect(given: Record<string, unknown>): void {
  const options = given['options'];
  if (!Array.isArray(options)) fail('/options', 'a select field needs options');
  if (options.length < MIN_FORM_OPTIONS || options.length > MAX_FORM_OPTIONS) {
    fail('/options', `a select field has ${MIN_FORM_OPTIONS} to ${MAX_FORM_OPTIONS} options`);
  }
  const seen = new Set<string>();
  options.forEach((entry: unknown, index) => {
    const at = `/options/${index}`;
    if (typeof entry !== 'object' || entry === null) fail(at, 'an option is { value, label }');
    const { value, label } = entry as Record<string, unknown>;
    if (
      typeof value !== 'string' ||
      value === '' ||
      value.length > MAX_FORM_OPTION_VALUE_LENGTH ||
      !OPTION_VALUE.test(value)
    ) {
      fail(
        `${at}/value`,
        `an option value is 1 to ${MAX_FORM_OPTION_VALUE_LENGTH} characters of a-z, 0-9 and _`,
      );
    }
    if (typeof label !== 'string' || label === '' || runes(label) > MAX_FORM_OPTION_LABEL_RUNES) {
      fail(`${at}/label`, `an option label is 1 to ${MAX_FORM_OPTION_LABEL_RUNES} characters`);
    }
    if (seen.has(value)) fail(`${at}/value`, 'an option value must be unique');
    seen.add(value);
  });
  const value = given['value'];
  if (value !== undefined && !(typeof value === 'string' && seen.has(value))) {
    fail('/value', 'the prefill must be one of the option values');
  }
}

/** The nine field constructors. Each returns a `FieldSpec` typed with the answer a bot receives. */
export const Field = {
  /** One line of text. Answer: `string`, or `null` when `required: false` and left empty. */
  string<const O extends StringOpts>(opts: O): FieldSpec<WithRequired<O, string>> {
    return new FieldSpec('string', build('string', opts));
  },
  /** Several lines of text. Answer: `string`. */
  paragraph<const O extends ParagraphOpts>(opts: O): FieldSpec<WithRequired<O, string>> {
    return new FieldSpec('paragraph', build('paragraph', opts));
  },
  /** A whole number. Answer: `number`. */
  integer<const O extends IntegerOpts>(opts: O): FieldSpec<WithRequired<O, number>> {
    return new FieldSpec('integer', build('integer', opts));
  },
  /**
   * A decimal number. Answer: `number`, which is a double: `2.10` arrives as
   * `2.1` and more than about 15 significant digits lose precision. Read
   * `ctx.rawValues` when the exact text matters.
   */
  decimal<const O extends DecimalOpts>(opts: O): FieldSpec<WithRequired<O, number>> {
    return new FieldSpec('decimal', build('decimal', opts));
  },
  /** An email address, normalised by the server. Answer: `string`. */
  email<const O extends EmailOpts>(opts: O): FieldSpec<WithRequired<O, string>> {
    return new FieldSpec('email', build('email', opts));
  },
  /** An http or https URL, normalised by the server. Answer: `string`. */
  url<const O extends UrlOpts>(opts: O): FieldSpec<WithRequired<O, string>> {
    return new FieldSpec('url', build('url', opts));
  },
  /** A phone number, digits and an optional leading plus. Answer: `string`, never a number. */
  phone<const O extends PhoneOpts>(opts: O): FieldSpec<WithRequired<O, string>> {
    return new FieldSpec('phone', build('phone', opts));
  },
  /** One of 2 to 10 options. Answer: the chosen option's `value`. */
  select<const O extends SelectOpts>(opts: O): FieldSpec<WithRequired<O, OptionValue<O>>> {
    return new FieldSpec('select', build('select', opts));
  },
  /** A switch. Answer: `boolean`, never `null`. */
  boolean<const O extends BooleanOpts>(opts: O): FieldSpec<boolean> {
    return new FieldSpec('boolean', build('boolean', opts));
  },
} as const;

/** `defineForm`'s input. `fields` is an object keyed by field id, in display order. */
export interface FormInit {
  /** The form button's id (1 to 32 characters). `bot.onForm` matches on it. */
  readonly id: string;
  /** The sheet heading, 1 to 45 characters. */
  readonly title: string;
  /** The submit button's text, 1 to 24 characters. The client's own "Submit" when omitted. */
  readonly submitLabel?: string;
  /** `per_user` (default): each member answers once. `once`: the first accepted answer closes it for everyone. */
  readonly submission?: FormSubmission;
  /** 1 to 5 fields, keyed by field id (`[a-z0-9_]`, 1 to 32). */
  readonly fields: { readonly [id: string]: FieldSpec<unknown> };
}

/** The typed answers of a form: one entry per field id. */
export type FormValues<F extends { readonly [id: string]: FieldSpec<unknown> }> = {
  -readonly [K in keyof F]: F[K] extends FieldSpec<infer V> ? V : never;
};

/** The answers as they arrive when no form type is known: a primitive per field id. */
export type AnyFormValues = { readonly [id: string]: string | number | boolean | null };

/**
 * A validated form. `toJSON()` is the wire `form` object (AMENDMENT-10 §1);
 * the button id is `id`, not part of it.
 */
export class FormDefinition<V extends object = AnyFormValues> {
  /** Type-only carrier for the typed answers; never set at runtime. */
  declare readonly _values: V;
  readonly id: string;
  readonly title: string;
  readonly submitLabel: string | undefined;
  readonly submission: FormSubmission | undefined;
  readonly fields: ReadonlyArray<{ readonly id: string; readonly spec: FieldSpec<unknown> }>;

  /** @internal Use `defineForm`. */
  constructor(init: {
    id: string;
    title: string;
    submitLabel: string | undefined;
    submission: FormSubmission | undefined;
    fields: ReadonlyArray<{ readonly id: string; readonly spec: FieldSpec<unknown> }>;
  }) {
    this.id = init.id;
    this.title = init.title;
    this.submitLabel = init.submitLabel;
    this.submission = init.submission;
    this.fields = Object.freeze([...init.fields]);
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { title: this.title };
    if (this.submitLabel !== undefined) out['submit_label'] = this.submitLabel;
    if (this.submission !== undefined) out['submission'] = this.submission;
    out['fields'] = this.fields.map((field) => field.spec.toWire(field.id));
    return out;
  }
}

/**
 * Validates a form and returns its definition. Pass the literal directly (or
 * with `as const`) so the answer type is inferred from the fields.
 */
export function defineForm<const F extends FormInit>(
  init: F,
): FormDefinition<FormValues<F['fields']>> {
  if (typeof init.id !== 'string' || init.id === '') fail('/id', 'a form needs an id');
  if (init.id.length > MAX_BUTTON_ID_LENGTH) fail('/id', CAP_BUTTON_ID_TOO_LONG);
  if (typeof init.title !== 'string' || init.title === '') fail('/title', 'a form needs a title');
  if (runes(init.title) > MAX_FORM_TITLE_RUNES) {
    fail('/title', `a form title is at most ${MAX_FORM_TITLE_RUNES} characters`);
  }
  if (init.submitLabel !== undefined) {
    if (typeof init.submitLabel !== 'string' || init.submitLabel === '') {
      fail('/submit_label', 'a submit label is 1 or more characters');
    }
    if (runes(init.submitLabel) > MAX_FORM_SUBMIT_LABEL_RUNES) {
      fail('/submit_label', `a submit label is at most ${MAX_FORM_SUBMIT_LABEL_RUNES} characters`);
    }
  }
  if (
    init.submission !== undefined &&
    !(FORM_SUBMISSIONS as readonly string[]).includes(init.submission)
  ) {
    fail('/submission', `submission is one of ${FORM_SUBMISSIONS.join(', ')}`);
  }
  const source: unknown = init.fields;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    fail('/fields', 'fields is an object keyed by field id');
  }
  const entries = Object.entries(source as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_FORM_FIELDS) {
    fail('/fields', `a form has 1 to ${MAX_FORM_FIELDS} fields`);
  }
  const fields: Array<{ id: string; spec: FieldSpec<unknown> }> = [];
  for (const [id, spec] of entries) {
    if (id.length < 1 || id.length > MAX_FORM_FIELD_ID_LENGTH || !FIELD_ID.test(id)) {
      fail(
        `/fields/${id}`,
        `a field id is 1 to ${MAX_FORM_FIELD_ID_LENGTH} characters of a-z, 0-9 and _`,
      );
    }
    if (!(spec instanceof FieldSpec)) {
      fail(`/fields/${id}`, 'a field is built with Field.string, Field.integer and the rest');
    }
    fields.push({ id, spec });
  }
  return new FormDefinition<FormValues<F['fields']>>({
    id: init.id,
    title: init.title,
    submitLabel: init.submitLabel,
    submission: init.submission,
    fields,
  });
}
