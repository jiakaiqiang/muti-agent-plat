import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ContextEnvelopeV2,
  ContextL1NavigationEntry,
  ContextL3EvidenceFile
} from '@agent-cluster/shared';
import { evaluateGroundedEvidenceGate } from './grounded-evidence-gate.js';

function makeEnvelope(
  manifest: ContextL1NavigationEntry[],
  evidence: ContextL3EvidenceFile[]
): ContextEnvelopeV2 {
  const revision = { id: 'rev-79', observedAt: '2026-07-11T00:00:00.000Z' };
  return {
    version: 'v2',
    createdAt: '2026-07-11T00:00:00.000Z',
    workspaceId: 'ws-79',
    sessionId: '00000000-0000-4000-8000-000000000079',
    L0: {
      systemRules: [],
      agentId: '00000000-0000-4000-8000-000000000079',
      profileHash: 'profile-79',
      profileRevision: 1,
      toolCatalogHash: 'catalog-79',
      workspace: { workspaceId: 'ws-79', rootName: 'demo', providerKind: 'server_local', revision }
    },
    L1: {
      sessionGoal: 'test',
      phase: 'task_execution',
      navigation: { entries: manifest, truncated: false }
    },
    L2: { source: 'generated', modules: [] },
    L3: {
      files: evidence,
      totalByteLength: evidence.reduce((sum, file) => sum + file.byteLength, 0),
      truncated: false
    },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 8000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3600 }
  };
}

test('gate returns ok:true when evidence is not required', () => {
  const envelope = makeEnvelope([], []);
  const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: false });
  assert.equal(decision.ok, true);
});

test('gate blocks with evidence-empty when required evidence is missing', () => {
  const envelope = makeEnvelope([], []);
  const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
  assert.deepEqual(decision, { ok: false, reason: 'evidence-empty' });
});

test('gate passes when non-generated non-sensitive evidence is present', () => {
  const envelope = makeEnvelope(
    [{ path: 'src/main.ts', kind: 'file', generated: false, sensitive: false, size: 10 }],
    [{ path: 'src/main.ts', content: 'export {}', byteLength: 10 }]
  );
  const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
  assert.equal(decision.ok, true);
});

test('gate blocks when only generated evidence is present', () => {
  const envelope = makeEnvelope(
    [{ path: 'dist/output.js', kind: 'file', generated: true, sensitive: false, size: 10 }],
    [{ path: 'dist/output.js', content: 'ok', byteLength: 2 }]
  );
  const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
  assert.deepEqual(decision, { ok: false, reason: 'evidence-only-generated' });
});

test('gate blocks when only sensitive evidence is present', () => {
  const envelope = makeEnvelope(
    [{ path: '.env', kind: 'file', generated: false, sensitive: true, size: 10 }],
    [{ path: '.env', content: 'SECRET=1', byteLength: 8 }]
  );
  const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
  assert.deepEqual(decision, { ok: false, reason: 'evidence-only-sensitive' });
});

test('gate blocks evidence that is absent from the safe navigation allowlist', () => {
  const envelope = makeEnvelope([], [{ path: '.env', content: 'SECRET=1', byteLength: 8 }]);
  assert.deepEqual(evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true }), {
    ok: false,
    reason: 'evidence-not-navigable'
  });
});
