import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIntentInvocationScope, intentScopeToolNames, supportsIntentEffectScope } from './intent-runtime-policy.js';
import { getRuntimeOutputContract, validateRuntimeOutput } from './runtime-contracts/registry.js';
import type { InvocationPlan } from './contracts.js';

const hash = 'a'.repeat(64);
const binding = { mode: 'candidate_only', authorityId: 'authority', authorityRevision: 1, authorityHash: hash,
  sourceResourceId: 'source:authority', grantId: 'source-grant', workspaceId: 'workspace', workspaceBindingHash: hash,
  sessionId: 'session', dataEpoch: 'epoch', sessionGeneration: 1, workItemId: 'work', taskId: 'task',
  intentStepId: 'step', invocationId: 'invocation', operationId: 'operation', effectScopeHash: hash };
const scope = { effects: [{ kind: 'modify_source', target: { kind: 'source', refId: binding.sourceResourceId }, evidenceRefs: ['request'] }],
  prohibitions: [], grantIds: [binding.grantId], scopeHash: hash };
function plan(): InvocationPlan {
  return { invocationId: 'invocation', sessionId: 'session', taskId: 'task', workItemId: 'work', intentStepId: 'step',
    admissionClass: 'business', phase: 'task_execution', dataEpoch: 'epoch', sourceCandidateBinding: structuredClone(binding),
    effectScope: structuredClone(scope), executionBinding: { effectScopeHash: hash, sessionGeneration: 1 },
    operation: { id: 'operation', sessionGeneration: 1 }, expectedOutput: { kind: 'intent_source_candidate', schemaVersion: '1.0' },
    executionTarget: { runtimeType: 'generic_llm', workspaceProviderKind: 'server_local', writeMode: 'none', requiredCapabilities: [] },
    contextEnvelope: { workspaceId: 'workspace', sessionId: 'session' }, toolCatalog: { tools: [] } } as unknown as InvocationPlan;
}

test('candidate contract accepts only update proposals, never model-supplied authority or base hashes', () => {
  const definition = getRuntimeOutputContract('intent_source_candidate' as never);
  const proposal = { schemaVersion: '1.0', kind: 'intent_source_candidate', summary: '补充校验', updates: [{ path: 'src/login.ts', content: 'export const ok = true;' }] };
  assert.equal(definition.validate(proposal).valid, true);
  for (const invalid of [ { ...proposal, candidateId: 'forged' }, { ...proposal, grantId: 'forged' },
    { ...proposal, updates: [] }, { ...proposal, updates: [{ ...proposal.updates[0], baseHash: hash }] },
    { ...proposal, updates: [{ path: 'src/login.ts', content: 'x', operation: 'delete' }] } ]) {
    assert.equal(validateRuntimeOutput('intent_source_candidate' as never, invalid).valid, false);
  }
});

test('source capability is opt-in generic candidate-only, missing descriptions retain the old denial', () => {
  const support = supportsIntentEffectScope as (...args: any[]) => boolean;
  assert.equal(support('generic_llm', scope, 'workspace', binding), true);
  assert.equal(support('generic_llm', scope, 'workspace'), false);
  for (const runtime of ['codex', 'claude_code', 'mock', 'test_runner', 'mcp_tool', 'human']) {
    assert.equal(support(runtime, scope, 'workspace', binding), false);
  }
  for (const patch of [{ mode: 'propose_changes' }, { authorityRevision: 0 }, { authorityHash: 'bad' },
    { workspaceId: 'other' }, { sourceResourceId: 'another-source' }, { grantId: 'missing' }, { effectScopeHash: 'old' }]) {
    assert.equal(support('generic_llm', scope, 'workspace', { ...binding, ...patch }), false);
  }
  assert.deepEqual((intentScopeToolNames as (...args: any[]) => string[])(scope, binding), []);
});

test('candidate boundary binds task, epoch, operation and mode; source permission adds no write or shell tools', () => {
  const original = plan();
  assert.doesNotThrow(() => assertIntentInvocationScope(original));
  for (const patch of [{ sourceCandidateBinding: undefined }, { phase: 'discussion' }, { admissionClass: 'routing' },
    { taskId: undefined }, { intentStepId: undefined }, { dataEpoch: 'old' }, { invocationId: 'other' },
    { operation: { id: 'different', sessionGeneration: 1 } }, { resume: {} },
    { executionTarget: { ...original.executionTarget, writeMode: 'propose_changes' } },
    { executionTarget: { ...original.executionTarget, workspaceProviderKind: 'local_bridge' } },
    { executionTarget: { ...original.executionTarget, requiredCapabilities: ['read', 'command'] } },
    { executionTarget: { ...original.executionTarget, runtimeType: 'codex' } },
    { toolCatalog: { tools: [{ name: 'write_file' }] } }, { toolCatalog: { tools: [{ name: 'read_attachment' }] } }
  ]) assert.throws(() => assertIntentInvocationScope({ ...original, ...patch } as InvocationPlan));
});
