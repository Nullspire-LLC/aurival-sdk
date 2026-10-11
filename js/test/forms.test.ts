/**
 * Bot card forms (AMENDMENT-10 §1, §4, §5, §8): the field constructors and
 * their caps, `defineForm` and its typing, `Button.form` and the per-message
 * caps, the raw `values` scanner, and the whole path from a `form.submitted`
 * frame through `bot.onForm` to an ack that never carries a cooldown.
 *
 * Type-level assertions are plain `tsc` checks (`npm run typecheck` compiles
 * this file); the `@ts-expect-error` lines fail the build if the type ever
 * stops refusing them.
 */

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot.js';
import {
  CAP_FORM_ACK_COOLDOWN,
  CAP_FORM_BUTTON_COOLDOWN,
  CAP_FORM_BUTTON_MISSING_FORM,
  CAP_FORM_ON_NON_FORM_BUTTON,
  CAP_TOO_MANY_BUTTONS,
  CAP_TOO_MANY_FORM_BUTTONS,
  CAP_URL_ON_NON_LINK_BUTTON,
  CAP_LABEL_TOO_LONG,
} from '../src/caps.js';
import { Button, Embed, serialiseButtons } from '../src/embeds.js';
import type { FormContext } from '../src/events.js';
import { Field, FormDefinition, defineForm } from '../src/forms.js';
import { extractRawFormValues } from '../src/rawjson.js';
import { formFrameText, startFormServer, withPairedBot } from './formsHarness.js';
import { sendHello, waitUntil } from './wsserver.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {
  // compile-time only
}

const SIZES = [
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
  { value: 'xl', label: 'XL' },
] as const;

function tripForm() {
  return defineForm({
    id: 'trip_signup',
    title: 'Trip sign-up',
    fields: {
      name: Field.string({ label: 'Name', minLength: 2, maxLength: 40 }),
      seats: Field.integer({ label: 'Seats you can offer', min: 0, max: 6, required: false }),
      email: Field.email({ label: 'Email' }),
      size: Field.select({ label: 'Shirt size', options: SIZES }),
      can_drive: Field.boolean({ label: 'I can drive' }),
    },
  } as const);
}

describe('Field constructors: the wire shape', () => {
  it('each type serialises snake_case, only what was given', () => {
    expect(Field.string({ label: 'Name', placeholder: 'Ana', minLength: 2, maxLength: 40 }).toJSON()).toEqual({
      type: 'string',
      label: 'Name',
      placeholder: 'Ana',
      min_length: 2,
      max_length: 40,
    });
    expect(Field.paragraph({ label: 'Bio', required: false }).toJSON()).toEqual({
      type: 'paragraph',
      label: 'Bio',
      required: false,
    });
    expect(Field.integer({ label: 'Seats', min: 0, max: 6, value: 2 }).toJSON()).toEqual({
      type: 'integer',
      label: 'Seats',
      min: 0,
      max: 6,
      value: 2,
    });
    expect(Field.decimal({ label: 'Amount', min: '0.01', max: 10000, scale: 2 }).toJSON()).toEqual({
      type: 'decimal',
      label: 'Amount',
      min: '0.01',
      max: 10000,
      scale: 2,
    });
    expect(Field.email({ label: 'Email' }).toJSON()).toEqual({ type: 'email', label: 'Email' });
    expect(Field.url({ label: 'Site', maxLength: 300 }).toJSON()).toEqual({
      type: 'url',
      label: 'Site',
      max_length: 300,
    });
    expect(Field.phone({ label: 'Phone' }).toJSON()).toEqual({ type: 'phone', label: 'Phone' });
    expect(Field.select({ label: 'Size', options: SIZES, value: 'm' }).toJSON()).toEqual({
      type: 'select',
      label: 'Size',
      options: [...SIZES],
      value: 'm',
    });
    expect(Field.boolean({ label: 'Drive', value: false }).toJSON()).toEqual({
      type: 'boolean',
      label: 'Drive',
      value: false,
    });
  });

  it('toWire puts the id first', () => {
    const wire = Field.integer({ label: 'Seats' }).toWire('seats');
    expect(Object.keys(wire)[0]).toBe('id');
    expect(wire).toEqual({ id: 'seats', type: 'integer', label: 'Seats' });
  });

  it('undefined options are treated as absent', () => {
    const opts = { label: 'Name', placeholder: undefined } as unknown as { label: string };
    expect(Field.string(opts).toJSON()).toEqual({ type: 'string', label: 'Name' });
  });
});

describe('Field constructors: the allowed-properties table', () => {
  const bad = (make: () => unknown): string => {
    try {
      make();
    } catch (exc) {
      return (exc as Error).message;
    }
    return '';
  };

  it('placeholder is refused on select and boolean, with a pointer', () => {
    expect(
      bad(() => Field.select({ label: 'x', options: SIZES, placeholder: 'p' } as never)),
    ).toBe('/placeholder: a select field does not allow placeholder');
    expect(bad(() => Field.boolean({ label: 'x', placeholder: 'p' } as never))).toBe(
      '/placeholder: a boolean field does not allow placeholder',
    );
  });

  it('required is refused on boolean', () => {
    expect(bad(() => Field.boolean({ label: 'x', required: true } as never))).toBe(
      '/required: a boolean field does not allow required',
    );
    expect(bad(() => Field.boolean({ label: 'x', required: false } as never))).toContain('/required');
  });

  it('min and max are refused on string, minLength on integer, scale on integer, options on string', () => {
    expect(bad(() => Field.string({ label: 'x', min: 1 } as never))).toBe(
      '/min: a string field does not allow min',
    );
    expect(bad(() => Field.email({ label: 'x', max: 1 } as never))).toContain('/max');
    expect(bad(() => Field.integer({ label: 'x', minLength: 1 } as never))).toContain('/minLength');
    expect(bad(() => Field.decimal({ label: 'x', maxLength: 1 } as never))).toContain('/maxLength');
    expect(bad(() => Field.integer({ label: 'x', scale: 2 } as never))).toContain('/scale');
    expect(bad(() => Field.string({ label: 'x', options: SIZES } as never))).toContain('/options');
    expect(bad(() => Field.select({ label: 'x', options: SIZES, minLength: 1 } as never))).toContain(
      '/minLength',
    );
  });

  it('an unknown property (or the snake_case spelling) is refused rather than dropped', () => {
    expect(bad(() => Field.string({ label: 'x', min_length: 2 } as never))).toBe(
      '/min_length: a string field does not allow min_length',
    );
    expect(bad(() => Field.string({ label: 'x', colour: 'red' } as never))).toContain('/colour');
  });

  it('every type accepts what the table says it accepts', () => {
    expect(() =>
      Field.phone({ label: 'x', placeholder: 'p', required: false, minLength: 7, maxLength: 20 }),
    ).not.toThrow();
    expect(() => Field.select({ label: 'x', required: false, options: SIZES })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', placeholder: 'p', scale: 6 })).not.toThrow();
  });

  it('options must be an object', () => {
    expect(bad(() => Field.string(null as never))).toContain('takes an options object');
  });
});

describe('Field constructors: label and placeholder', () => {
  it('label is 1 to 45 code points', () => {
    expect(() => Field.string({ label: '' })).toThrowError('/label: a field needs a label');
    expect(() => Field.string({ label: 'x'.repeat(45) })).not.toThrow();
    expect(() => Field.string({ label: 'x'.repeat(46) })).toThrowError(
      '/label: a field label is at most 45 characters',
    );
    // Code points, not UTF-16 units: 45 astral characters are 90 units.
    expect(() => Field.string({ label: '𝔸'.repeat(45) })).not.toThrow();
    expect(() => Field.string({ label: '𝔸'.repeat(46) })).toThrowError('/label');
    expect(() => Field.string({} as never)).toThrowError('/label');
  });

  it('placeholder is up to 100', () => {
    expect(() => Field.string({ label: 'x', placeholder: 'p'.repeat(100) })).not.toThrow();
    expect(() => Field.string({ label: 'x', placeholder: 'p'.repeat(101) })).toThrowError(
      '/placeholder: a field placeholder is at most 100 characters',
    );
  });

  it('required must be a boolean', () => {
    expect(() => Field.string({ label: 'x', required: 'no' } as never)).toThrowError('/required');
  });
});

describe('Field constructors: text lengths', () => {
  it('string: default 100, cap 200', () => {
    expect(() => Field.string({ label: 'x', maxLength: 200 })).not.toThrow();
    expect(() => Field.string({ label: 'x', maxLength: 201 })).toThrowError(
      "/maxLength: a string field's maxLength is at most 200",
    );
    expect(() => Field.string({ label: 'x', minLength: 100 })).not.toThrow();
    // min above the DEFAULT max is a min > max mistake too.
    expect(() => Field.string({ label: 'x', minLength: 101 })).toThrowError(
      '/minLength: minLength must not exceed maxLength',
    );
    expect(() => Field.string({ label: 'x', minLength: 101, maxLength: 200 })).not.toThrow();
  });

  it('paragraph: default 1000, cap 4000', () => {
    expect(() => Field.paragraph({ label: 'x', maxLength: 4000 })).not.toThrow();
    expect(() => Field.paragraph({ label: 'x', maxLength: 4001 })).toThrowError('/maxLength');
    expect(() => Field.paragraph({ label: 'x', minLength: 1000 })).not.toThrow();
    expect(() => Field.paragraph({ label: 'x', minLength: 1001 })).toThrowError('/minLength');
  });

  it('email 254 and url 2048', () => {
    expect(() => Field.email({ label: 'x', maxLength: 254 })).not.toThrow();
    expect(() => Field.email({ label: 'x', maxLength: 255 })).toThrowError('/maxLength');
    expect(() => Field.url({ label: 'x', maxLength: 2048 })).not.toThrow();
    expect(() => Field.url({ label: 'x', maxLength: 2049 })).toThrowError('/maxLength');
  });

  it('min <= max, whole numbers, max at least 1', () => {
    expect(() => Field.string({ label: 'x', minLength: 5, maxLength: 4 })).toThrowError(
      'minLength must not exceed maxLength',
    );
    expect(() => Field.string({ label: 'x', minLength: 5, maxLength: 5 })).not.toThrow();
    expect(() => Field.string({ label: 'x', minLength: -1 })).toThrowError('/minLength');
    expect(() => Field.string({ label: 'x', minLength: 1.5 })).toThrowError('/minLength');
    expect(() => Field.string({ label: 'x', maxLength: 0 })).toThrowError('/maxLength');
    expect(() => Field.phone({ label: 'x', minLength: 9, maxLength: 7 })).toThrowError('/minLength');
  });

  it('a text prefill is text within the lengths', () => {
    expect(() => Field.string({ label: 'x', value: 'Ana' })).not.toThrow();
    expect(() => Field.string({ label: 'x', value: 5 } as never)).toThrowError(
      '/value: a string field is prefilled with text',
    );
    expect(() => Field.string({ label: 'x', maxLength: 3, value: 'Anna' })).toThrowError('/value');
    expect(() => Field.string({ label: 'x', minLength: 3, value: 'An' })).toThrowError('/value');
    expect(() => Field.string({ label: 'x', value: 'v'.repeat(101) })).toThrowError('/value');
  });
});

describe('Field constructors: integer', () => {
  it('bounds are whole numbers within +/-(2^53 - 1)', () => {
    expect(() =>
      Field.integer({ label: 'x', min: -9007199254740991, max: 9007199254740991 }),
    ).not.toThrow();
    expect(() => Field.integer({ label: 'x', max: 9007199254740992 })).toThrowError('/max');
    expect(() => Field.integer({ label: 'x', min: -9007199254740992 })).toThrowError('/min');
    expect(() => Field.integer({ label: 'x', min: 1.5 })).toThrowError('/min');
    expect(() => Field.integer({ label: 'x', max: Number.NaN })).toThrowError('/max');
    expect(() => Field.integer({ label: 'x', min: '1' } as never)).toThrowError('/min');
  });

  it('min <= max', () => {
    expect(() => Field.integer({ label: 'x', min: 6, max: 0 })).toThrowError(
      '/min: min must not exceed max',
    );
    expect(() => Field.integer({ label: 'x', min: 3, max: 3 })).not.toThrow();
  });

  it('prefill is a whole number inside the bounds', () => {
    expect(() => Field.integer({ label: 'x', min: 0, max: 6, value: 6 })).not.toThrow();
    expect(() => Field.integer({ label: 'x', value: 1.5 })).toThrowError(
      '/value: an integer field is prefilled with a whole number',
    );
    expect(() => Field.integer({ label: 'x', value: '3' } as never)).toThrowError('/value');
    expect(() => Field.integer({ label: 'x', min: 0, value: -1 })).toThrowError('below min');
    expect(() => Field.integer({ label: 'x', max: 5, value: 6 })).toThrowError('above max');
  });
});

describe('Field constructors: decimal', () => {
  it('scale is 0 to 6', () => {
    expect(() => Field.decimal({ label: 'x', scale: 0 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', scale: 6 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', scale: 7 })).toThrowError(
      '/scale: scale is a whole number from 0 to 6',
    );
    expect(() => Field.decimal({ label: 'x', scale: -1 })).toThrowError('/scale');
    expect(() => Field.decimal({ label: 'x', scale: 1.5 })).toThrowError('/scale');
  });

  it('the absolute bound is 1e12, as a number or a decimal string', () => {
    expect(() => Field.decimal({ label: 'x', min: -1e12, max: 1e12 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', max: '1000000000000' })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', max: '1000000000000.01' })).toThrowError('/max');
    expect(() => Field.decimal({ label: 'x', min: -1000000000001 })).toThrowError('/min');
    expect(() => Field.decimal({ label: 'x', min: 'abc' })).toThrowError('/min');
    expect(() => Field.decimal({ label: 'x', min: '1e3' })).toThrowError('/min');
    expect(() => Field.decimal({ label: 'x', max: Number.POSITIVE_INFINITY })).toThrowError('/max');
  });

  it('min <= max across numbers and strings', () => {
    expect(() => Field.decimal({ label: 'x', min: '10', max: 5 })).toThrowError('min must not exceed max');
    expect(() => Field.decimal({ label: 'x', min: '0.01', max: '10000' })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', min: -10, max: -10 })).not.toThrow();
  });

  it('prefill is a number with at most scale places inside the bounds', () => {
    expect(() => Field.decimal({ label: 'x', value: 12.5 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', value: 12.55 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', value: 12.555 })).toThrowError(
      '/value: the prefill has more than 2 decimal places',
    );
    expect(() => Field.decimal({ label: 'x', scale: 3, value: 12.555 })).not.toThrow();
    expect(() => Field.decimal({ label: 'x', scale: 0, value: 1.5 })).toThrowError('/value');
    expect(() => Field.decimal({ label: 'x', value: '12.5' } as never)).toThrowError('/value');
    expect(() => Field.decimal({ label: 'x', value: 1e-7, scale: 6 })).toThrowError('/value');
    expect(() => Field.decimal({ label: 'x', min: 1, value: 0.5 })).toThrowError('below min');
    expect(() => Field.decimal({ label: 'x', max: '1', value: 2 })).toThrowError('above max');
    expect(() => Field.decimal({ label: 'x', value: 1e13 })).toThrowError('/value');
  });
});

describe('Field constructors: select', () => {
  const two = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `Option ${i}` }));

  it('2 to 10 options', () => {
    expect(() => Field.select({ label: 'x', options: two })).not.toThrow();
    expect(() => Field.select({ label: 'x', options: many(10) })).not.toThrow();
    expect(() => Field.select({ label: 'x', options: many(1) })).toThrowError(
      '/options: a select field has 2 to 10 options',
    );
    expect(() => Field.select({ label: 'x', options: many(11) })).toThrowError('/options');
    expect(() => Field.select({ label: 'x' } as never)).toThrowError(
      '/options: a select field needs options',
    );
  });

  it('option value is [a-z0-9_] up to 32, label up to 45, values unique', () => {
    const withOption = (option: { value: string; label: string }) => [...two.slice(0, 1), option];
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'v'.repeat(32), label: 'L' }) }),
    ).not.toThrow();
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'v'.repeat(33), label: 'L' }) }),
    ).toThrowError('/options/1/value');
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'Big', label: 'L' }) }),
    ).toThrowError('/options/1/value');
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'a-b', label: 'L' }) }),
    ).toThrowError('/options/1/value');
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: '', label: 'L' }) }),
    ).toThrowError('/options/1/value');
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'z', label: 'l'.repeat(45) }) }),
    ).not.toThrow();
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'z', label: 'l'.repeat(46) }) }),
    ).toThrowError('/options/1/label');
    expect(() => Field.select({ label: 'x', options: withOption({ value: 'z', label: '' }) })).toThrowError(
      '/options/1/label',
    );
    expect(() =>
      Field.select({ label: 'x', options: withOption({ value: 'a', label: 'dup' }) }),
    ).toThrowError('/options/1/value: an option value must be unique');
    expect(() => Field.select({ label: 'x', options: ['a', 'b'] } as never)).toThrowError('/options/0');
  });

  it('prefill is one of the option values', () => {
    expect(() => Field.select({ label: 'x', options: two, value: 'b' })).not.toThrow();
    expect(() => Field.select({ label: 'x', options: two, value: 'c' } as never)).toThrowError(
      '/value: the prefill must be one of the option values',
    );
  });
});

describe('Field constructors: boolean', () => {
  it('prefill is true or false', () => {
    expect(() => Field.boolean({ label: 'x', value: true })).not.toThrow();
    expect(() => Field.boolean({ label: 'x', value: 'yes' } as never)).toThrowError('/value');
  });
});

describe('defineForm: form-level caps', () => {
  const fields = { a: Field.string({ label: 'A' }) };

  it('title is 1 to 45', () => {
    expect(() => defineForm({ id: 'f', title: '', fields })).toThrowError('/title');
    expect(() => defineForm({ id: 'f', title: 't'.repeat(45), fields })).not.toThrow();
    expect(() => defineForm({ id: 'f', title: 't'.repeat(46), fields })).toThrowError(
      '/title: a form title is at most 45 characters',
    );
  });

  it('submitLabel is 1 to 24', () => {
    expect(() => defineForm({ id: 'f', title: 't', submitLabel: 's'.repeat(24), fields })).not.toThrow();
    expect(() => defineForm({ id: 'f', title: 't', submitLabel: 's'.repeat(25), fields })).toThrowError(
      '/submit_label',
    );
    expect(() => defineForm({ id: 'f', title: 't', submitLabel: '', fields })).toThrowError('/submit_label');
  });

  it('submission is per_user or once', () => {
    expect(() => defineForm({ id: 'f', title: 't', submission: 'once', fields })).not.toThrow();
    expect(() => defineForm({ id: 'f', title: 't', submission: 'per_user', fields })).not.toThrow();
    expect(() =>
      defineForm({ id: 'f', title: 't', submission: 'twice' as never, fields }),
    ).toThrowError('/submission: submission is one of per_user, once');
  });

  it('1 to 5 fields', () => {
    expect(() => defineForm({ id: 'f', title: 't', fields: {} })).toThrowError(
      '/fields: a form has 1 to 5 fields',
    );
    const five = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map((id) => [id, Field.string({ label: id })]),
    );
    expect(() => defineForm({ id: 'f', title: 't', fields: five })).not.toThrow();
    const six = { ...five, f: Field.string({ label: 'f' }) };
    expect(() => defineForm({ id: 'f', title: 't', fields: six })).toThrowError('/fields');
    expect(() => defineForm({ id: 'f', title: 't', fields: null as never })).toThrowError('/fields');
    expect(() => defineForm({ id: 'f', title: 't', fields: [] as never })).toThrowError('/fields');
  });

  it('field ids are [a-z0-9_], 1 to 32', () => {
    const field = Field.string({ label: 'x' });
    expect(() => defineForm({ id: 'f', title: 't', fields: { ['a'.repeat(32)]: field } })).not.toThrow();
    expect(() => defineForm({ id: 'f', title: 't', fields: { ['a'.repeat(33)]: field } })).toThrowError(
      '/fields/' + 'a'.repeat(33),
    );
    expect(() => defineForm({ id: 'f', title: 't', fields: { Name: field } })).toThrowError('/fields/Name');
    expect(() => defineForm({ id: 'f', title: 't', fields: { 'a-b': field } })).toThrowError('/fields/a-b');
    expect(() => defineForm({ id: 'f', title: 't', fields: { '': field } })).toThrowError('/fields/');
  });

  it('a field must come from a Field constructor', () => {
    expect(() =>
      defineForm({ id: 'f', title: 't', fields: { a: { type: 'string', label: 'x' } as never } }),
    ).toThrowError('/fields/a: a field is built with Field.string');
  });

  it('the form id is the button id: 1 to 32', () => {
    expect(() => defineForm({ id: '', title: 't', fields })).toThrowError('/id');
    expect(() => defineForm({ id: 'i'.repeat(32), title: 't', fields })).not.toThrow();
    expect(() => defineForm({ id: 'i'.repeat(33), title: 't', fields })).toThrowError(
      '/id: a button id is at most 32 characters',
    );
  });
});

describe('defineForm: the wire shape', () => {
  it('toJSON is the section 1 form object: snake_case, fields as an array in order', () => {
    const form = defineForm({
      id: 'trip_signup',
      title: 'Trip sign-up',
      submitLabel: 'Sign up',
      submission: 'per_user',
      fields: {
        name: Field.string({ label: 'Name', required: true, minLength: 2, maxLength: 40 }),
        seats: Field.integer({ label: 'Seats you can offer', min: 0, max: 6 }),
        email: Field.email({ label: 'Email' }),
        size: Field.select({
          label: 'Shirt size',
          options: [
            { value: 's', label: 'S' },
            { value: 'm', label: 'M' },
            { value: 'l', label: 'L' },
            { value: 'xl', label: 'XL' },
          ],
        }),
        can_drive: Field.boolean({ label: 'I can drive', value: false }),
      },
    });
    expect(form.toJSON()).toEqual({
      title: 'Trip sign-up',
      submit_label: 'Sign up',
      submission: 'per_user',
      fields: [
        { id: 'name', type: 'string', label: 'Name', required: true, min_length: 2, max_length: 40 },
        { id: 'seats', type: 'integer', label: 'Seats you can offer', min: 0, max: 6 },
        { id: 'email', type: 'email', label: 'Email' },
        {
          id: 'size',
          type: 'select',
          label: 'Shirt size',
          options: [
            { value: 's', label: 'S' },
            { value: 'm', label: 'M' },
            { value: 'l', label: 'L' },
            { value: 'xl', label: 'XL' },
          ],
        },
        { id: 'can_drive', type: 'boolean', label: 'I can drive', value: false },
      ],
    });
    expect(form.toJSON()['fields']).toBeInstanceOf(Array);
    expect(JSON.parse(JSON.stringify(form))).toEqual(form.toJSON());
    expect(form.id).toBe('trip_signup');
  });

  it('absent submitLabel and submission stay off the wire', () => {
    const json = defineForm({ id: 'f', title: 't', fields: { a: Field.string({ label: 'A' }) } }).toJSON();
    expect(Object.keys(json)).toEqual(['title', 'fields']);
  });
});

describe('defineForm: the answer types', () => {
  const form = tripForm();
  type V = typeof form extends FormDefinition<infer X> ? X : never;

  it('infers a type per field, nullable only for required: false', () => {
    assertType<Equal<V['name'], string>>();
    assertType<Equal<V['seats'], number | null>>();
    assertType<Equal<V['email'], string>>();
    assertType<Equal<V['size'], 's' | 'm' | 'l' | 'xl'>>();
    assertType<Equal<V['can_drive'], boolean>>();
    expect(form.fields.map((f) => f.id)).toEqual(['name', 'seats', 'email', 'size', 'can_drive']);
  });

  it('covers every constructor', () => {
    const all = defineForm({
      id: 'all',
      title: 'All',
      fields: {
        s: Field.string({ label: 's' }),
        s_opt: Field.string({ label: 's', required: false }),
        p: Field.paragraph({ label: 'p' }),
        i: Field.integer({ label: 'i' }),
        d: Field.decimal({ label: 'd' }),
      },
    } as const);
    type A = typeof all extends FormDefinition<infer X> ? X : never;
    assertType<Equal<A['s'], string>>();
    assertType<Equal<A['s_opt'], string | null>>();
    assertType<Equal<A['p'], string>>();
    assertType<Equal<A['i'], number>>();
    assertType<Equal<A['d'], number>>();
    const rest = defineForm({
      id: 'rest',
      title: 'Rest',
      fields: {
        u: Field.url({ label: 'u', required: false }),
        ph: Field.phone({ label: 'ph' }),
        sel: Field.select({ label: 'sel', required: false, options: SIZES }),
        flag: Field.boolean({ label: 'flag' }),
      },
    } as const);
    type R = typeof rest extends FormDefinition<infer X> ? X : never;
    assertType<Equal<R['u'], string | null>>();
    assertType<Equal<R['ph'], string>>();
    assertType<Equal<R['sel'], 's' | 'm' | 'l' | 'xl' | null>>();
    assertType<Equal<R['flag'], boolean>>();
    // A non-literal required could be either, so it is nullable.
    const maybe: boolean = Math.random() > 2;
    const loose = defineForm({
      id: 'loose',
      title: 'Loose',
      fields: { x: Field.string({ label: 'x', required: maybe }) },
    });
    type L = typeof loose extends FormDefinition<infer X> ? X : never;
    assertType<Equal<L['x'], string | null>>();
  });

  it('refuses at the type level what it can (extra keys are caught at runtime)', () => {
    const needsOptions = () => {
      // @ts-expect-error a select needs options
      Field.select({ label: 'x' });
    };
    expect(needsOptions).toThrowError('/options');
  });
});

describe('Button.form', () => {
  it('builds a form button: style form, id = form id, the form object on the wire', () => {
    const form = tripForm();
    const button = Button.form({ label: 'Sign up', emoji: '🥾', form });
    expect(button.style).toBe('form');
    expect(button.id).toBe('trip_signup');
    expect(button.toJSON()).toEqual({
      id: 'trip_signup',
      label: 'Sign up',
      style: 'form',
      emoji: '🥾',
      form: form.toJSON(),
    });
  });

  it('keeps the button caps: label 24, emoji single', () => {
    const form = tripForm();
    expect(() => Button.form({ label: 'x'.repeat(25), form })).toThrowError(CAP_LABEL_TOO_LONG);
    expect(() => Button.form({ label: 'Go', emoji: 'ab', form })).toThrowError();
  });

  it('refuses a cooldown and a url', () => {
    const form = tripForm();
    expect(() =>
      Button.form({ label: 'Go', form, cooldown: { rate: 1, per: 5 } } as never),
    ).toThrowError(CAP_FORM_BUTTON_COOLDOWN);
    expect(() => Button.form({ label: 'Go', form, url: 'https://example.com' } as never)).toThrowError(
      CAP_URL_ON_NON_LINK_BUTTON,
    );
    expect(() => new Button({ label: 'Go', style: 'form', form: tripForm(), cooldown: { rate: 1, per: 5 } })).toThrowError(
      CAP_FORM_BUTTON_COOLDOWN,
    );
  });

  it('needs a real form, and a form belongs to a form button only', () => {
    expect(() => Button.form({ label: 'Go', form: {} as never })).toThrowError(
      CAP_FORM_BUTTON_MISSING_FORM,
    );
    expect(() => new Button({ label: 'Go', style: 'form' })).toThrowError(CAP_FORM_BUTTON_MISSING_FORM);
    expect(() => new Button({ label: 'Go', form: tripForm() })).toThrowError(CAP_FORM_ON_NON_FORM_BUTTON);
  });

  it('survives a wire round trip (Button.fromJSON) and a plain-object literal', () => {
    const form = tripForm();
    const wire = Button.form({ label: 'Sign up', form }).toJSON();
    expect(Button.fromJSON(wire).toJSON()).toEqual(wire);
    expect(serialiseButtons([wire])).toEqual([wire]);
  });
});

describe('form buttons on a message', () => {
  const make = (id: string) =>
    Button.form({
      label: id,
      form: defineForm({ id, title: id, fields: { a: Field.string({ label: 'A' }) } }),
    });

  it('at most 2 form buttons', () => {
    expect(serialiseButtons([make('one'), make('two')])).toHaveLength(2);
    expect(() => serialiseButtons([make('one'), make('two'), make('three')])).toThrowError(
      CAP_TOO_MANY_FORM_BUTTONS,
    );
    expect(CAP_TOO_MANY_FORM_BUTTONS).toBe('a message carries at most 2 form buttons');
  });

  it('the plain button count (5) still applies, and form buttons count toward it', () => {
    const plain = (n: number) =>
      Array.from({ length: n }, (_, i) => new Button({ label: `b${i}`, id: `b${i}` }));
    expect(serialiseButtons([make('one'), make('two'), ...plain(3)])).toHaveLength(5);
    expect(() => serialiseButtons([make('one'), make('two'), ...plain(4)])).toThrowError(
      CAP_TOO_MANY_BUTTONS,
    );
  });

  it('plain-object form buttons are counted too, not a bypass', () => {
    const wire = (id: string) => make(id).toJSON();
    expect(() => serialiseButtons([wire('a'), wire('b'), wire('c')])).toThrowError(
      CAP_TOO_MANY_FORM_BUTTONS,
    );
  });
});

describe('extractRawFormValues', () => {
  it('slices each member exactly, whatever surrounds it', () => {
    const text = formFrameText({
      eventId: 'e',
      valuesText: ' { "amount" : 12.50 ,"name":"A\\"b" , "n": null,"ok":true,"deep":{"x":[1,2,{"y":"}"}]} } ',
    });
    expect(extractRawFormValues(text)).toEqual({
      amount: '12.50',
      name: '"A\\"b"',
      n: 'null',
      ok: 'true',
      deep: '{"x":[1,2,{"y":"}"}]}',
    });
  });

  it('is structural: decoys that spell "values" earlier or deeper are ignored', () => {
    const text = formFrameText({
      eventId: 'e',
      valuesText: '{"a":1.10}',
      decoyMembers: '"note":"\\"values\\":{\\"zz\\":1}","other":{"values":{"zz":2}},"values_x":{"a":9}',
    });
    expect(extractRawFormValues(text)).toEqual({ a: '1.10' });
  });

  it('an empty values object, and a key with escapes', () => {
    expect(extractRawFormValues(formFrameText({ eventId: 'e', valuesText: '{}' }))).toEqual({});
    expect(
      extractRawFormValues(formFrameText({ eventId: 'e', valuesText: '{"a\\u0062":2.0}' })),
    ).toEqual({ ab: '2.0' });
  });

  it('the last duplicate wins, as JSON.parse keeps it', () => {
    expect(
      extractRawFormValues(formFrameText({ eventId: 'e', valuesText: '{"a":1.0,"a":2.0}' })),
    ).toEqual({ a: '2.0' });
  });

  it('keeps a __proto__ field as an own entry', () => {
    const got = extractRawFormValues(formFrameText({ eventId: 'e', valuesText: '{"__proto__":1.5}' }));
    expect(Object.keys(got ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
  });

  it('answers null for a frame without d.data.values', () => {
    expect(extractRawFormValues('{"op":"event","d":{"data":{}}}')).toBeNull();
    expect(extractRawFormValues('{"op":"event","d":[]}')).toBeNull();
    expect(extractRawFormValues('[]')).toBeNull();
    expect(extractRawFormValues('{"d":{"data":{"values":[1]}}}')).toBeNull();
    expect(extractRawFormValues('')).toBeNull();
    expect(extractRawFormValues('{"d":{"data":{"values":{"a":')).toBeNull();
  });
});

describe('bot.onForm and the form.submitted context', () => {
  it('dispatches only the matching form, typed, with rawValues, and acks without a cooldown', async () => {
    const form = tripForm();
    const other = defineForm({ id: 'other', title: 'Other', fields: { q: Field.string({ label: 'Q' }) } });
    const seen: Array<{
      values: unknown;
      raw: Record<string, string>;
      user: string;
      chat: string;
      message: string;
      button: string;
      interaction: string;
      submittedAt: string;
    }> = [];
    const otherSeen: string[] = [];
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      conn.sendRaw(
        formFrameText({
          eventId: 'evt_other',
          sequence: 1,
          button: 'other',
          valuesText: '{"q":"hi"}',
        }),
      );
      conn.sendRaw(
        formFrameText({
          eventId: 'evt_trip',
          sequence: 2,
          valuesText:
            '{"name":"Ana Ribeiro","seats":2,"email":"ana@example.com","size":"m","can_drive":true}',
        }),
      );
      await waitUntil(() => gateway.state.acksFor(0).includes('evt_trip'), 4000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        bot.onForm(form, async (ctx) => {
          const seats: number | null = ctx.values.seats;
          const drives: boolean = ctx.values.can_drive;
          const size: 's' | 'm' | 'l' | 'xl' = ctx.values.size;
          const name: string = ctx.values.name;
          expect([seats, drives, size, name]).toEqual([2, true, 'm', 'Ana Ribeiro']);
          seen.push({
            values: ctx.values,
            raw: { ...ctx.rawValues },
            user: `${ctx.user.id}/${ctx.user.handle}/${ctx.user.name}`,
            chat: ctx.chat.id,
            message: ctx.message.id,
            button: ctx.button,
            interaction: ctx.interaction,
            submittedAt: ctx.submittedAt,
          });
          await ctx.ack({
            embeds: [new Embed({ title: 'Ridge trail, Oct 18', description: '11 of 14 spots taken.' })],
          });
        });
        bot.onForm(other, (ctx) => {
          otherSeen.push(ctx.values.q);
        });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          expect(await waitUntil(() => gateway.ackCalls.length === 1, 4000)).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }
    expect(otherSeen).toEqual(['hi']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      values: { name: 'Ana Ribeiro', seats: 2, email: 'ana@example.com', size: 'm', can_drive: true },
      raw: {
        name: '"Ana Ribeiro"',
        seats: '2',
        email: '"ana@example.com"',
        size: '"m"',
        can_drive: 'true',
      },
      user: 'u_1/ana/ana',
      chat: 'ch_1',
      message: 'msg_1',
      button: 'trip_signup',
      interaction: 'evt_trip',
      submittedAt: '2026-10-08T14:14:03Z',
    });
    expect(gateway.ackCalls).toHaveLength(1);
    expect(gateway.ackCalls[0]?.interaction).toBe('evt_trip');
    const body = gateway.ackCalls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['embeds']);
    expect(body).not.toHaveProperty('cooldown');
  });

  it('plain bot.on("form.submitted") gets an untyped values record; no automatic ack, never a cooldown ack', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      // Two submissions, same user, same button, back to back: a button
      // cooldown (default 1 per 2s) would refuse the second. A form is not a
      // press, so both reach the handler and nothing is acked by the SDK.
      for (const n of [1, 2]) {
        conn.sendRaw(
          formFrameText({
            eventId: `evt_${n}`,
            sequence: n,
            valuesText: `{"amount":${n}.50,"note":null}`,
          }),
        );
      }
      await waitUntil(() => gateway.state.acksFor(0).length === 2, 4000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        bot.on('form.submitted', (ctx) => {
          const amount = ctx.values['amount'];
          seen.push({ amount, raw: ctx.rawValues['amount'], note: ctx.values['note'] });
        });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          expect(await waitUntil(() => seen.length === 2, 4000)).toBe(true);
          expect(await waitUntil(() => gateway.state.acksFor(0).length === 2, 4000)).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }
    expect(seen).toEqual([
      { amount: 1.5, raw: '1.50', note: null },
      { amount: 2.5, raw: '2.50', note: null },
    ]);
    expect(gateway.ackCalls).toEqual([]);
  });

  it('a plain ack and a text ack send the right bodies; a cooldown ack is refused before any request', async () => {
    const form = tripForm();
    const outcomes: string[] = [];
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      for (const n of [1, 2, 3]) {
        conn.sendRaw(
          formFrameText({
            eventId: `evt_${n}`,
            sequence: n,
            valuesText:
              '{"name":"Ana","seats":null,"email":"a@b.co","size":"s","can_drive":false}',
          }),
        );
      }
      await waitUntil(() => gateway.state.acksFor(0).length === 3, 4000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        let n = 0;
        bot.onForm(form, async (ctx) => {
          n += 1;
          if (n === 1) {
            await ctx.ack();
            outcomes.push('plain');
          } else if (n === 2) {
            await ctx.ack({ text: 'Saved' });
            outcomes.push('text');
          } else {
            try {
              // @ts-expect-error cooldown is not in the form ack type
              await ctx.ack({ cooldown: { retry_after_ms: 1000 } });
              outcomes.push('sent');
            } catch (exc) {
              outcomes.push((exc as Error).message);
            }
            try {
              // @ts-expect-error an explicit undefined is refused too
              await ctx.ack({ cooldown: undefined });
              outcomes.push('sent');
            } catch (exc) {
              outcomes.push((exc as Error).message);
            }
          }
        });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          expect(await waitUntil(() => outcomes.length === 4, 4000)).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }
    // Handlers run concurrently, so compare without regard to order.
    expect([...outcomes].sort()).toEqual(
      ['plain', 'text', CAP_FORM_ACK_COOLDOWN, CAP_FORM_ACK_COOLDOWN].sort(),
    );
    expect(gateway.ackCalls).toHaveLength(2);
    const byInteraction = new Map(gateway.ackCalls.map((c) => [c.interaction, c.body]));
    expect(byInteraction.get('evt_1')).toBeUndefined();
    expect(byInteraction.get('evt_2')).toEqual({ text: 'Saved' });
    // A plain ack has no body at all (asserted above); only a defined body can
    // carry a `cooldown` key.
    for (const call of gateway.ackCalls) {
      if (call.body !== undefined) expect(call.body).not.toHaveProperty('cooldown');
    }
  });

  it('a card patch can swap the buttons, including a new form button', async () => {
    const form = tripForm();
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      conn.sendRaw(
        formFrameText({
          eventId: 'evt_1',
          valuesText: '{"name":"Ana","seats":null,"email":"a@b.co","size":"s","can_drive":false}',
        }),
      );
      await waitUntil(() => gateway.state.acksFor(0).includes('evt_1'), 4000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        bot.onForm(form, async (ctx) => {
          await ctx.ack({ buttons: [Button.form({ label: 'Sign up', form })], forUser: ctx.user });
        });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          expect(await waitUntil(() => gateway.ackCalls.length === 1, 4000)).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }
    const body = gateway.ackCalls[0]?.body as Record<string, unknown>;
    expect(body['for_user']).toBe('u_1');
    expect((body['buttons'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'trip_signup',
      style: 'form',
    });
  });

  it('onForm refuses a value that is not a defineForm result', () => {
    const bot = new Bot({ quiet: true });
    expect(() => bot.onForm({} as never, () => undefined)).toThrowError(/defineForm/);
    expect(FormDefinition).toBeDefined();
  });

  it('a submission nobody registered for is acked at the socket and goes nowhere', async () => {
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      conn.sendRaw(formFrameText({ eventId: 'evt_x', valuesText: '{"a":"b"}' }));
      await waitUntil(() => gateway.state.acksFor(0).includes('evt_x'), 4000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          expect(await waitUntil(() => gateway.state.acksFor(0).includes('evt_x'), 4000)).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }
    expect(gateway.ackCalls).toEqual([]);
  });
});

// Keep the context type referenced so a rename shows up here.
export type { FormContext };
