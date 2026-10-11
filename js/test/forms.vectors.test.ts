/**
 * AMENDMENT-10 §3a. The parse is the server's; the vectors are shared with
 * it and with the Python SDK (`sdk/testdata/form_vectors.json`, byte-equal to
 * backend-go's copy). What this SDK owes the contract is:
 *
 *   (a) every field spec the server accepts, the constructors accept, and
 *       they serialise it back to the same snake_case wire spec;
 *   (b) every value the server sends, decoded through the real socket and
 *       event path, reads back as `JSON.parse` of the text, with the exact
 *       text kept in `rawValues` (`12.50` stays `12.50`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot.js';
import { Event, FormContext, contextFor } from '../src/events.js';
import { Field, defineForm } from '../src/forms.js';
import type { FieldSpec } from '../src/forms.js';
import { HttpClient } from '../src/http.js';
import type { Auth } from '../src/auth.js';
import { formFrameText, startFormServer, withPairedBot } from './formsHarness.js';
import { sendHello, waitUntil } from './wsserver.js';

const VECTORS_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'testdata',
  'form_vectors.json',
);

interface FieldRow {
  id: string;
  spec: Record<string, unknown>;
  raw?: unknown;
  expect: { json?: string; code?: string };
}

interface FormRow {
  id: string;
  fields: Array<Record<string, unknown>>;
  values: Record<string, unknown>;
  expect: { errors: Record<string, string>; values: Record<string, string> };
}

const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as {
  fields: FieldRow[];
  forms: FormRow[];
};

/** Hard-coded so a silently truncated file fails here and in the Python suite. */
const EXPECTED_FIELD_ROWS = 63;
const EXPECTED_FORM_ROWS = 2;

const CAMEL: Record<string, string> = { min_length: 'minLength', max_length: 'maxLength' };

/** A vector spec is wire-shaped; the constructors take camelCase options plus a label. */
function build(spec: Record<string, unknown>, id: string): FieldSpec<unknown> {
  const { type, ...rest } = spec;
  const opts: Record<string, unknown> = { label: id };
  for (const [key, value] of Object.entries(rest)) opts[CAMEL[key] ?? key] = value;
  const make = (Field as unknown as Record<string, (o: unknown) => FieldSpec<unknown>>)[
    String(type)
  ];
  if (make === undefined) throw new Error(`no Field.${String(type)}`);
  return make(opts);
}

function userFrom(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('form vectors: the file', () => {
  it('is whole', () => {
    expect(vectors.fields).toHaveLength(EXPECTED_FIELD_ROWS);
    expect(vectors.forms).toHaveLength(EXPECTED_FORM_ROWS);
    const ids = [...vectors.fields, ...vectors.forms].map((row) => row.id);
    expect(new Set(ids).size).toBe(EXPECTED_FIELD_ROWS + EXPECTED_FORM_ROWS);
  });
});

describe('form vectors: (a) every spec is accepted and round-trips to the wire', () => {
  for (const row of vectors.fields) {
    it(`${row.id}: ${String(row.spec['type'])}`, () => {
      const field = build(row.spec, row.id);
      expect(field.toJSON()).toEqual({ ...row.spec, label: row.id });
      expect(field.toWire('f')).toEqual({ id: 'f', ...row.spec, label: row.id });
    });
  }
});

describe('form vectors: (b) the value text decodes end to end through the socket', () => {
  const answered = vectors.fields.filter((row) => row.expect.json !== undefined);
  const errored = vectors.fields.filter((row) => row.expect.code !== undefined);

  it('the rows split into answered and refused with nothing left over', () => {
    expect(answered.length + errored.length).toBe(EXPECTED_FIELD_ROWS);
    expect(answered.length).toBeGreaterThan(0);
    expect(errored.length).toBeGreaterThan(0);
  });

  it('every answered row: values[id] is JSON.parse(expect.json) and rawValues[id] is expect.json byte for byte', async () => {
    type Seen = { values: Record<string, unknown>; raw: Record<string, string> };
    const seen = new Map<string, Seen>();
    const gateway = await startFormServer(async (conn) => {
      sendHello(conn);
      answered.forEach((row, index) => {
        conn.sendRaw(
          formFrameText({
            eventId: `evt_${row.id}`,
            sequence: index + 1,
            valuesText: `{${JSON.stringify(row.id)}:${row.expect.json as string}}`,
            // A decoy that spells out another `values` object: the scan has to be
            // structural, not the first `"values":` in the text.
            decoyMembers: '"note":"\\"values\\":{\\"zz\\":1}","other":{"values":{"zz":2}}',
          }),
        );
      });
      await waitUntil(() => answered.every((row) => gateway.state.acksFor(0).includes(`evt_${row.id}`)), 8000);
    });
    try {
      await withPairedBot(gateway, async (keyPath) => {
        const bot = new Bot({ host: gateway.host, keyPath, quiet: true });
        bot.on('form.submitted', (ctx) => {
          seen.set(ctx.event.id, {
            values: { ...ctx.values },
            raw: { ...ctx.rawValues },
          });
        });
        const controller = new AbortController();
        const task = bot.start(controller.signal);
        try {
          const done = await waitUntil(() => seen.size === answered.length, 8000);
          expect(done, `saw ${seen.size} of ${answered.length} submissions`).toBe(true);
        } finally {
          controller.abort();
          await task;
        }
      });
    } finally {
      await gateway.close();
    }

    for (const row of answered) {
      const got = seen.get(`evt_${row.id}`);
      expect(got, row.id).toBeDefined();
      const text = row.expect.json as string;
      // The absent boolean row (bool-3) arrives as `false`, never `null`.
      expect(got?.values[row.id], row.id).toEqual(JSON.parse(text));
      expect(got?.raw[row.id], row.id).toBe(text);
      expect(Object.keys(got?.raw ?? {})).toEqual([row.id]);
    }
  }, 30_000);

  it('dec-1: values gives the double 12.5 while rawValues keeps "12.50"', () => {
    const frame = userFrom(
      formFrameText({ eventId: 'evt_d', valuesText: '{"amount":12.50,"fee":0.00}' }),
    );
    const event = Event.fromFrame(
      frame['d'] as Record<string, unknown>,
      formFrameText({ eventId: 'evt_d', valuesText: '{"amount":12.50,"fee":0.00}' }),
    );
    const ctx = contextFor(event, new HttpClient('http://127.0.0.1:1', null as unknown as Auth));
    expect(ctx).toBeInstanceOf(FormContext);
    const form = ctx as FormContext;
    expect(form.values['amount']).toBe(12.5);
    expect(form.rawValues['amount']).toBe('12.50');
    expect(form.rawValues['fee']).toBe('0.00');
  });

  it('the JS decimal caveat from §3a: 999999999999.999999 parses to 1000000000000, the text survives', () => {
    const text = formFrameText({ eventId: 'evt_big', valuesText: '{"amount":999999999999.999999}' });
    const frame = userFrom(text);
    const event = Event.fromFrame(frame['d'] as Record<string, unknown>, text);
    const form = contextFor(event, new HttpClient('http://127.0.0.1:1', null as unknown as Auth)) as FormContext;
    expect(form.values['amount']).toBe(1000000000000);
    expect(form.rawValues['amount']).toBe('999999999999.999999');
  });

  it('without the frame text the context degrades to re-serialising the parsed value', () => {
    const text = formFrameText({ eventId: 'evt_nt', valuesText: '{"amount":12.50}' });
    const frame = userFrom(text);
    const event = Event.fromFrame(frame['d'] as Record<string, unknown>);
    const form = contextFor(event, new HttpClient('http://127.0.0.1:1', null as unknown as Auth)) as FormContext;
    expect(form.rawValues['amount']).toBe('12.5');
  });
});

describe('form vectors: (c) refused rows only assert the spec side', () => {
  it('every refused row still has an accepted spec (covered by (a))', () => {
    for (const row of vectors.fields) {
      if (row.expect.code === undefined) continue;
      expect(() => build(row.spec, row.id), row.id).not.toThrow();
    }
  });
});

describe('form vectors: whole-form rows', () => {
  for (const row of vectors.forms) {
    it(`${row.id}: the form builds and the expected values texts land in rawValues`, () => {
      const fields: Record<string, FieldSpec<unknown>> = {};
      for (const { id, ...spec } of row.fields as Array<{ id: string } & Record<string, unknown>>) {
        fields[id] = build(spec, id);
      }
      const form = defineForm({ id: 'vector_form', title: 'Vector', fields });
      expect(form.toJSON()['fields']).toEqual(
        row.fields.map((f) => ({ ...f, label: f['id'] })),
      );

      const members = Object.entries(row.expect.values).map(
        ([key, text]) => `${JSON.stringify(key)}:${text}`,
      );
      const text = formFrameText({
        eventId: 'evt_form',
        button: form.id,
        valuesText: `{${members.join(',')}}`,
      });
      const event = Event.fromFrame(userFrom(text)['d'] as Record<string, unknown>, text);
      const ctx = contextFor(
        event,
        new HttpClient('http://127.0.0.1:1', null as unknown as Auth),
      ) as FormContext;
      expect({ ...ctx.rawValues }).toEqual(row.expect.values);
      for (const [key, valueText] of Object.entries(row.expect.values)) {
        expect(ctx.values[key]).toEqual(JSON.parse(valueText));
      }
      // The bot receives exactly the answers the server kept.
      expect(Object.keys(ctx.values).sort()).toEqual(Object.keys(row.expect.values).sort());
    });
  }
});
