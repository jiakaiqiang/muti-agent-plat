import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeType } from './contracts.js';
import {
  canRetryRuntimeSwitchFrom,
  canTransitionRuntimeSwitch,
  DEFAULT_RUNTIME_SWITCH_FALLBACK_MODE,
  isRuntimeSwitchFallbackMode,
  isTerminalRuntimeSwitchStatus,
  normalizeRuntimePreference,
  RUNTIME_SWITCH_FALLBACK_MODES,
  runtimeSwitchEventKey,
  runtimeSwitchLogicalKey
} from './runtime-switch-contracts.js';
import { applyRuntimeSwitchToPreference, resolveFallbackRuntimeChain, effectiveRuntimePreference } from './runtime-switch-contracts.js';

test('explicit empty fallback and deny-all survive normalization and switching never expands permission', () => {
  assert.deepEqual(resolveFallbackRuntimeChain(normalizeRuntimePreference({ preferredRuntimeType: 'codex',
    allowedRuntimeTypes: ['codex', 'claude_code'], fallbackRuntimeTypes: [] })), []);
  assert.throws(() => applyRuntimeSwitchToPreference({ preference: { allowedRuntimeTypes: ['codex'] },
    targetRuntimeType: 'claude_code', fallbackMode: 'keep' }), /NOT_AUTHORIZED/);
  assert.throws(() => applyRuntimeSwitchToPreference({ preference: { allowedRuntimeTypes: [] },
    targetRuntimeType: 'claude_code', fallbackMode: 'keep' }), /NOT_AUTHORIZED/);
  const changed = applyRuntimeSwitchToPreference({ preference: { preferredRuntimeType: 'codex', preferredModelId: 'codex-model',
    allowedRuntimeTypes: ['codex', 'claude_code'] }, targetRuntimeType: 'claude_code', fallbackMode: 'keep' });
  assert.equal(changed.preferredModelId, undefined, 'a provider-specific model is not inherited across Runtimes');
  const session = { activeWorkItemId: 'new', runtimePreference: { preferredRuntimeType: 'codex' as const },
    runtimeSwitchOverride: { workItemId: 'old', preference: changed, switchRequestId: 'switch' } };
  assert.equal(effectiveRuntimePreference(session)?.preferredRuntimeType, 'codex');
  assert.equal(effectiveRuntimePreference({ ...session, runtimeFailover: {
    workItemId: 'new', runtimeType: 'claude_code', preferenceRevision: 0 } })?.preferredRuntimeType, 'claude_code');
  assert.equal(effectiveRuntimePreference({ ...session, runtimeFailover: {
    workItemId: 'old', runtimeType: 'claude_code', preferenceRevision: 0 } })?.preferredRuntimeType, 'codex');
});

test('normalization keeps only real RuntimeTypes and drops empty preferences', () => {
  assert.equal(normalizeRuntimePreference(undefined), undefined);
  assert.equal(normalizeRuntimePreference({}), undefined);
  assert.equal(
    normalizeRuntimePreference({ preferredRuntimeType: 'not_a_runtime' as never }),
    undefined,
    'an unknown Runtime is not a preference'
  );
  assert.deepEqual(
    normalizeRuntimePreference({
      preferredRuntimeType: 'codex',
      allowedRuntimeTypes: ['codex', 'codex', 'bogus' as never, 'claude_code']
    }),
    { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex', 'claude_code'] },
    'allowed types are de-duplicated and filtered while keeping their order'
  );
});

test('the preferred Runtime must itself be allowed once an allowlist is given', () => {
  assert.deepEqual(
    normalizeRuntimePreference({ preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['codex'] }),
    { allowedRuntimeTypes: ['codex'] },
    'a preference outside the allowlist is dropped rather than silently widening it'
  );
  assert.deepEqual(
    normalizeRuntimePreference({ preferredRuntimeType: 'codex' }),
    { preferredRuntimeType: 'codex' },
    'no allowlist means no authorization narrowing to check against'
  );
});

test('fallback order is a subset of the allowlist and never repeats the preferred Runtime', () => {
  assert.deepEqual(
    normalizeRuntimePreference({
      preferredRuntimeType: 'codex',
      allowedRuntimeTypes: ['codex', 'claude_code', 'generic_llm'],
      fallbackRuntimeTypes: ['generic_llm', 'codex', 'mock', 'claude_code', 'generic_llm']
    }),
    {
      preferredRuntimeType: 'codex',
      allowedRuntimeTypes: ['codex', 'claude_code', 'generic_llm'],
      fallbackRuntimeTypes: ['generic_llm', 'claude_code']
    },
    'the preferred Runtime, unauthorized types and duplicates leave the fallback chain'
  );
  assert.deepEqual(
    normalizeRuntimePreference({
      preferredRuntimeType: 'codex',
      allowedRuntimeTypes: ['codex'],
      fallbackRuntimeTypes: ['claude_code']
    }),
    { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'], fallbackRuntimeTypes: [] },
    'a fallback chain cannot expand authorization beyond the allowlist'
  );
});

test('ordering a fallback chain is not a way to grant authorization', () => {
  // With no allowlist the order is kept: it states a preference, not a permission.
  // Dropping it would silently discard user intent without denying anything, because
  // authorization is decided by the resolve-time intersection (admin ∩ session ∩
  // workspace ∩ task), never by this list on its own (I5).
  assert.deepEqual(
    normalizeRuntimePreference({ fallbackRuntimeTypes: ['codex', 'claude_code'] }),
    { fallbackRuntimeTypes: ['codex', 'claude_code'] },
    'an order without an allowlist is a preference, not a grant'
  );
  // Unknown values still carry no meaning at all.
  assert.deepEqual(
    normalizeRuntimePreference({ fallbackRuntimeTypes: ['not_a_runtime' as RuntimeType] }),
    { fallbackRuntimeTypes: [] },
    'an invalid explicit fallback chain stays disabled instead of deriving new candidates'
  );
});

test('revision is a non-negative integer used for optimistic concurrency', () => {
  assert.deepEqual(
    normalizeRuntimePreference({ preferredRuntimeType: 'codex', revision: 7 }),
    { preferredRuntimeType: 'codex', revision: 7 }
  );
  for (const revision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      normalizeRuntimePreference({ preferredRuntimeType: 'codex', revision }),
      { preferredRuntimeType: 'codex' },
      `revision ${revision} is not a usable version`
    );
  }
  assert.deepEqual(
    normalizeRuntimePreference({ preferredRuntimeType: 'codex', revision: 0 }),
    { preferredRuntimeType: 'codex', revision: 0 },
    'revision 0 is the initial version, not a missing one'
  );
});

test('normalization does not mutate or alias the caller input', () => {
  const input = {
    preferredRuntimeType: 'codex' as const,
    allowedRuntimeTypes: ['codex', 'claude_code'] satisfies RuntimeType[],
    fallbackRuntimeTypes: ['claude_code'] satisfies RuntimeType[]
  };
  const normalized = normalizeRuntimePreference(input)!;
  assert.notEqual(normalized.allowedRuntimeTypes, input.allowedRuntimeTypes);
  assert.notEqual(normalized.fallbackRuntimeTypes, input.fallbackRuntimeTypes);
  assert.deepEqual(input.allowedRuntimeTypes, ['codex', 'claude_code']);
  assert.deepEqual(input.fallbackRuntimeTypes, ['claude_code']);
});

test('a switch request only moves along the one-way transition table', () => {
  assert.equal(canTransitionRuntimeSwitch('requested', 'preflighted'), true);
  assert.equal(canTransitionRuntimeSwitch('preflighted', 'stopping'), true);
  assert.equal(canTransitionRuntimeSwitch('stopping', 'stop_confirmed'), true);
  assert.equal(canTransitionRuntimeSwitch('stop_confirmed', 'applying'), true);
  assert.equal(canTransitionRuntimeSwitch('applying', 'resuming'), true);
  assert.equal(canTransitionRuntimeSwitch('resuming', 'completed'), true);

  // I1: the target Runtime may not be started before the stop is confirmed, so
  // no stage before stop_confirmed may reach applying.
  assert.equal(canTransitionRuntimeSwitch('requested', 'applying'), false);
  assert.equal(canTransitionRuntimeSwitch('preflighted', 'applying'), false);
  assert.equal(canTransitionRuntimeSwitch('stopping', 'applying'), false);

  // A stop that is not confirmed stays in stopping; it never rewinds to a stage
  // that would let an ordinary invocation through.
  assert.equal(canTransitionRuntimeSwitch('stopping', 'stopping'), false);
  assert.equal(canTransitionRuntimeSwitch('stopping', 'requested'), false);
  assert.equal(canTransitionRuntimeSwitch('stop_confirmed', 'stopping'), false);

  // Terminal states are terminal.
  assert.equal(canTransitionRuntimeSwitch('completed', 'resuming'), false);
  assert.equal(canTransitionRuntimeSwitch('completed', 'failed'), false);
  assert.equal(canTransitionRuntimeSwitch('failed', 'requested'), false);
  assert.equal(canTransitionRuntimeSwitch('failed', 'applying'), false);
});

test('every non-terminal stage can fail, and the failure records where it stopped', () => {
  for (const status of ['requested', 'preflighted', 'stopping', 'stop_confirmed', 'applying', 'resuming'] as const) {
    assert.equal(canTransitionRuntimeSwitch(status, 'failed'), true, `${status} must be able to fail closed`);
  }
  assert.equal(isTerminalRuntimeSwitchStatus('completed'), true);
  assert.equal(isTerminalRuntimeSwitchStatus('failed'), true);
  assert.equal(isTerminalRuntimeSwitchStatus('stopping'), false);
});

test('a failed switch may only be retried from the stage that failed', () => {
  // Retrying a stop is idempotent and safe. Retrying from an earlier stage is
  // not: it would re-preflight against state the stop barrier already owns.
  assert.equal(canRetryRuntimeSwitchFrom('stopping'), true);
  assert.equal(canRetryRuntimeSwitchFrom('stop_confirmed'), true);
  assert.equal(canRetryRuntimeSwitchFrom('applying'), true);
  assert.equal(canRetryRuntimeSwitchFrom('requested'), true);
  assert.equal(canRetryRuntimeSwitchFrom('preflighted'), true);
  // Resuming a write task without a trusted candidate waits for the user (I8).
  assert.equal(canRetryRuntimeSwitchFrom('resuming'), false);
});

test('the idempotency key is the request identity, so a replayed POST is one request', () => {
  const key = runtimeSwitchLogicalKey({
    sessionId: 'session-1',
    idempotencyKey: 'client-key-1'
  });
  assert.equal(
    key,
    runtimeSwitchLogicalKey({ sessionId: 'session-1', idempotencyKey: 'client-key-1' }),
    'the same client key against the same Session is the same request'
  );
  assert.notEqual(
    key,
    runtimeSwitchLogicalKey({ sessionId: 'session-2', idempotencyKey: 'client-key-1' }),
    'the same client key in another Session is a different request'
  );
  assert.match(key, /^runtime-switch-v1\|/, 'the key is versioned so a contract change cannot collide');
});

test('the event idempotency key is per request version so no update is lost or doubled', () => {
  assert.equal(
    runtimeSwitchEventKey({ switchRequestId: 'switch-1', version: 3 }),
    'runtime-switch:switch-1:3'
  );
  assert.notEqual(
    runtimeSwitchEventKey({ switchRequestId: 'switch-1', version: 3 }),
    runtimeSwitchEventKey({ switchRequestId: 'switch-1', version: 4 })
  );
});

test('fallbackMode is an explicit user choice with a safe default', () => {
  assert.equal(DEFAULT_RUNTIME_SWITCH_FALLBACK_MODE, 'exclude_previous_once');
  assert.deepEqual(
    [...RUNTIME_SWITCH_FALLBACK_MODES],
    ['keep', 'exclude_previous_once', 'target_only'],
    'the three modes are the whole contract; anything else must be refused'
  );
  assert.equal(isRuntimeSwitchFallbackMode('keep'), true);
  assert.equal(isRuntimeSwitchFallbackMode('target_only'), true);
  assert.equal(isRuntimeSwitchFallbackMode('exclude_previous'), false, 'a near-miss mode is not accepted');
  assert.equal(isRuntimeSwitchFallbackMode(undefined), false);
});
