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
  CODE_CLASSES,
  DOC_URL_PREFIX,
  EmptyText,
  FrameInvalid,
  FrameTooLarge,
  IdempotencyKeyInvalid,
  IdempotencyKeyReused,
  IdleTimeout,
  InternalError,
  InvalidCommandName,
  InvalidJSON,
  InvalidRequestError,
  KeyAlreadyPaired,
  KeyRevoked,
  NotFound,
  PairRateLimited,
  ParameterInvalid,
  ParameterMissing,
  PermissionDeniedError,
  ProtocolError,
  RateLimitError,
  RateLimited,
  ServerRestarting,
  SessionSuperseded,
  SyncRateLimited,
  TextTooLong,
  TooManyProblems,
  TransportError,
  TYPE_CLASSES,
  UnknownOperation,
  UnknownParameter,
  fromEnvelope,
  type AurivalAPIErrorClass,
} from '../src/errors.js';

// The plan this test mirrors was written against a 31-row catalogue. BA-R23
// landed on main (a522dcb4) and its ruling gave `too_many_problems` a real
// row rather than a placeholder (see the class's own doc comment), taking it
// to 32. BA-R31/BA-R33 then added `idempotency_key_invalid` and
// `key_already_paired`, so the live catalogue is 34 rows. This literal is the
// acceptance bar: a deleted or silently-added row fails the length/key-set
// assertion below.
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
  it('has exactly the expected 34-name key set (a deleted or added row fails this)', () => {
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
