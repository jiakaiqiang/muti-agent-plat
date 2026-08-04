import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2 } from '@agent-cluster/shared';
import { presentContextEnvelopeV2Debug } from './context-debug-presenter.js';

const revision = { id: 'rev-80', observedAt: '2026-07-11T00:00:00.000Z' };

function baseEnvelope(): ContextEnvelopeV2 {
  return {
    version: 'v2',
    createdAt: '2026-07-11T00:00:00.000Z',
    workspaceId: 'ws-80',
    sessionId: '00000000-0000-4000-8000-000000000080',
    L0: {
      systemRules: [],
      agentId: '00000000-0000-4000-8000-000000000080',
      profileHash: 'profile-80',
      profileRevision: 1,
      toolCatalogHash: 'catalog-80',
      workspace: { workspaceId: 'ws-80', rootName: 'demo', providerKind: 'server_local', revision }
    },
    L1: {
      sessionGoal: 'test',
      phase: 'task_execution',
      navigation: {
        entries: [
          { path: 'src', kind: 'directory', generated: false, sensitive: false },
          { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 10 }
        ],
        truncated: false
      }
    },
    L2: {
      source: 'generated',
      modules: [{ name: 'src', path: 'src', responsibility: 'source' }]
    },
    L3: {
      files: [{ path: 'src/index.ts', content: 'export {}', byteLength: 10 }],
      totalByteLength: 10,
      truncated: false
    },
    L4: {
      calls: [{ tool: 'listDirectory', arguments: { path: 'src' }, resultSummary: '2 entries' }]
    },
    L5: { bullets: ['bullet-a'], turnCount: 3 },
    L6: { changeSetIds: ['00000000-0000-4000-8000-000000000080'], reportIds: [] },
    budget: { inputTokens: 8000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3600 }
  };
}

test('presentContextEnvelopeV2Debug returns a summary for each layer L0..L6', () => {
  const snap = presentContextEnvelopeV2Debug(baseEnvelope());
  const layerNames = snap.layers.map((l) => l.layer);
  assert.deepEqual(layerNames, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
});

test('presentContextEnvelopeV2Debug reflects item counts and evidence byte length', () => {
  const snap = presentContextEnvelopeV2Debug(baseEnvelope());
  const l1 = snap.layers.find((l) => l.layer === 'L1');
  const l3 = snap.layers.find((l) => l.layer === 'L3');
  assert.equal(l1?.itemCount, 2);
  assert.equal(l3?.itemCount, 1);
  assert.equal(l3?.approxByteLength, 10);
  assert.equal(l3?.approxTokens, Math.ceil(10 / 4));
});

test('presentContextEnvelopeV2Debug surfaces truncation as a dropped reason', () => {
  const env = baseEnvelope();
  env.L3.truncated = true;
  env.L1.navigation.truncated = true;
  const snap = presentContextEnvelopeV2Debug(env);
  assert.deepEqual(snap.droppedReasons, ['L1 navigation truncated', 'L3 evidence truncated']);
  assert.equal(snap.layers.find((l) => l.layer === 'L1')?.truncated, true);
});

test('presentContextEnvelopeV2Debug includes budget and usage for L1, L2, L3', () => {
  const snap = presentContextEnvelopeV2Debug(baseEnvelope());
  const l1 = snap.layers.find((l) => l.layer === 'L1');
  const l2 = snap.layers.find((l) => l.layer === 'L2');
  const l3 = snap.layers.find((l) => l.layer === 'L3');
  assert.equal(l1?.budgetTokens, 800);
  assert.ok(l1?.usedTokens !== undefined);
  assert.equal(l2?.budgetTokens, 500);
  assert.ok(l2?.usedTokens !== undefined);
  assert.equal(l3?.budgetTokens, 3600);
  assert.ok(l3?.usedTokens !== undefined);
});
