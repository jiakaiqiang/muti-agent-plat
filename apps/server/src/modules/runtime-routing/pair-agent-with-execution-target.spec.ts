import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedExecutionTarget, RuntimeAgentProfile } from '@agent-cluster/shared';
import { pairAgentWithExecutionTarget } from './pair-agent-with-execution-target.js';

const baseAgent: RuntimeAgentProfile = {
  id: '00000000-0000-4000-8000-000000000085',
  key: 'agent.implementer',
  name: 'Implementer',
  role: 'implementer',
  systemPrompt: 'You are the implementer.',
  runtimeType: 'generic_llm',
  configuredRuntimeType: 'generic_llm',
  modelId: 'baseline-model',
  capabilityIds: ['00000000-0000-4000-8000-00000000cap1'],
  skillIds: ['00000000-0000-4000-8000-00000000skl1']
};

function target(runtimeType: ResolvedExecutionTarget['runtimeType'], modelId?: string): ResolvedExecutionTarget {
  return {
    runtimeType,
    ...(modelId ? { modelId } : {}),
    source: 'smart_router',
    requiredCapabilities: ['read', 'write'],
    writeMode: 'propose_changes'
  };
}

test('pairAgentWithExecutionTarget swaps runtime and optional model without mutating identity fields', () => {
  const swapped = pairAgentWithExecutionTarget(baseAgent, target('codex', 'codex-5'));
  assert.equal(swapped.runtimeType, 'codex');
  assert.equal(swapped.modelId, 'codex-5');
  assert.equal(swapped.role, baseAgent.role);
  assert.equal(swapped.name, baseAgent.name);
  assert.deepEqual(swapped.capabilityIds, baseAgent.capabilityIds);
  assert.deepEqual(swapped.skillIds, baseAgent.skillIds);
  assert.equal(swapped.systemPrompt, baseAgent.systemPrompt);
});

test('pairAgentWithExecutionTarget preserves the input object (no mutation)', () => {
  pairAgentWithExecutionTarget(baseAgent, target('claude_code'));
  assert.equal(baseAgent.runtimeType, 'generic_llm');
  assert.equal(baseAgent.modelId, 'baseline-model');
});

test('pairAgentWithExecutionTarget keeps agent modelId when target does not specify one', () => {
  const swapped = pairAgentWithExecutionTarget(baseAgent, target('claude_code'));
  assert.equal(swapped.runtimeType, 'claude_code');
  assert.equal(swapped.modelId, 'baseline-model');
});
