import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeUsage } from './contracts.js';
import {
  CACHE_CONTRACT_POLICY_VERSION,
  cacheDependencyFingerprint,
  derivedCacheKey,
  isCacheKeyScopedTo,
  normalizeRuntimeUsage,
  summarizeUsageBreakdown
} from './cache-contracts.js';

test('policy version is pinned so a key shape change cannot silently reuse old entries', () => {
  assert.equal(CACHE_CONTRACT_POLICY_VERSION, 'cache-contract-v1');
});

test('normalized usage keeps provider cache tokens out of the logical input total', () => {
  // Anthropic reports input_tokens as the uncached portion only: cache reads and
  // cache writes arrive as separate counters. Adding them onto inputTokens would
  // double-count the same prompt.
  const normalized = normalizeRuntimeUsage({
    provider: 'anthropic-compatible',
    raw: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    cacheReadInputTokens: 900,
    cacheWriteInputTokens: 50
  });

  assert.equal(normalized.uncachedInputTokens, 100);
  assert.equal(normalized.cacheReadInputTokens, 900);
  assert.equal(normalized.cacheWriteInputTokens, 50);
  // Logical input is what the model actually had to read: uncached + cache read.
  assert.equal(normalized.logicalInputTokens, 1_000);
  assert.equal(normalized.outputTokens, 20);
  assert.equal(normalized.inputTokensIncludeCacheRead, false);
  assert.equal(normalized.availability, 'reported');
});

test('normalized usage does not re-add cache reads when the provider already folded them in', () => {
  // OpenAI reports prompt_tokens as the full prompt with cached_tokens as a
  // subset of it, so the logical input is prompt_tokens itself.
  const normalized = normalizeRuntimeUsage({
    provider: 'openai-compatible',
    raw: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020 },
    cacheReadInputTokens: 900
  });

  assert.equal(normalized.inputTokensIncludeCacheRead, true);
  assert.equal(normalized.logicalInputTokens, 1_000);
  assert.equal(normalized.uncachedInputTokens, 100);
  assert.equal(normalized.cacheReadInputTokens, 900);
});

test('missing provider usage is unknown, never zero', () => {
  const normalized = normalizeRuntimeUsage({ provider: 'anthropic-compatible', raw: undefined });

  assert.equal(normalized.availability, 'unknown');
  assert.equal(normalized.logicalInputTokens, undefined);
  assert.equal(normalized.outputTokens, undefined);
  // A configured-but-silent cache must not be reported as a miss with 0 tokens.
  assert.equal(normalized.cacheReadInputTokens, undefined);
});

test('cost stays unknown when no price version backs it', () => {
  const priced = normalizeRuntimeUsage({
    provider: 'openai-compatible',
    raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: 0.5 },
    priceVersion: 'openai-2026-09'
  });
  assert.deepEqual(priced.cost, { amount: 0.5, priceVersion: 'openai-2026-09', basis: 'actual' });

  const unpriced = normalizeRuntimeUsage({
    provider: 'openai-compatible',
    raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: 0.5 }
  });
  assert.equal(unpriced.cost, undefined, 'an amount without a price version is not reportable');
});

test('cache capability is unsupported/unknown rather than assumed', () => {
  const unknown = normalizeRuntimeUsage({
    provider: 'ollama',
    raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    cacheCapability: 'unknown'
  });
  assert.equal(unknown.cacheCapability, 'unknown');
  assert.equal(unknown.cacheReadInputTokens, undefined, 'unknown capability must not imply a zero-token miss');

  const unsupported = normalizeRuntimeUsage({
    provider: 'ollama',
    raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    cacheCapability: 'unsupported'
  });
  assert.equal(unsupported.cacheCapability, 'unsupported');
});

test('usage breakdown aggregates per attempt and is idempotent on replay', () => {
  const attempt = {
    attemptId: 'attempt-1',
    provider: 'anthropic-compatible' as const,
    raw: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    cacheReadInputTokens: 900
  };

  const once = summarizeUsageBreakdown([attempt]);
  const twice = summarizeUsageBreakdown([attempt, { ...attempt }]);

  assert.equal(once.logicalInputTokens, 1_000);
  assert.deepEqual(twice, once, 'the same attemptId settled twice must not double-count');
});

test('usage breakdown reports unknown attempts separately from measured ones', () => {
  const breakdown = summarizeUsageBreakdown([
    {
      attemptId: 'a',
      provider: 'openai-compatible',
      raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    },
    { attemptId: 'b', provider: 'openai-compatible', raw: undefined }
  ]);

  assert.equal(breakdown.logicalInputTokens, 10);
  assert.equal(breakdown.unknownAttempts, 1);
  assert.equal(breakdown.reportedAttempts, 1);
});

test('private cache keys carry session, work item and role scope', () => {
  const key = derivedCacheKey({
    layer: 'context_bundle',
    scope: {
      kind: 'private',
      sessionId: 'session-a',
      workItemId: 'wi-1',
      agentId: 'agent-1',
      generation: 3
    },
    dependencyFingerprint: 'fp-1'
  });

  assert.match(key, /session-a/);
  assert.match(key, /wi-1/);
  assert.match(key, /agent-1/);
  assert.match(key, /cache-contract-v1/);
});

test('a private key from one session never matches another session or generation', () => {
  const base = {
    layer: 'context_bundle' as const,
    dependencyFingerprint: 'fp-1',
    scope: {
      kind: 'private' as const,
      sessionId: 'session-a',
      workItemId: 'wi-1',
      agentId: 'agent-1',
      generation: 3
    }
  };
  const keyA = derivedCacheKey(base);
  const keyOtherSession = derivedCacheKey({ ...base, scope: { ...base.scope, sessionId: 'session-b' } });
  const keyOtherGeneration = derivedCacheKey({ ...base, scope: { ...base.scope, generation: 4 } });

  assert.notEqual(keyA, keyOtherSession, 'two sessions of the same agent must not share cached content');
  assert.notEqual(keyA, keyOtherGeneration, 'a recovered session must not reuse pre-recovery entries');

  assert.equal(isCacheKeyScopedTo(keyA, { sessionId: 'session-a', generation: 3 }), true);
  assert.equal(isCacheKeyScopedTo(keyA, { sessionId: 'session-b', generation: 3 }), false);
  assert.equal(isCacheKeyScopedTo(keyA, { sessionId: 'session-a', generation: 4 }), false);
});

test('shared keys carry no session identity', () => {
  const key = derivedCacheKey({
    layer: 'role_template',
    scope: { kind: 'shared', templateId: 'reviewer-v2' },
    dependencyFingerprint: 'fp-tools'
  });

  assert.match(key, /reviewer-v2/);
  assert.doesNotMatch(key, /session/);
  assert.equal(isCacheKeyScopedTo(key, { sessionId: 'session-a', generation: 1 }), false);
});

test('dependency fingerprint changes with real business inputs', () => {
  const base = {
    workItemRevision: 4,
    decisionLedgerRevision: 9,
    fileHashes: { 'src/a.ts': 'hash-a' },
    toolCatalogVersion: 'tools-1',
    policyVersion: 'policy-1',
    modelConfigVersion: 'model-1'
  };
  const baseline = cacheDependencyFingerprint(base);

  for (const changed of [
    { ...base, workItemRevision: 5 },
    { ...base, decisionLedgerRevision: 10 },
    { ...base, fileHashes: { 'src/a.ts': 'hash-b' } },
    { ...base, toolCatalogVersion: 'tools-2' },
    { ...base, policyVersion: 'policy-2' },
    { ...base, modelConfigVersion: 'model-2' }
  ]) {
    assert.notEqual(cacheDependencyFingerprint(changed), baseline);
  }
});

test('unrelated progress activity does not change the fingerprint', () => {
  const base = {
    workItemRevision: 4,
    decisionLedgerRevision: 9,
    fileHashes: { 'src/a.ts': 'hash-a' },
    toolCatalogVersion: 'tools-1',
    policyVersion: 'policy-1',
    modelConfigVersion: 'model-1'
  };

  // Heartbeats and streaming progress are deliberately not fingerprint inputs:
  // if they were, every token of output would invalidate the whole cache layer.
  assert.equal(
    cacheDependencyFingerprint({ ...base, lastHeartbeatAt: '2026-09-19T00:00:00.000Z' } as typeof base),
    cacheDependencyFingerprint(base)
  );
});

test('file hash order does not change the fingerprint', () => {
  const a = cacheDependencyFingerprint({
    workItemRevision: 1,
    decisionLedgerRevision: 1,
    fileHashes: { 'src/a.ts': 'h1', 'src/b.ts': 'h2' },
    toolCatalogVersion: 't',
    policyVersion: 'p',
    modelConfigVersion: 'm'
  });
  const b = cacheDependencyFingerprint({
    workItemRevision: 1,
    decisionLedgerRevision: 1,
    fileHashes: { 'src/b.ts': 'h2', 'src/a.ts': 'h1' },
    toolCatalogVersion: 't',
    policyVersion: 'p',
    modelConfigVersion: 'm'
  });

  assert.equal(a, b);
});

test('normalized usage never carries prompt text', () => {
  const normalized = normalizeRuntimeUsage({
    provider: 'anthropic-compatible',
    raw: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } satisfies RuntimeUsage
  });

  assert.equal(
    JSON.stringify(normalized).includes('prompt'),
    false,
    'usage diagnostics must stay free of request bodies'
  );
});
