import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentDefinition,
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  RuntimeType
} from '@agent-cluster/shared';
import {
  InvocationResolutionError,
  InvocationResolverService,
  type InvocationRuntimeCandidate,
  type ResolveInvocationInput
} from '../../apps/server/src/modules/runtime-routing/invocation-resolver.service.js';

const agent: AgentDefinition = {
  id: 'agent-audit',
  key: 'audit-agent',
  name: 'Audit Agent',
  role: 'Audit routing',
  profileMarkdown: '# Audit Agent',
  tags: [],
  status: 'active',
  capabilityIds: [],
  defaultKnowledgeBaseIds: [],
  profileRevision: 1,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z'
};

const identity: CompiledAgentIdentity = {
  agentId: agent.id,
  key: agent.key,
  name: agent.name,
  role: agent.role,
  systemPrompt: 'Audit routing.',
  profileHash: 'profile-hash',
  profileRevision: 1,
  skillBindings: [],
  requestedToolIds: [],
  requestedToolKeys: [],
  capabilityIds: [],
  knowledgeBaseIds: []
};

function candidate(runtimeType: RuntimeType, available = true): InvocationRuntimeCandidate {
  return {
    runtimeType,
    available,
    supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'],
    supportedToolNames: []
  };
}

function envelope(): ContextEnvelopeV2 {
  return {
    version: 'v2',
    createdAt: '2026-07-12T00:00:00.000Z',
    workspaceId: 'workspace-audit',
    sessionId: 'session-audit',
    L0: {
      systemRules: [],
      agentId: agent.id,
      profileHash: identity.profileHash,
      profileRevision: identity.profileRevision,
      toolCatalogHash: 'empty-catalog',
      workspace: {
        workspaceId: 'workspace-audit',
        rootName: 'repo',
        providerKind: 'server_local',
        revision: { id: 'revision-audit', observedAt: '2026-07-12T00:00:00.000Z' }
      }
    },
    L1: { sessionGoal: 'Audit routing', phase: 'task_execution', navigation: { entries: [], truncated: false } },
    L2: { source: 'static', modules: [] },
    L3: { files: [], totalByteLength: 0, truncated: false },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 0, navigationTokens: 0, projectMapTokens: 0, evidenceTokens: 0 }
  };
}

function setup(candidates: InvocationRuntimeCandidate[]) {
  return new InvocationResolverService(
    { compileIdentity: () => identity } as never,
    { resolve: () => ({ tools: [], decisions: [], catalogHash: 'empty-catalog' }) } as never,
    {
      listAll: () => candidates.filter((item) => item.available).map((item) => ({
        type: item.runtimeType,
        metadata: {
          name: item.runtimeType,
          version: '2.0.0',
          category: 'external',
          provider: 'audit',
          capabilityIds: [],
          supportedWorkspaceCapabilities: item.supportedWorkspaceCapabilities,
          supportedToolNames: item.supportedToolNames
        }
      }))
    } as never
  );
}

function resolve(
  overrides: Partial<ResolveInvocationInput> = {},
  candidates = [candidate('codex'), candidate('claude_code'), candidate('generic_llm')]
) {
  return setup(candidates).resolve({
    invocationId: crypto.randomUUID(),
    sessionId: 'session-audit',
    taskId: 'task-audit',
    taskKind: 'analysis',
    phase: 'task_execution',
    agent,
    taskRequiresCodeChanges: false,
    workspace: {
      workspaceId: 'workspace-audit',
      providerKind: 'server_local',
      capabilities: { read: true, write: true, command: true, test: true }
    },
    contextEnvelopeFactory: envelope,
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    budget: { maxInputTokens: 4096 },
    ...overrides
  });
}

test('eligible task override is selected and audited', () => {
  const target = resolve({ taskOverride: { runtimeType: 'codex', modelId: 'codex-audit' } }).executionTarget;
  assert.equal(target.source, 'task_override');
  assert.equal(target.modelId, 'codex-audit');
  assert.ok(target.reason.length > 10);
});

test('eligible session preference is selected and audited', () => {
  const target = resolve({ sessionPreference: { preferredRuntimeType: 'claude_code' } }).executionTarget;
  assert.equal(target.source, 'session_preference');
  assert.equal(target.runtimeType, 'claude_code');
});

test('project policy precedes smart routing', () => {
  const target = resolve({ projectPolicyRuntime: 'codex', smartRouterPick: 'claude_code' }).executionTarget;
  assert.equal(target.source, 'project_policy');
});

test('smart router precedes the global default', () => {
  const target = resolve({ smartRouterPick: 'claude_code', globalDefaultRuntime: 'codex' }).executionTarget;
  assert.equal(target.source, 'smart_router');
});

test('global default is audited when higher priorities are absent', () => {
  const target = resolve({ globalDefaultRuntime: 'generic_llm' }).executionTarget;
  assert.equal(target.source, 'global_default');
});

test('an unavailable high-priority target falls through to an eligible target', () => {
  const target = resolve({
    taskOverride: { runtimeType: 'codex' },
    globalDefaultRuntime: 'generic_llm'
  }, [candidate('codex', false), candidate('generic_llm')]).executionTarget;
  assert.equal(target.runtimeType, 'generic_llm');
  assert.equal(target.source, 'global_default');
});

test('session allowedRuntimeTypes constrains all selection strategies', () => {
  const target = resolve({
    sessionPreference: { allowedRuntimeTypes: ['codex'] },
    smartRouterPick: 'claude_code',
    globalDefaultRuntime: 'codex'
  }).executionTarget;
  assert.equal(target.runtimeType, 'codex');
});

test('routing fails closed when no Runtime is eligible', () => {
  assert.throws(
    () => resolve({}, []),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});
