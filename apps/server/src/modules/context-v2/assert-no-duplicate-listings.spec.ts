import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2 } from '@agent-cluster/shared';
import {
  assertNoDuplicateFileListings,
  pruneDuplicatePathsFromProjectMap
} from './assert-no-duplicate-listings.js';

function envelope(overrides: Partial<ContextEnvelopeV2>): ContextEnvelopeV2 {
  const revision = { id: 'rev-78', observedAt: '2026-07-11T00:00:00.000Z' };
  const base: ContextEnvelopeV2 = {
    version: 'v2',
    createdAt: '2026-07-11T00:00:00.000Z',
    workspaceId: 'ws-78',
    sessionId: '00000000-0000-4000-8000-000000000078',
    L0: {
      systemRules: [],
      agentId: '00000000-0000-4000-8000-000000000078',
      profileHash: 'profile-78',
      profileRevision: 1,
      toolCatalogHash: 'catalog-78',
      workspace: { workspaceId: 'ws-78', rootName: 'demo', providerKind: 'server_local', revision }
    },
    L1: { sessionGoal: 'test', phase: 'task_execution', navigation: { entries: [], truncated: false } },
    L2: { source: 'generated', modules: [] },
    L3: { files: [], totalByteLength: 0, truncated: false },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 8000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3600 }
  };
  return { ...base, ...overrides };
}

test('assertNoDuplicateFileListings flags overlap between Manifest and ProjectMap entrypoints/tests', () => {
  const env = envelope({
    L1: { sessionGoal: 'test', phase: 'task_execution', navigation: {
      entries: [
        { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 10 },
        { path: 'src/util.spec.ts', kind: 'file', generated: false, sensitive: false, size: 10 }
      ],
      truncated: false
    } },
    L2: {
      source: 'generated',
      modules: [{
        name: 'src',
        path: 'src',
        responsibility: 'source',
        entrypoints: ['src/index.ts'],
        tests: ['src/util.spec.ts']
      }]
    }
  });
  const report = assertNoDuplicateFileListings(env);
  assert.equal(report.hasDuplicates, true);
  assert.deepEqual(report.duplicatedPaths, ['src/index.ts', 'src/util.spec.ts']);
});

test('assertNoDuplicateFileListings flags overlap between Manifest and Evidence files', () => {
  const env = envelope({
    L1: { sessionGoal: 'test', phase: 'task_execution', navigation: {
      entries: [{ path: 'a.ts', kind: 'file', generated: false, sensitive: false, size: 5 }],
      truncated: false
    } },
    L3: {
      files: [{ path: 'a.ts', content: 'x', byteLength: 1 }],
      totalByteLength: 1,
      truncated: false
    }
  });
  const report = assertNoDuplicateFileListings(env);
  assert.equal(report.hasDuplicates, true);
  assert.deepEqual(report.duplicatedPaths, ['a.ts']);
});

test('assertNoDuplicateFileListings passes when only ProjectMap references paths not in Manifest', () => {
  const env = envelope({
    L1: { sessionGoal: 'test', phase: 'task_execution', navigation: {
      entries: [{ path: 'src', kind: 'directory', generated: false, sensitive: false }],
      truncated: false
    } },
    L2: {
      source: 'generated',
      modules: [{
        name: 'src',
        path: 'src',
        responsibility: 'source',
        entrypoints: ['src/index.ts']
      }]
    }
  });
  const report = assertNoDuplicateFileListings(env);
  assert.equal(report.hasDuplicates, false);
  assert.deepEqual(report.duplicatedPaths, []);
});

test('pruneDuplicatePathsFromProjectMap strips duplicated paths from ProjectMap while keeping Manifest intact', () => {
  const env = envelope({
    L1: { sessionGoal: 'test', phase: 'task_execution', navigation: {
      entries: [
        { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 10 }
      ],
      truncated: false
    } },
    L2: {
      source: 'generated',
      modules: [{
        name: 'src',
        path: 'src',
        responsibility: 'source',
        entrypoints: ['src/index.ts', 'src/other.ts'],
        tests: ['src/index.spec.ts']
      }]
    }
  });
  const pruned = pruneDuplicatePathsFromProjectMap(env);
  assert.deepEqual(pruned.L2.modules[0].entrypoints, ['src/other.ts']);
  assert.deepEqual(pruned.L2.modules[0].tests, ['src/index.spec.ts']);
  assert.deepEqual(pruned.L1.navigation.entries.map((entry) => entry.path), ['src/index.ts']);
  const afterReport = assertNoDuplicateFileListings(pruned);
  assert.equal(afterReport.hasDuplicates, false);
});
