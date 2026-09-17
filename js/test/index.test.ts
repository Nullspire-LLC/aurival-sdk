/**
 * The mirror contract (SDK-7). `sdk/python/aurival/__init__.py` exports the same
 * names this package does. A name missing here is a permanent asymmetry: adding
 * an export later is free, removing one is a break. Bumped 57 -> 61 for the
 * AMENDMENT-04 additions: `Mention`, `mention`, `MemberPage`. The merge-gate
 * senior review then required four more real error classes in both SDKs —
 * `MentionNotMember`, `MentionTokenMissing`, `MessageNotYours`,
 * `ReactionEmojiTooLong` — taking python's `__all__` to 65. `EXPECTED` also
 * carries one entry with no Python counterpart, `MentionLike` — a JS-only
 * type export (a union alias for what `send(..., { mentions })` accepts). It
 * is listed here, and in `TYPE_ONLY`, purely so `tsc` catches its removal; it
 * is excluded from the runtime-surface comparison below because it is
 * type-only, and it is not part of the Python mirror contract.
 *
 * AMENDMENT-05 (0.4.0) adds the embeds/buttons surface: `Embed`, `Button`
 * (runtime builder classes) and `ButtonContext` (a fourth `on()`-family
 * context, alongside `ButtonUsed`, a type-only decoded-wire interface).
 * AMENDMENT-05 §2 then added fifteen more error classes for the card's caps
 * and per-field refusals (`TooManyEmbeds` through `ButtonAlreadyUsed`),
 * taking python's `__all__` to 92 and this mirror's count to 91 names plus
 * the JS-only `MentionLike`.
 */

import { describe, it, expect } from 'vitest';
import * as aurival from '../src/index.js';

// The type-only rows, imported so `tsc` fails if any goes missing. Python's
// User/Chat/Command/MemberPage are frozen dataclasses with no methods; the JS
// mirror of a pure record is an interface, which has no runtime binding.
// `MentionLike` is JS-only (see file header) and has no Python counterpart at all.
import type {
  AnyContext,
  Chat,
  Command,
  EventType,
  MemberPage,
  MentionLike,
  User,
  ButtonUsed,
} from '../src/index.js';
import { readFileSync } from 'node:fs';

// `AnyContext` and `EventType` are type-only in both languages: Python spells
// them as a `Union` and a `Literal`, which have no runtime class either.
// `ButtonUsed` is a decoded-wire record type, same shape as `Chat`/`Command`.
const TYPE_ONLY = [
  'AnyContext',
  'Chat',
  'Command',
  'EventType',
  'MemberPage',
  'MentionLike',
  'User',
  'ButtonUsed',
] as const;

/** Exactly Python's `__all__`, with its three casing changes applied. */
const EXPECTED = [
  'APIError',
  'AccessTokenExpired',
  'AccessTokenInvalid',
  'AckUnknownEvent',
  'AssertionExpired',
  'AssertionReplay',
  'AurivalAPIError',
  'AnyContext',
  'AurivalError',
  'AuthenticationError',
  'BYE_ACTIONS',
  'BadAssertion',
  'BadProof',
  'BadPublicKey',
  'BaseContext',
  'Bot',
  'BotContext',
  'BotLinkNotAllowed',
  'BotPlaygroundOnly',
  'BotSuspended',
  'Button',
  'ButtonAlreadyUsed',
  'ButtonContext',
  'ButtonIDTooLong',
  'ButtonLabelTooLong',
  'ButtonMissingField',
  'ButtonUsed',
  'ButtonsWithoutMessage',
  'ByeAction',
  'CODE_CLASSES',
  'Chat',
  'Command',
  'Context',
  'DOC_URL_PREFIX',
  'DuplicateButtonID',
  'Embed',
  'EmbedDescriptionTooLong',
  'EmbedEmpty',
  'EmbedTitleTooLong',
  'EmbedURLNotHTTPS',
  'EmptyText',
  'Event',
  'EventContext',
  'EventType',
  'FrameInvalid',
  'FrameTooLarge',
  'IdempotencyKeyInvalid',
  'IdempotencyKeyReused',
  'IdleTimeout',
  'InternalError',
  'InvalidButtonStyle',
  'InvalidCommandName',
  'InvalidJSON',
  'InvalidRequestError',
  'KeyAlreadyPaired',
  'KeyRevoked',
  'LinkButtonNotSupported',
  'AuthorURLWithoutName',
  'EmbedFooterTextRequired',
  'EmbedURLWithoutTitle',
  'InvalidButtonEmoji',
  'LinkButtonMissingURL',
  'LinkURLNotHTTPS',
  'LinkURLTooLong',
  'URLOnNonLinkButton',
  'MemberContext',
  'MemberPage',
  'Mention',
  'MentionLike',
  'MentionNotMember',
  'MentionTokenMissing',
  'MessageNotYours',
  'NotFound',
  'NothingToEdit',
  'PairRateLimited',
  'ParameterInvalid',
  'ParameterMissing',
  'PermissionDeniedError',
  'ProtocolError',
  'RateLimitError',
  'RateLimited',
  'ReactionContext',
  'ReactionEmojiTooLong',
  'ServerRestarting',
  'SessionSuperseded',
  'SyncRateLimited',
  'TYPE_CLASSES',
  'TextTooLong',
  'TooManyButtons',
  'TooManyEmbedFields',
  'TooManyEmbeds',
  'TooManyProblems',
  'TransportError',
  'UnknownOperation',
  'UnknownParameter',
  'User',
  'actionForBye',
  'fromEnvelope',
  'mention',
  'version',
];

describe('the public surface', () => {
  // Python's `__all__` had 72 names (65 at AMENDMENT-04, plus the 7 BA-R68
  // context names: AnyContext, BaseContext, BotContext, EventContext,
  // EventType, MemberContext, ReactionContext); 71 of them were mirrored
  // here. `Message` is the one it does not mirror — it is a type-only export
  // in `index.ts` and predates this list. AMENDMENT-05 (0.4.0) adds four more
  // mirrored names — `Button`, `ButtonContext`, `ButtonUsed`, `Embed` — so the
  // count was 75 mirrored names plus the JS-only `MentionLike`, 76 total.
  // AMENDMENT-05 §2 then added fifteen error classes for the card's caps and
  // per-field refusals, all mirrored in both SDKs — 90 mirrored names plus
  // `MentionLike`.
  // AMENDMENT-07 §7 then adds `NothingToEdit`, mirrored in both SDKs — 99
  // mirrored names plus `MentionLike`, 100 total.
  it('is exactly the 99 Python names JS mirrors, plus the JS-only MentionLike type', () => {
    expect(EXPECTED.length).toBe(100);
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

  it('types the record rows', () => {
    const user: User = { id: 'usr_1', handle: 'h', name: 'n' };
    const chat: Chat = { id: 'chat_1', type: 'dm', name: null, member_count: null };
    const command: Command = { name: 'ping', description: '' };
    const page: MemberPage = { users: [user], hasMore: false, nextCursor: null };
    const mentionLike: MentionLike = { user: 'usr_1' };
    expect([user.id, chat.id, command.name, page.users[0]?.id, mentionLike.user]).toEqual([
      'usr_1',
      'chat_1',
      'ping',
      'usr_1',
      'usr_1',
    ]);
  });

  it('mention() builds a Mention with a template-literal-ready token', () => {
    const user: User = { id: 'usr_1', handle: 'h', name: 'n' };
    const m = aurival.mention(user);
    expect(m.token).toBe('@h');
    expect(m.entry).toEqual({ user: 'usr_1' });
    expect(`hey ${m}`).toBe('hey @h');
    expect(m).toBeInstanceOf(aurival.Mention);
  });

  it('reports the version package.json ships as', () => {
    // 0.2.1 shipped saying '0.2.0' because this test pinned a literal instead
    // of the manifest. The manifest is what npm publishes; `version` follows it.
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    expect(aurival.version).toBe(manifest.version);
    expect(aurival.version).toBe('0.6.0');
  });
});
