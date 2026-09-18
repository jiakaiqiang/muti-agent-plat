import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompiledAgentIdentity, ContextAssembly, SessionDetail } from '@agent-cluster/shared';
import { buildEnvelopeFromContextAssembly } from './build-envelope-from-context-assembly.js';
import { ContextBundleCache } from './context-bundle-cache.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';

const REVISION = { id: 'rev-1', observedAt: '2026-09-18T00:00:00.000Z' };

function makeAssembly(overrides: Partial<ContextAssembly> = {}): ContextAssembly {
  return {
    systemRules: ['Stay grounded.'],
    sessionGoal: 'Inspect the repository',
    budget: { maxInputTokens: 10_000 },
    // With a provider index present, evidence is only admitted when its revision
    // matches the index revision — so the fixture has to carry one.
    selectedEvidenceContents: [
      {
        type: 'workspace_file',
        label: 'src/main.ts',
        ref: 'src/main.ts',
        source: 'workspace_file',
        content: 'export const main = true;',
        revision: REVISION
      }
    ],
    summaryMemory: {
      goal: 'inspect',
      currentState: 'running',
      confirmedFacts: [],
      completed: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      nextSteps: []
    },
    relevantEvents: [],
    artifacts: [],
    workItemId: 'wi-1',
    ...overrides
  } as unknown as ContextAssembly;
}

function makeSession(overrides: { id?: string; revisionId?: string } = {}): SessionDetail {
  const revisionId = overrides.revisionId ?? 'rev-1';
  return {
    id: overrides.id ?? 'session-a',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    workspaceIndex: {
      revision: { id: revisionId, observedAt: '2026-09-18T00:00:00.000Z' },
      generation: 1,
      status: 'ready',
      complete: true,
      entries: [
        { path: 'src', kind: 'directory' },
        { path: 'src/main.ts', kind: 'file', size: 25 },
        { path: 'src/util.ts', kind: 'file', size: 40 }
      ],
      entrypoints: ['src/main.ts'],
      detectedStack: ['typescript']
    }
  } as unknown as SessionDetail;
}

const identity: CompiledAgentIdentity = {
  agentId: 'agent-1',
  key: 'agent',
  name: 'Agent',
  role: 'worker',
  systemPrompt: 'Work.',
  profileHash: 'profile-hash',
  profileRevision: 1,
  skillBindings: [],
  requestedToolIds: [],
  requestedToolKeys: [],
  capabilityIds: [],
  knowledgeBaseIds: []
};

function build(input: {
  session: SessionDetail;
  assembly?: ContextAssembly;
  cache: ContextBundleCache;
  generation?: number;
}) {
  return buildEnvelopeFromContextAssembly({
    session: input.session,
    phase: 'task_execution',
    contextAssembly: input.assembly ?? makeAssembly(),
    identity,
    toolCatalogHash: 'catalog-hash',
    cache: { bundles: input.cache, generation: input.generation ?? 1 }
  });
}

test('a second build for the same session and revision reuses navigation and project map', () => {
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const session = makeSession();

  const first = build({ session, cache });
  const second = build({ session, cache });

  assert.deepEqual(second.L1.navigation, first.L1.navigation);
  assert.deepEqual(second.L2, first.L2);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 1);
});

test('a hit still carries the budget the runtime guard checks against', () => {
  // AC1: caching the bundle must not remove anything the pre-send budget check
  // depends on. The check itself runs downstream in the runtime; what matters
  // here is that a cached envelope is indistinguishable from a fresh one there.
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const session = makeSession();

  const fresh = build({ session, cache });
  const cached = build({ session, cache });

  assert.deepEqual(cached.budget, fresh.budget);
  assert.equal(cached.budget.inputTokens, 10_000);
});

test('per-call evidence is not served from the bundle cache', () => {
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const session = makeSession();

  build({ session, cache });
  const withDifferentEvidence = build({
    session,
    cache,
    assembly: makeAssembly({
      selectedEvidenceContents: [
        {
          type: 'workspace_file',
          label: 'src/util.ts',
          ref: 'src/util.ts',
          source: 'workspace_file',
          content: 'export const util = 1;',
          revision: REVISION
        }
      ]
    } as Partial<ContextAssembly>)
  });

  // Navigation came from the cache; evidence must reflect this call's selection.
  assert.equal(cache.stats().hits, 1);
  assert.equal(withDifferentEvidence.L3.files[0]?.path, 'src/util.ts');
});

test('a changed workspace revision misses instead of serving the old map', () => {
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });

  build({ session: makeSession({ revisionId: 'rev-1' }), cache });
  build({ session: makeSession({ revisionId: 'rev-2' }), cache });

  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().misses, 2);
});

test('another session with the same revision does not share the bundle', () => {
  // AC2: the key carries the session, so identical workspaces in two sessions are
  // still two entries. Sharing here would leak one session's navigation into
  // another even though the content happens to be equal today.
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });

  build({ session: makeSession({ id: 'session-a' }), cache });
  build({ session: makeSession({ id: 'session-b' }), cache });

  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().size, 2);
});

test('a recovered session at a new generation does not reuse the old bundle', () => {
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const session = makeSession();

  build({ session, cache, generation: 1 });
  build({ session, cache, generation: 2 });

  assert.equal(cache.stats().hits, 0);
});

test('invalidating a session drops its bundles and leaves other sessions alone', () => {
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  build({ session: makeSession({ id: 'session-a' }), cache });
  build({ session: makeSession({ id: 'session-b' }), cache });

  cache.invalidateSession('session-a');

  assert.equal(cache.stats().size, 1);
  build({ session: makeSession({ id: 'session-b' }), cache });
  assert.equal(cache.stats().hits, 1, 'session-b bundle survived the other session\'s invalidation');
});

test('building without a cache argument behaves exactly as before', () => {
  const session = makeSession();
  const uncached = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly: makeAssembly(),
    identity,
    toolCatalogHash: 'catalog-hash'
  });
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const cached = build({ session, cache });

  assert.deepEqual(cached.L1.navigation, uncached.L1.navigation);
  assert.deepEqual(cached.L2, uncached.L2);
});

test('cache outcomes are observable as low-cardinality metrics', () => {
  const before = seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'hit' });
  const beforeMiss = seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'miss' });
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 60_000 });
  const session = makeSession({ id: 'session-metrics' });

  build({ session, cache });
  build({ session, cache });

  assert.equal(seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'miss' }), beforeMiss + 1);
  assert.equal(seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'hit' }), before + 1);

  // Session ids are high-cardinality and belong in traces, never in metric
  // labels: one series per session would grow without bound.
  const labelled = workspaceMetrics.snapshot().series.filter((series) => series.name === 'context_bundle_cache_total');
  for (const series of labelled) {
    assert.equal('sessionId' in series.labels, false);
    assert.equal(JSON.stringify(series.labels).includes('session-metrics'), false);
  }
});

test('expiry is reported as its own outcome', () => {
  let now = 1_000;
  const before = seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'expired' });
  const cache = new ContextBundleCache({ maxEntries: 8, ttlMs: 500, now: () => now });
  const session = makeSession({ id: 'session-expiry' });

  build({ session, cache });
  now = 2_000;
  build({ session, cache });

  assert.equal(seriesValue('context_bundle_cache_total', { layer: 'file_index', outcome: 'expired' }), before + 1);
});

function seriesValue(name: string, labels: Record<string, string>): number {
  const match = workspaceMetrics
    .snapshot()
    .series.find(
      (series) =>
        series.name === name &&
        Object.entries(labels).every(([key, value]) => series.labels[key] === value)
    );
  return match?.value ?? 0;
}
