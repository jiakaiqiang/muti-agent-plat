import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRoutingInput, WorkspaceCapabilities } from '@agent-cluster/shared';
import { resolveExecutionTarget } from './resolve-execution-target.js';

function buildInput(overrides: Partial<RuntimeRoutingInput> = {}): RuntimeRoutingInput {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: true, test: false };
  return {
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000084',
    taskKind: 'implementation',
    agentId: 'agent-implementer',
    requiredCapabilities: ['read', 'write'],
    writeMode: 'propose_changes',
    workspace: { workspaceId: 'ws-84', providerKind: 'server_local', capabilities },
    ...overrides
  };
}

test('resolveExecutionTarget prioritizes user override when eligible', () => {
  const target = resolveExecutionTarget({
    input: buildInput({
      userOverride: { runtimeType: 'codex', modelId: 'codex-5', source: 'user' }
    }),
    eligibleRuntimes: ['codex', 'claude_code']
  });
  assert.equal(target.runtimeType, 'codex');
  assert.equal(target.source, 'task_override');
  assert.equal(target.modelId, 'codex-5');
});

test('resolveExecutionTarget falls through to agent preferred runtime when override missing', () => {
  const target = resolveExecutionTarget({
    input: buildInput({ agentPreferredRuntime: 'claude_code' }),
    eligibleRuntimes: ['codex', 'claude_code']
  });
  assert.equal(target.runtimeType, 'claude_code');
  assert.equal(target.source, 'session_preference');
});

test('resolveExecutionTarget uses project policy runtime when agent preference not eligible', () => {
  const target = resolveExecutionTarget({
    input: buildInput({ agentPreferredRuntime: 'human' }),
    eligibleRuntimes: ['codex', 'claude_code'],
    projectPolicyRuntime: 'codex'
  });
  assert.equal(target.runtimeType, 'codex');
  assert.equal(target.source, 'project_policy');
});

test('resolveExecutionTarget uses smart router pick when eligible and no higher priority applies', () => {
  const target = resolveExecutionTarget({
    input: buildInput(),
    eligibleRuntimes: ['codex', 'claude_code'],
    smartRouterPick: 'claude_code'
  });
  assert.equal(target.runtimeType, 'claude_code');
  assert.equal(target.source, 'smart_router');
});

test('resolveExecutionTarget falls back to global_default when no eligibles exist', () => {
  const target = resolveExecutionTarget({
    input: buildInput(),
    eligibleRuntimes: []
  });
  assert.equal(target.runtimeType, 'generic_llm');
  assert.equal(target.source, 'global_default');
});

test('resolveExecutionTarget always emits writeMode and requiredCapabilities from input', () => {
  const target = resolveExecutionTarget({
    input: buildInput({ writeMode: 'direct_audited', requiredCapabilities: ['read', 'write', 'command'] }),
    eligibleRuntimes: ['codex']
  });
  assert.equal(target.writeMode, 'direct_audited');
  assert.deepEqual(target.requiredCapabilities, ['read', 'write', 'command']);
});
