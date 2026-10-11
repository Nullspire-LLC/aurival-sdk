/**
 * Exact JSON text of the members of one object inside a frame.
 *
 * `JSON.parse` turns `12.50` into the double `12.5` and `999999999999.999999`
 * into `1000000000000`. A `form.submitted` event carries the server's exact
 * text for every answer (AMENDMENT-10 §4), and a bot that cares about a
 * decimal needs that text, not the double. `JSON.parse`'s source-text access
 * is not on every engine the SDK runs on (Node 22.12 does not have it), so
 * this walks the raw frame instead: it skips values without decoding them
 * and slices out the text of each member of `d.data.values`.
 *
 * The frame has already survived `JSON.parse` by the time this runs, so the
 * input is valid JSON; the scanner still answers `null` on anything that
 * surprises it rather than guessing, and the caller degrades to
 * re-serialising the parsed value.
 */

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && WS.has(text.charCodeAt(i))) i += 1;
  return i;
}

/** `text[from]` is the opening quote; returns the index after the closing quote, or -1. */
function skipString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x5c) i += 2;
    else if (c === 0x22) return i + 1;
    else i += 1;
  }
  return -1;
}

/** Returns the index just past the JSON value starting at `from`, or -1. Iterative, so depth never overflows the stack. */
function skipValue(text: string, from: number): number {
  const first = text.charCodeAt(from);
  if (first === 0x22) return skipString(text, from);
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i = skipString(text, i);
        if (i === -1) return -1;
        continue;
      }
      if (c === 0x7b || c === 0x5b) depth += 1;
      else if (c === 0x7d || c === 0x5d) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return -1;
  }
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x2c || c === 0x7d || c === 0x5d || WS.has(c)) break;
    i += 1;
  }
  return i === from ? -1 : i;
}

interface Member {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** The members of the object whose `{` is at `from`, in order, duplicates included. */
function membersOf(text: string, from: number): Member[] | null {
  if (text.charCodeAt(from) !== 0x7b) return null;
  const out: Member[] = [];
  let i = skipWs(text, from + 1);
  if (text.charCodeAt(i) === 0x7d) return out;
  for (;;) {
    if (text.charCodeAt(i) !== 0x22) return null;
    const keyEnd = skipString(text, i);
    if (keyEnd === -1) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(i, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== 'string') return null;
    i = skipWs(text, keyEnd);
    if (text.charCodeAt(i) !== 0x3a) return null;
    i = skipWs(text, i + 1);
    const end = skipValue(text, i);
    if (end === -1) return null;
    out.push({ key, start: i, end });
    i = skipWs(text, end);
    const c = text.charCodeAt(i);
    if (c === 0x2c) {
      i = skipWs(text, i + 1);
      continue;
    }
    return c === 0x7d ? out : null;
  }
}

/** The last member named `key` (what `JSON.parse` keeps for a duplicate), or null. */
function lastMember(members: readonly Member[], key: string): Member | null {
  for (let n = members.length - 1; n >= 0; n -= 1) {
    const member = members[n];
    if (member !== undefined && member.key === key) return member;
  }
  return null;
}

/**
 * The exact JSON text of each answer of a `form.submitted` frame, keyed by
 * field id, read from `d.data.values` of the raw frame text. `null` when the
 * frame does not have that shape.
 */
export function extractRawFormValues(frameText: string): Record<string, string> | null {
  let at = skipWs(frameText, 0);
  for (const key of ['d', 'data', 'values']) {
    const members = membersOf(frameText, at);
    if (members === null) return null;
    const member = lastMember(members, key);
    if (member === null) return null;
    at = member.start;
  }
  const answers = membersOf(frameText, at);
  if (answers === null) return null;
  const out: Record<string, string> = {};
  for (const answer of answers) {
    // defineProperty, so a field called `__proto__` stays an own entry.
    Object.defineProperty(out, answer.key, {
      value: frameText.slice(answer.start, answer.end),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
