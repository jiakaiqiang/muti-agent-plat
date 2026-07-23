import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ContextEnvelopeV2Budget,
  ContextL0Authority,
  ContextL1Invocation,
  ContextL3SelectedEvidence,
  ContextL4ToolResults,
  ContextL6DeliveryArtifacts
} from '@agent-cluster/shared';
import { buildContextEnvelopeV2 } from './context-assembly-builder-v2.js';

const l0: ContextL0Authority = {
  systemRules: ['Stay grounded.'],
  agentId: 'agent-77',
  profileHash: 'profile-77',
  profileRevision: 1,
  toolCatalogHash: 'catalog-77',
  workspace: {
    workspaceId: 'ws-77',
    rootName: 'demo',
    providerKind: 'server_local',
    revision: { id: 'rev-77', observedAt: '2026-07-11T00:00:00.000Z' }
  }
};

const l1: ContextL1Invocation = {
  sessionGoal: 'Implement the task',
  phase: 'task_execution',
  navigation: {
    entries: [{ path: 'src', kind: 'directory', generated: false, sensitive: false }],
    truncated: false
  }
};

const l3: ContextL3SelectedEvidence = {
  files: [{ path: 'src/index.ts', content: 'export {};', byteLength: 10 }],
  totalByteLength: 10,
  truncated: false
};

const l4: ContextL4ToolResults = {
  calls: [{ tool: 'listDirectory', arguments: { path: 'src' }, resultSummary: '1 entry' }]
};

const l6: ContextL6DeliveryArtifacts = {
  changeSetIds: ['00000000-0000-4000-8000-000000000077'],
  reportIds: []
};

const budget: ContextEnvelopeV2Budget = {
  inputTokens: 8000,
  navigationTokens: 800,
  projectMapTokens: 500,
  evidenceTokens: 3600
};

test('buildContextEnvelopeV2 assembles all authoritative layers for execution phase', () => {
  const envelope = buildContextEnvelopeV2({
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000000',
    l0,
    l1,
    l3,
    l4,
    budget
  });
  assert.equal(envelope.version, 'v2');
  assert.equal(envelope.workspaceId, l0.workspace.workspaceId);
  assert.deepEqual(envelope.L1.navigation.entries, l1.navigation.entries);
  assert.deepEqual(envelope.L3.files, l3.files);
  assert.deepEqual(envelope.L4.calls, l4.calls);
  assert.deepEqual(envelope.L6.changeSetIds, []);
});

test('buildContextEnvelopeV2 keeps discussion evidence and empties tool and delivery layers', () => {
  const envelope = buildContextEnvelopeV2({
    phase: 'discussion',
    sessionId: '00000000-0000-4000-8000-000000000001',
    l0,
    l1,
    l3,
    l4,
    l6,
    budget
  });
  assert.deepEqual(envelope.L3.files, l3.files);
  assert.equal(envelope.L4.calls.length, 0);
  assert.equal(envelope.L6.changeSetIds.length, 0);
  assert.deepEqual(envelope.L1.navigation.entries, l1.navigation.entries);
});

test('buildContextEnvelopeV2 exposes delivery artifacts in post_review phase', () => {
  const envelope = buildContextEnvelopeV2({
    phase: 'post_review',
    sessionId: '00000000-0000-4000-8000-000000000002',
    l0,
    l1,
    l3,
    l6,
    budget
  });
  assert.deepEqual(envelope.L3.files, l3.files);
  assert.deepEqual(envelope.L6.changeSetIds, l6.changeSetIds);
});

test('buildContextEnvelopeV2 keeps navigation and grounded evidence in delivery phase', () => {
  const envelope = buildContextEnvelopeV2({
    phase: 'delivery',
    sessionId: '00000000-0000-4000-8000-000000000003',
    l0,
    l1,
    l3,
    l4,
    l6,
    budget
  });
  assert.deepEqual(envelope.L1.navigation.entries, l1.navigation.entries);
  assert.deepEqual(envelope.L3.files, l3.files);
  assert.deepEqual(envelope.L4.calls, []);
  assert.deepEqual(envelope.L6.changeSetIds, l6.changeSetIds);
});
