/**
 * The mirror contract (SDK-7). `sdk/python/aurival/__init__.py` exports 57 names;
 * this package exports the same 57. A name missing here is a permanent asymmetry:
 * adding an export later is free, removing one is a break.
 */

import { describe, it, expect } from 'vitest';
import * as aurival from '../src/index.js';

// The three type-only rows, imported so `tsc` fails if any goes missing. Python's
// User/Chat/Command are frozen dataclasses with no methods; the JS mirror of a
// pure record is an interface, which has no runtime binding.
import type { Chat, Command, User } from '../src/index.js';

const TYPE_ONLY = ['Chat', 'Command', 'User'] as const;

/** Exactly Python's `__all__`, with its three casing changes applied. */
const EXPECTED = [
  'APIError',
  'AccessTokenExpired',
  'AccessTokenInvalid',
  'AckUnknownEvent',
  'AssertionExpired',
  'AssertionReplay',
  'AurivalAPIError',
  'AurivalError',
  'AuthenticationError',
  'BYE_ACTIONS',
  'BadAssertion',
  'BadProof',
  'BadPublicKey',
  'Bot',
  'BotLinkNotAllowed',
  'BotPlaygroundOnly',
  'BotSuspended',
  'ByeAction',
  'CODE_CLASSES',
  'Chat',
  'Command',
  'Context',
  'DOC_URL_PREFIX',
  'EmptyText',
  'Event',
  'FrameInvalid',
  'FrameTooLarge',
  'IdempotencyKeyInvalid',
  'IdempotencyKeyReused',
  'IdleTimeout',
  'InternalError',
  'InvalidCommandName',
  'InvalidJSON',
  'InvalidRequestError',
  'KeyAlreadyPaired',
  'KeyRevoked',
  'NotFound',
  'PairRateLimited',
  'ParameterInvalid',
  'ParameterMissing',
  'PermissionDeniedError',
  'ProtocolError',
  'RateLimitError',
  'RateLimited',
  'ServerRestarting',
  'SessionSuperseded',
  'SyncRateLimited',
  'TYPE_CLASSES',
  'TextTooLong',
  'TooManyProblems',
  'TransportError',
  'UnknownOperation',
  'UnknownParameter',
  'User',
  'actionForBye',
  'fromEnvelope',
  'version',
];

describe('the public surface', () => {
  it('is exactly the 57 names Python exports', () => {
    expect(EXPECTED.length).toBe(57);
    const runtime = Object.keys(aurival).sort();
    const expectedRuntime = EXPECTED.filter(
      (n) => !(TYPE_ONLY as readonly string[]).includes(n),
    ).sort();
    expect(runtime).toEqual(expectedRuntime);
  });

  it('exports nothing the mirror does not name', () => {
    for (const name of Object.keys(aurival)) {
      expect(EXPECTED, `${name} is exported but is not in the mirror contract`).toContain(name);
    }
  });

  it('does not leak the module-internal names Python keeps out of __all__', () => {
    // MachineKey, KeyFile, Auth, HttpClient, Socket, pair, resolveHost,
    // machineLabel and DEFAULT_HOST are module exports the tests reach by path.
    // They are not package surface, in either language.
    for (const name of [
      'MachineKey',
      'KeyFile',
      'Auth',
      'HttpClient',
      'Socket',
      'pair',
      'resolveHost',
      'machineLabel',
      'DEFAULT_HOST',
    ]) {
      expect(Object.keys(aurival)).not.toContain(name);
    }
  });

  it('keeps ByeAction a plain object, not a TS enum', () => {
    // A TS `enum` would change the runtime shape of an exported name, and its
    // reverse mapping would put numbers in Object.keys.
    expect(Object.keys(aurival.ByeAction).sort()).toEqual([
      'RAISE',
      'REAUTH_RECONNECT',
      'SHORT_WAIT_RECONNECT',
    ]);
    expect(Object.values(aurival.ByeAction).every((v) => typeof v === 'string')).toBe(true);
  });

  it('types the three record rows', () => {
    const user: User = { id: 'usr_1', handle: 'h', name: 'n' };
    const chat: Chat = { id: 'chat_1', type: 'dm', name: null };
    const command: Command = { name: 'ping', description: '' };
    expect([user.id, chat.id, command.name]).toEqual(['usr_1', 'chat_1', 'ping']);
  });

  it('reports a version', () => {
    expect(aurival.version).toBe('0.1.1');
  });
});
