import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheDependencyFingerprint, derivedCacheKey } from '@agent-cluster/shared';
import { DerivedCache } from './derived-cache.js';

const DEPENDENCIES = {
  workItemRevision: 1,
  decisionLedgerRevision: 1,
  fileHashes: { 'src/a.ts': 'hash-a' },
  toolCatalogVersion: 'tools-1',
  policyVersion: 'policy-1',
  modelConfigVersion: 'model-1'
};

function keyFor(overrides: Partial<Parameters<typeof derivedCacheKey>[0]['scope'] & object> = {}) {
  return derivedCacheKey({
    layer: 'context_bundle',
    scope: {
      kind: 'private',
      sessionId: 'session-a',
      workItemId: 'wi-1',
      agentId: 'agent-1',
      generation: 1,
      ...overrides
    } as never,
    dependencyFingerprint: cacheDependencyFingerprint(DEPENDENCIES)
  });
}

test('a value written under a key is readable under the same key', () => {
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 60_000 });
  cache.set(keyFor(), 'bundle', { sessionId: 'session-a', generation: 1 });

  assert.equal(cache.get(keyFor(), { sessionId: 'session-a', generation: 1 }), 'bundle');
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);
});

test('a read from another session misses even when the key is known', () => {
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 60_000 });
  const key = keyFor();
  cache.set(key, 'bundle', { sessionId: 'session-a', generation: 1 });

  // Session B presenting session A's key must not receive A's content: this is
  // the cross-session leak AC2 forbids, and the key alone is not authority.
  assert.equal(cache.get(key, { sessionId: 'session-b', generation: 1 }), undefined);
  assert.equal(cache.stats().misses, 1);
});

test('a read after recovery misses entries built under the old generation', () => {
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 60_000 });
  cache.set(keyFor(), 'stale', { sessionId: 'session-a', generation: 1 });

  assert.equal(cache.get(keyFor(), { sessionId: 'session-a', generation: 2 }), undefined);
});

test('expired entries are misses and are evicted on read', () => {
  let now = 1_000;
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 500, now: () => now });
  cache.set(keyFor(), 'bundle', { sessionId: 'session-a', generation: 1 });

  now = 1_400;
  assert.equal(cache.get(keyFor(), { sessionId: 'session-a', generation: 1 }), 'bundle');

  now = 1_600;
  assert.equal(cache.get(keyFor(), { sessionId: 'session-a', generation: 1 }), undefined);
  assert.equal(cache.stats().size, 0, 'an expired entry should not keep occupying capacity');
});

test('capacity is bounded and evicts least recently used', () => {
  const cache = new DerivedCache<string>({ maxEntries: 2, ttlMs: 60_000 });
  const scope = { sessionId: 'session-a', generation: 1 };
  const keyA = keyFor({ workItemId: 'wi-a' });
  const keyB = keyFor({ workItemId: 'wi-b' });
  const keyC = keyFor({ workItemId: 'wi-c' });

  cache.set(keyA, 'a', scope);
  cache.set(keyB, 'b', scope);
  cache.get(keyA, scope); // A is now the most recently used
  cache.set(keyC, 'c', scope);

  assert.equal(cache.stats().size, 2, 'capacity must stay bounded');
  assert.equal(cache.get(keyB, scope), undefined, 'B was least recently used');
  assert.equal(cache.get(keyA, scope), 'a');
  assert.equal(cache.get(keyC, scope), 'c');
  assert.equal(cache.stats().evictions, 1);
});

test('invalidating a session drops only that session', () => {
  const cache = new DerivedCache<string>({ maxEntries: 8, ttlMs: 60_000 });
  const keyA = keyFor({ sessionId: 'session-a' });
  const keyB = keyFor({ sessionId: 'session-b' });
  cache.set(keyA, 'a', { sessionId: 'session-a', generation: 1 });
  cache.set(keyB, 'b', { sessionId: 'session-b', generation: 1 });

  cache.invalidateSession('session-a');

  assert.equal(cache.get(keyA, { sessionId: 'session-a', generation: 1 }), undefined);
  assert.equal(cache.get(keyB, { sessionId: 'session-b', generation: 1 }), 'b', 'sibling session is untouched');
});

test('a backfill that lost its scope is rejected rather than written', () => {
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 60_000 });
  const key = keyFor();

  // The build started before the session was deleted; by the time it finished the
  // session is gone. Writing it now would resurrect content for a dead session.
  const accepted = cache.set(key, 'late', { sessionId: 'session-b', generation: 1 });

  assert.equal(accepted, false);
  assert.equal(cache.stats().size, 0);
  assert.equal(cache.stats().rejectedBackfills, 1);
});

test('stats never expose cached content', () => {
  const cache = new DerivedCache<string>({ maxEntries: 4, ttlMs: 60_000 });
  cache.set(keyFor(), 'secret-bundle-text', { sessionId: 'session-a', generation: 1 });

  assert.equal(JSON.stringify(cache.stats()).includes('secret-bundle-text'), false);
});
