import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugController } from './debug.controller.js';

function setup() {
  const invocation = {
    id: 'audit-1',
    invocationId: 'inv-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    agentKey: 'worker',
    runtimeType: 'codex',
    modelId: 'gpt-5',
    phase: 'task_execution',
    status: 'completed',
    executionTarget: {
      runtimeType: 'codex', source: 'smart_router', reason: 'eligible', requiredCapabilities: ['read'],
      requiredToolIds: ['cap-file-read'], writeMode: 'none', workspaceProviderKind: 'server_local'
    },
    toolCatalog: {
      tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }],
      decisions: [{ toolId: 'cap-file-read', toolKey: 'tool.file_read', status: 'allowed', reasons: ['granted'] }],
      catalogHash: 'catalog-hash'
    },
    contextEnvelope: {
      version: 'v2', createdAt: '2026-07-12T00:00:00.000Z', workspaceId: 'ws-1', sessionId: 'session-1',
      L0: { systemRules: [], agentId: 'agent-1', profileHash: 'profile-hash', profileRevision: 2,
        toolCatalogHash: 'catalog-hash', workspace: { workspaceId: 'ws-1', rootName: 'repo', providerKind: 'server_local',
          revision: { id: 'rev-1', observedAt: '2026-07-12T00:00:00.000Z' } } },
      L1: { sessionGoal: 'Implement', phase: 'task_execution', navigation: { entries: [], truncated: false } },
      L2: { source: 'generated', modules: [] }, L3: { files: [], totalByteLength: 0, truncated: false },
      L4: { calls: [] }, L5: { bullets: [], turnCount: 0 }, L6: { changeSetIds: [], reportIds: [] },
      budget: { inputTokens: 1000, navigationTokens: 100, projectMapTokens: 100, evidenceTokens: 400 }
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    outputContract: {
      contractId: 'runtime.output.task_execution_result', contractVersion: '1.0', schemaHash: 'fnv1a32:12345678'
    },
    budget: { maxInputTokens: 1000 },
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    profileSnapshot: { agentId: 'agent-1', profileHash: 'profile-hash', profileRevision: 2,
      resolvedSkillIds: [], resolvedSkillRevisions: {}, resolvedToolIds: ['cap-file-read'] },
    startedAt: '2026-07-12T00:00:00.000Z', completedAt: '2026-07-12T00:01:00.000Z'
  };
  const controller = new DebugController(
    { listBySession: () => [] } as never,
    { list: () => [] } as never,
    { listInvocations: () => [invocation] } as never,
    { get: () => ({ tokenBudget: 1000, tokenUsed: 120 }) } as never
  );
  return controller;
}

function data<T>(response: unknown): T {
  return (response as { data: T }).data;
}

test('context endpoint returns ContextEnvelopeV2', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().contextEnvelopes('session-1')).items[0]!;
  assert.equal((item.contextEnvelope as { version: string }).version, 'v2');
  assert.equal('contextAssembly' in item, false);
});

test('debug uses canonical invocationId instead of legacy runId', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().contextEnvelopes('session-1')).items[0]!;
  assert.equal(item.invocationId, 'inv-1');
  assert.equal('runId' in item, false);
});

test('runtime invocation exposes identity snapshot separately', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().runtimeInvocations('session-1')).items[0]!;
  assert.equal((item.identity as { profileHash: string }).profileHash, 'profile-hash');
});

test('runtime invocation exposes resolved execution target separately', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().runtimeInvocations('session-1')).items[0]!;
  assert.equal((item.executionTarget as { runtimeType: string }).runtimeType, 'codex');
});

test('runtime invocation exposes Tool Authority decisions and hash', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().runtimeInvocations('session-1')).items[0]!;
  assert.equal((item.toolCatalog as { catalogHash: string }).catalogHash, 'catalog-hash');
});

test('runtime invocation exposes the output contract audit identity', () => {
  const item = data<{ items: Array<Record<string, unknown>> }>(setup().runtimeInvocations('session-1')).items[0]!;
  assert.deepEqual(item.outputContract, {
    contractId: 'runtime.output.task_execution_result',
    contractVersion: '1.0',
    schemaHash: 'fnv1a32:12345678'
  });
});

test('runtime invocation summary counts navigation and evidence from Envelope', () => {
  const item = data<{ items: Array<{ summary: Record<string, unknown> }> }>(setup().runtimeInvocations('session-1')).items[0]!;
  assert.equal(item.summary.navigationCount, 0);
  assert.equal(item.summary.evidenceCount, 0);
});

test('token usage aggregates v2 invocation usage', () => {
  const result = data<{ totalTokens: number; byInvocation: Array<{ invocationId: string }> }>(setup().tokenUsage('session-1'));
  assert.equal(result.totalTokens, 120);
  assert.equal(result.byInvocation[0]?.invocationId, 'inv-1');
});

test('debug payload contains no legacy Runtime selection fields', () => {
  const payload = JSON.stringify(data(setup().runtimeInvocations('session-1')));
  assert.doesNotMatch(payload, /runtimeSelection|configuredRuntimeType|effectiveRuntimeType|contextAssembly/);
});
