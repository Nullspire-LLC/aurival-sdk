import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AckUnknownEvent,
  APIError,
  AssertionExpired,
  AssertionReplay,
  AccessTokenExpired,
  AccessTokenInvalid,
  AuthenticationError,
  AurivalAPIError,
  AurivalError,
  BadAssertion,
  BadProof,
  BadPublicKey,
  BotLinkNotAllowed,
  BotPlaygroundOnly,
  BotSuspended,
  ButtonAlreadyUsed,
  ButtonIDTooLong,
  ButtonLabelTooLong,
  ButtonMissingField,
  ButtonsWithoutMessage,
  CODE_CLASSES,
  DOC_URL_PREFIX,
  DuplicateButtonID,
  EmbedDescriptionTooLong,
  EmbedEmpty,
  EmbedTitleTooLong,
  EmbedURLNotHTTPS,
  EmptyText,
  FrameInvalid,
  FrameTooLarge,
  IdempotencyKeyInvalid,
  IdempotencyKeyReused,
  IdleTimeout,
  InternalError,
  InvalidButtonStyle,
  InvalidCommandName,
  InvalidJSON,
  InvalidRequestError,
  KeyAlreadyPaired,
  KeyRevoked,
  LinkButtonNotSupported,
  AuthorURLWithoutName,
  EmbedFooterTextRequired,
  EmbedURLWithoutTitle,
  InvalidButtonEmoji,
  LinkButtonMissingURL,
  LinkURLNotHTTPS,
  LinkURLTooLong,
  URLOnNonLinkButton,
  MentionNotMember,
  MentionTokenMissing,
  MessageNotYours,
  NotFound,
  PairRateLimited,
  ParameterInvalid,
  ParameterMissing,
  PermissionDeniedError,
  ProtocolError,
  RateLimitError,
  RateLimited,
  ReactionEmojiTooLong,
  ServerRestarting,
  SessionSuperseded,
  SyncRateLimited,
  TextTooLong,
  TooManyButtons,
  TooManyEmbedFields,
  TooManyEmbeds,
  TooManyProblems,
  NothingToEdit,
  TransportError,
  TYPE_CLASSES,
  UnknownOperation,
  UnknownParameter,
  fromEnvelope,
  type AurivalAPIErrorClass,
} from '../src/errors.js';

// This literal counts SDK error CLASSES — CODE_CLASSES's key set — which is
// a different number from the Go backend's error catalogue (that number is
// tracked live by python's own catalogue-parsing test, not by a literal
// here). The plan this test mirrors was written against 31 SDK classes.
// BA-R23 landed on main (a522dcb4) and its ruling gave `too_many_problems` a
// real row rather than a placeholder (see the class's own doc comment),
// taking it to 32. BA-R31/BA-R33 then added `idempotency_key_invalid` and
// `key_already_paired`, taking it to 34. AMENDMENT-04's mention/reaction/edit
// capabilities then added four more SDK classes — the merge-gate senior
// review ruled these must be real classes in both SDKs rather than fall back
// to the family class: `reaction_emoji_too_long` and `mention_token_missing`
// (invalid_request_error, 400), `mention_not_member` (invalid_request_error,
// 400 — deliberately answered for both a nonexistent user id and an existing
// non-member, AMENDMENT-04 A-4/R-8, so it can never serve as a
// user-existence oracle), and `message_not_yours` (permission_error, 403).
// That took the SDK class count to 38. AMENDMENT-05 §2's card surface then
// added the fifteen embed/button codes (all invalid_request_error) —
// `too_many_embeds`, `too_many_embed_fields`, `too_many_buttons`,
// `button_missing_field`, `button_id_too_long`, `duplicate_button_id`,
// `button_label_too_long`, `link_button_not_supported`,
// `invalid_button_style`, `embed_title_too_long`,
// `embed_description_too_long`, `embed_url_not_https`, `embed_empty`,
// `buttons_without_message`, `button_already_used` — taking it to 53, and AMENDMENT-06's eight new card codes take it to 61.
// AMENDMENT-07 §7 then adds `nothing_to_edit` (invalid_request_error,
// 400), taking it to 62. That class SHIPS AHEAD of the Go catalogue row —
// L1 has not landed `errors_v1.go`'s entry yet — so the go-catalogue
// parity twin below deliberately asserts only Go -> SDK, never the
// reverse. This
// literal is the acceptance bar for THAT number: a deleted or
// silently-added class fails the length/key-set assertion below.
const EXPECTED_CODES = [
  'access_token_expired',
  'access_token_invalid',
  'bad_assertion',
  'assertion_expired',
  'assertion_replay',
  'bad_proof',
  'bad_public_key',
  'key_revoked',
  'key_already_paired',
  'not_found',
  'invalid_command_name',
  'empty_text',
  'text_too_long',
  'bot_link_not_allowed',
  'invalid_json',
  'parameter_missing',
  'parameter_invalid',
  'unknown_parameter',
  'idempotency_key_reused',
  'idempotency_key_invalid',
  'bot_suspended',
  'bot_playground_only',
  'rate_limited',
  'pair_rate_limited',
  'sync_rate_limited',
  'internal_error',
  'session_superseded',
  'frame_too_large',
  'server_restarting',
  'idle_timeout',
  'frame_invalid',
  'unknown_operation',
  'ack_unknown_event',
  'too_many_problems',
  'nothing_to_edit',
  'reaction_emoji_too_long',
  'mention_not_member',
  'mention_token_missing',
  'message_not_yours',
  'too_many_embeds',
  'too_many_embed_fields',
  'too_many_buttons',
  'button_missing_field',
  'button_id_too_long',
  'duplicate_button_id',
  'button_label_too_long',
  'link_button_not_supported',
  'invalid_button_style',
  'embed_title_too_long',
  'embed_description_too_long',
  'embed_url_not_https',
  'link_url_not_https',
  'link_url_too_long',
  'link_button_missing_url',
  'url_on_non_link_button',
  'invalid_button_emoji',
  'embed_url_without_title',
  'author_url_without_name',
  'embed_footer_text_required',
  'embed_empty',
  'buttons_without_message',
  'button_already_used',
] as const;

// code -> [expected class, expected wire type it must be an instance of].
const EXPECTED: Record<string, [AurivalAPIErrorClass, string]> = {
  access_token_expired: [AccessTokenExpired, 'authentication_error'],
  access_token_invalid: [AccessTokenInvalid, 'authentication_error'],
  bad_assertion: [BadAssertion, 'authentication_error'],
  assertion_expired: [AssertionExpired, 'authentication_error'],
  assertion_replay: [AssertionReplay, 'authentication_error'],
  bad_proof: [BadProof, 'authentication_error'],
  bad_public_key: [BadPublicKey, 'authentication_error'],
  key_revoked: [KeyRevoked, 'authentication_error'],
  key_already_paired: [KeyAlreadyPaired, 'authentication_error'],
  not_found: [NotFound, 'invalid_request_error'],
  invalid_command_name: [InvalidCommandName, 'invalid_request_error'],
  empty_text: [EmptyText, 'invalid_request_error'],
  text_too_long: [TextTooLong, 'invalid_request_error'],
  bot_link_not_allowed: [BotLinkNotAllowed, 'invalid_request_error'],
  invalid_json: [InvalidJSON, 'invalid_request_error'],
  parameter_missing: [ParameterMissing, 'invalid_request_error'],
  parameter_invalid: [ParameterInvalid, 'invalid_request_error'],
  unknown_parameter: [UnknownParameter, 'invalid_request_error'],
  idempotency_key_reused: [IdempotencyKeyReused, 'invalid_request_error'],
  idempotency_key_invalid: [IdempotencyKeyInvalid, 'invalid_request_error'],
  bot_suspended: [BotSuspended, 'permission_error'],
  bot_playground_only: [BotPlaygroundOnly, 'permission_error'],
  rate_limited: [RateLimited, 'rate_limit_error'],
  pair_rate_limited: [PairRateLimited, 'rate_limit_error'],
  sync_rate_limited: [SyncRateLimited, 'rate_limit_error'],
  internal_error: [InternalError, 'api_error'],
  session_superseded: [SessionSuperseded, 'invalid_request_error'],
  frame_too_large: [FrameTooLarge, 'invalid_request_error'],
  server_restarting: [ServerRestarting, 'api_error'],
  idle_timeout: [IdleTimeout, 'api_error'],
  frame_invalid: [FrameInvalid, 'invalid_request_error'],
  unknown_operation: [UnknownOperation, 'invalid_request_error'],
  ack_unknown_event: [AckUnknownEvent, 'invalid_request_error'],
  too_many_problems: [TooManyProblems, 'invalid_request_error'],
  nothing_to_edit: [NothingToEdit, 'invalid_request_error'],
  reaction_emoji_too_long: [ReactionEmojiTooLong, 'invalid_request_error'],
  mention_not_member: [MentionNotMember, 'invalid_request_error'],
  mention_token_missing: [MentionTokenMissing, 'invalid_request_error'],
  message_not_yours: [MessageNotYours, 'permission_error'],
  too_many_embeds: [TooManyEmbeds, 'invalid_request_error'],
  too_many_embed_fields: [TooManyEmbedFields, 'invalid_request_error'],
  too_many_buttons: [TooManyButtons, 'invalid_request_error'],
  button_missing_field: [ButtonMissingField, 'invalid_request_error'],
  button_id_too_long: [ButtonIDTooLong, 'invalid_request_error'],
  duplicate_button_id: [DuplicateButtonID, 'invalid_request_error'],
  button_label_too_long: [ButtonLabelTooLong, 'invalid_request_error'],
  link_button_not_supported: [LinkButtonNotSupported, 'invalid_request_error'],
  link_url_not_https: [LinkURLNotHTTPS, 'invalid_request_error'],
  link_url_too_long: [LinkURLTooLong, 'invalid_request_error'],
  link_button_missing_url: [LinkButtonMissingURL, 'invalid_request_error'],
  url_on_non_link_button: [URLOnNonLinkButton, 'invalid_request_error'],
  invalid_button_emoji: [InvalidButtonEmoji, 'invalid_request_error'],
  embed_url_without_title: [EmbedURLWithoutTitle, 'invalid_request_error'],
  author_url_without_name: [AuthorURLWithoutName, 'invalid_request_error'],
  embed_footer_text_required: [EmbedFooterTextRequired, 'invalid_request_error'],
  invalid_button_style: [InvalidButtonStyle, 'invalid_request_error'],
  embed_title_too_long: [EmbedTitleTooLong, 'invalid_request_error'],
  embed_description_too_long: [EmbedDescriptionTooLong, 'invalid_request_error'],
  embed_url_not_https: [EmbedURLNotHTTPS, 'invalid_request_error'],
  embed_empty: [EmbedEmpty, 'invalid_request_error'],
  buttons_without_message: [ButtonsWithoutMessage, 'invalid_request_error'],
  button_already_used: [ButtonAlreadyUsed, 'invalid_request_error'],
};

function envelopeFor(code: string, type: string): Record<string, unknown> {
  return {
    error: {
      type,
      code,
      message: `message for ${code}`,
      doc_url: `https://bots.aurival.com/docs/errors#${code}`,
      request_id: `req_${code}`,
    },
  };
}

describe('CODE_CLASSES catalogue', () => {
  it('has exactly the expected 62-name key set (a deleted or added row fails this)', () => {
    expect(Object.keys(CODE_CLASSES).sort()).toEqual([...EXPECTED_CODES].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it.each(Object.keys(CODE_CLASSES))('code %s round-trips through fromEnvelope', (code) => {
    const entry = EXPECTED[code];
    if (entry === undefined) throw new Error(`no expectation recorded for ${code}`);
    const [expectedClass, expectedType] = entry;
    const exc = fromEnvelope(envelopeFor(code, expectedType));
    expect(exc).toBeInstanceOf(expectedClass);
    const typeParent = TYPE_CLASSES[expectedType];
    if (typeParent === undefined) throw new Error(`no TYPE_CLASSES row for ${expectedType}`);
    expect(exc).toBeInstanceOf(typeParent);
    expect(exc.code).toBe(code);
    expect(exc.constructor).toBe(expectedClass);
  });

  it('too_many_problems is a real row, not a placeholder (BA-R23, a522dcb4)', () => {
    expect(CODE_CLASSES['too_many_problems']).toBe(TooManyProblems);
    const exc = fromEnvelope(envelopeFor('too_many_problems', 'invalid_request_error'));
    expect(exc).toBeInstanceOf(TooManyProblems);
    expect(exc).toBeInstanceOf(InvalidRequestError);
  });
});

describe('TYPE_CLASSES catalogue', () => {
  const expectedTypes: Record<string, AurivalAPIErrorClass> = {
    authentication_error: AuthenticationError,
    invalid_request_error: InvalidRequestError,
    permission_error: PermissionDeniedError,
    rate_limit_error: RateLimitError,
    api_error: APIError,
  };

  it('has exactly the 5 expected rows', () => {
    expect(Object.keys(TYPE_CLASSES).sort()).toEqual(Object.keys(expectedTypes).sort());
  });

  it.each(Object.entries(expectedTypes))('%s maps to the right base class', (type, cls) => {
    expect(TYPE_CLASSES[type]).toBe(cls);
  });
});

describe('fromEnvelope fallbacks', () => {
  it('unknown code + known type falls back to the type class, never throws', () => {
    const exc = fromEnvelope({
      error: {
        type: 'invalid_request_error',
        code: 'some_future_code_not_yet_in_the_sdk',
        message: 'a new code the server started sending',
        doc_url: 'https://bots.aurival.com/docs/errors#some_future_code_not_yet_in_the_sdk',
        request_id: 'req_xyz',
      },
    });
    expect(exc.constructor).toBe(InvalidRequestError);
    expect(exc.code).toBe('some_future_code_not_yet_in_the_sdk');
  });

  it('unknown code + unknown type falls back to the base class, never throws', () => {
    const exc = fromEnvelope({
      error: {
        type: 'some_future_type',
        code: 'some_future_code',
        message: 'a whole new type',
        doc_url: 'https://bots.aurival.com/docs/errors#some_future_code',
        request_id: 'req_qqq',
      },
    });
    expect(exc.constructor).toBe(AurivalAPIError);
    expect(exc.type).toBe('some_future_type');
  });

  it('never throws on totally empty input', () => {
    const exc = fromEnvelope({});
    expect(exc).toBeInstanceOf(AurivalAPIError);
    expect(exc.code).toBe('');
    expect(exc.type).toBe('');
  });

  it('never throws on garbage-typed nested fields', () => {
    const exc = fromEnvelope({ error: { type: 5, code: null, message: [1, 2], doc_url: {} } });
    expect(exc).toBeInstanceOf(AurivalAPIError);
    expect(exc.code).toBe('');
    expect(exc.type).toBe('');
  });

  it('never throws when error is an array or a primitive', () => {
    expect(() => fromEnvelope({ error: [1, 2, 3] } as Record<string, unknown>)).not.toThrow();
    expect(() => fromEnvelope({ error: 'nope' } as Record<string, unknown>)).not.toThrow();
    expect(() => fromEnvelope({ error: null } as Record<string, unknown>)).not.toThrow();
  });

  it('accepts a bare inner object with no `error` wrapper', () => {
    const exc = fromEnvelope({
      type: 'permission_error',
      code: 'bot_suspended',
      message: 'This bot is suspended.',
      doc_url: 'https://bots.aurival.com/docs/errors#bot_suspended',
      request_id: null,
    });
    expect(exc).toBeInstanceOf(BotSuspended);
    expect(exc.request_id).toBeNull();
  });

  it('doc_url falls back to DOC_URL_PREFIX + code when absent', () => {
    const exc = fromEnvelope({
      error: { type: 'api_error', code: 'internal_error', message: 'oops' },
    });
    expect(exc.doc_url).toBe(DOC_URL_PREFIX + 'internal_error');
  });

  it('a supplied doc_url wins over the fallback', () => {
    const exc = fromEnvelope({
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'oops',
        doc_url: 'https://example.com/custom',
      },
    });
    expect(exc.doc_url).toBe('https://example.com/custom');
  });

  it('request_id, retry_after and status land on the instance, absent ones are null not undefined', () => {
    const withValues = fromEnvelope(
      { error: { type: 'api_error', code: 'internal_error', message: 'oops', request_id: 'r1' } },
      { status: 500, retryAfter: 2.5 },
    );
    expect(withValues.request_id).toBe('r1');
    expect(withValues.status).toBe(500);
    expect(withValues.retry_after).toBe(2.5);

    const withoutValues = fromEnvelope({
      error: { type: 'api_error', code: 'internal_error', message: 'oops' },
    });
    expect(withoutValues.request_id).toBeNull();
    expect(withoutValues.status).toBeNull();
    expect(withoutValues.retry_after).toBeNull();
    // Never undefined: these fields must be present keys on the instance.
    expect('request_id' in withoutValues).toBe(true);
    expect('status' in withoutValues).toBe(true);
    expect('retry_after' in withoutValues).toBe(true);
  });

  it('malformed non-string code/type/message never throws and coerces to empty string', () => {
    const exc = fromEnvelope({
      error: { type: 42, code: [1, 2], message: { nested: null }, request_id: 7 },
    });
    expect(exc.code).toBe('');
    expect(exc.type).toBe('');
    expect(exc.message).toBe('');
    expect(exc.request_id).toBeNull();
  });
});

describe('instance identity', () => {
  it('every CODE_CLASSES instance carries its code and doc_url', () => {
    for (const [code, cls] of Object.entries(CODE_CLASSES)) {
      const exc = new cls({ type: 'x', code, message: 'm', doc_url: 'd' });
      expect(exc.code).toBe(code);
      expect(exc.doc_url).toBe('d');
    }
  });

  it('every error is instanceof Error and instanceof AurivalError, .name is its own class name', () => {
    for (const [code, cls] of Object.entries(CODE_CLASSES)) {
      const exc = new cls({ type: 'x', code, message: 'm', doc_url: 'd' });
      expect(exc).toBeInstanceOf(Error);
      expect(exc).toBeInstanceOf(AurivalError);
      expect(exc.name).toBe(cls.name);
    }
    expect(new TransportError('t')).toBeInstanceOf(AurivalError);
    expect(new ProtocolError('p')).toBeInstanceOf(AurivalError);
    expect(new TransportError('t').name).toBe('TransportError');
    expect(new ProtocolError('p').name).toBe('ProtocolError');
  });

  it('.message is the server-provided message', () => {
    const exc = fromEnvelope({
      error: {
        type: 'invalid_request_error',
        code: 'empty_text',
        message: 'A message needs text.',
      },
    });
    expect(exc.message).toBe('A message needs text.');
  });
});

// --- the go-catalogue parity twin (AMENDMENT-07 §10's js side) --------------
//
// `EXPECTED_CODES` above counts SDK CLASSES. This block counts the BACKEND's
// catalogue, by parsing `errors_v1.go` itself — the twin of
// `sdk/python/tests/test_errors.py`'s catalogue test, with the same regexes
// over the same const names, so a code added to Go and forgotten in js fails
// here rather than in production.
//
// SKIP-GUARDED, never a hard failure: the public mirror (`Nullspire-LLC/
// aurival-sdk`) ships `sdk/` alone, so the Go tree is simply not there and
// this guard has nothing to compare against.
//
// ONE DIRECTION ONLY — Go -> SDK. There is deliberately no reverse
// class -> catalogue assertion: `nothing_to_edit` ships ahead of L1's Go row
// (AMENDMENT-07 §7), so the SDK legitimately knows a code Go does not yet
// name, and a reverse assertion would go red on correct code.

const GO_ERRORS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../backend-go/internal/botapi/errors_v1.go',
);

const GO_TREE_PRESENT = existsSync(GO_ERRORS_FILE);

/** `TypeAuthentication = "authentication_error"` -> { TypeAuthentication: '…' }. */
function parseConstants(src: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = new RegExp(String.raw`\b(${prefix}\w+)\s*=\s*"([a-z_]+)"`, 'g');
  for (const match of src.matchAll(pattern)) out.set(match[1] as string, match[2] as string);
  return out;
}

/**
 * Walks the `errCatalogue` map literal and returns { CodeConst -> TypeConst }.
 * Entries read `CodeAccessTokenExpired: {TypeAuthentication, 401,` — the const
 * NAMES, not the string values, so this is independent of how either side
 * spells the wire strings.
 */
function parseCatalogueTypes(src: string): Map<string, string> {
  const start = src.indexOf('var errCatalogue');
  if (start === -1) throw new Error('failed to find `var errCatalogue` in errors_v1.go');
  const body = src.slice(start);
  const out = new Map<string, string>();
  for (const match of body.matchAll(/\b(Code\w+):\s*\{\s*(Type\w+)\s*,/g)) {
    out.set(match[1] as string, match[2] as string);
  }
  return out;
}

/** { wire code -> wire type }, straight off the Go source. */
function goCatalogueCodes(): Map<string, string> {
  const src = readFileSync(GO_ERRORS_FILE, 'utf8');
  const typeConsts = parseConstants(src, 'Type');
  const codeConsts = parseConstants(src, 'Code');
  const catalogue = parseCatalogueTypes(src);
  if (catalogue.size === 0) {
    throw new Error('failed to parse errCatalogue out of errors_v1.go — regex is stale');
  }
  const out = new Map<string, string>();
  for (const [codeConst, typeConst] of catalogue) {
    const code = codeConsts.get(codeConst);
    const wireType = typeConsts.get(typeConst);
    if (code === undefined) throw new Error(`no string constant for ${codeConst}`);
    if (wireType === undefined) throw new Error(`no string constant for ${typeConst}`);
    out.set(code, wireType);
  }
  return out;
}

/**
 * MEASURED, and the reason the parse is NOT inside the `describe` below:
 * vitest collects a skipped suite by RUNNING its factory, so a `readFileSync`
 * in the suite body throws ENOENT on the public mirror even though every test
 * in it is marked skipped. The guard therefore lives out here, and the absent
 * case hands `it.each` one placeholder row so it still has a case to skip.
 */
const GO_CATALOGUE: ReadonlyMap<string, string> = GO_TREE_PRESENT
  ? goCatalogueCodes()
  : new Map([['(backend-go is not in this checkout)', 'authentication_error']]);

describe.skipIf(!GO_TREE_PRESENT)('go catalogue parity (parsed from errors_v1.go)', () => {
  const catalogue = GO_CATALOGUE;

  it('parsed something sane (a canary: at 0 every assertion below passes vacuously)', () => {
    expect(catalogue.size).toBeGreaterThanOrEqual(30);
    expect(catalogue.get('access_token_expired')).toBe('authentication_error');
  });

  it.each([...catalogue.keys()].sort())(
    'go code %s has a CODE_CLASSES row whose class matches the catalogue type',
    (code) => {
      const wireType = catalogue.get(code);
      if (wireType === undefined) throw new Error(`no catalogue entry for ${code}`);
      const cls = CODE_CLASSES[code];
      expect(cls, `${code} is in the Go catalogue but has no CODE_CLASSES row`).toBeDefined();
      const typeParent = TYPE_CLASSES[wireType];
      if (typeParent === undefined) throw new Error(`no TYPE_CLASSES row for ${wireType}`);
      const exc = fromEnvelope(envelopeFor(code, wireType));
      expect(exc).toBeInstanceOf(cls as AurivalAPIErrorClass);
      expect(exc).toBeInstanceOf(typeParent);
    },
  );
});
