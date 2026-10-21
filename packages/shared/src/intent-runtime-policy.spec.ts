import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvocationPlan } from './contracts.js';
import type { IntentEffectScope } from './intent-plan-contracts.js';
import { assertIntentInvocationScope, supportsIntentEffectScope, intentScopeToolNames } from './intent-runtime-policy.js';

const scope: IntentEffectScope = { effects: [{ kind: 'read_workspace', target: { kind: 'workspace', refId: 'workspace-1' },
  evidenceRefs: ['original-request'] }], prohibitions: [], grantIds: ['grant-1'], scopeHash: 'scope-hash' };

for (const phase of ['brief_generation', 'brief_revision']) test(`versioned ${phase} is bound and tool-free, never a workspace or CLI authorization`, () => {
  const plan = { admissionClass: 'business', phase, dataEpoch: 'epoch', intentStepId: 'brief-step', workItemId: 'work',
    effectScope: { effects: [], prohibitions: [], grantIds: [], scopeHash: 'empty' }, executionBinding: { effectScopeHash: 'empty' },
    expectedOutput: { kind: phase === 'brief_revision' ? 'agent_message' : 'task_brief', schemaVersion: '1.0' }, contextEnvelope: { workspaceId: 'workspace' },
    executionTarget: { runtimeType: 'generic_llm', writeMode: 'none', requiredCapabilities: [] }, toolCatalog: { tools: [] } } as unknown as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  for (const patch of [
    { admissionClass: 'response' }, { intentStepId: undefined }, { workItemId: undefined }, { taskId: 'task' },
    { resume: { cliSessionId: 'old' } }, { expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' } },
    { effectScope: { ...plan.effectScope!, effects: [{ kind: 'answer' }] } },
    { effectScope: { ...plan.effectScope!, grantIds: ['write-grant'] } },
    { toolCatalog: { tools: [{ name: 'read_file' }] } },
    { executionTarget: { ...plan.executionTarget, runtimeType: 'claude_code' } },
    { executionTarget: { ...plan.executionTarget, requiredCapabilities: ['read'] } },
    { executionTarget: { ...plan.executionTarget, writeMode: 'propose_changes' } }
  ]) assert.throws(() => assertIntentInvocationScope({ ...plan, ...patch } as InvocationPlan), /RESTRICTED_BRIEF_CAPABILITY_UNAVAILABLE/);
});

test('test reports bind to the same isolated runner without adding write or command tools', () => {
  const hash = 'a'.repeat(64);
  const report: IntentEffectScope = { effects: [
    { kind: 'write_artifact', target: { kind: 'artifact', refId: `test-report:${hash}` }, evidenceRefs: ['request'] },
    { kind: 'run_tests', target: { kind: 'test_runner', refId: `test-runner:${hash}` }, evidenceRefs: ['request'] }
  ], prohibitions: [], grantIds: ['test', 'report'], scopeHash: 'report' };
  assert.equal(supportsIntentEffectScope('test_runner', report, 'workspace'), true);
  assert.deepEqual(intentScopeToolNames(report), ['run_test']);
  for (const invalid of [
    { ...report, effects: [report.effects[0]] },
    { ...report, effects: [...report.effects, report.effects[0]] },
    { ...report, grantIds: [] },
    { ...report, effects: [report.effects[0], { ...report.effects[1], target: { kind: 'test_runner', refId: `test-report:${hash}` } }] },
    { ...report, effects: [{ ...report.effects[0], target: { kind: 'artifact', refId: `test-report:${'b'.repeat(64)}` } }, report.effects[1]] },
    { ...report, effects: [...report.effects, { kind: 'modify_source', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['request'] }] },
    { ...report, prohibitions: [{ effectKind: 'write_artifact', object: { kind: 'artifact', refId: null }, scope: 'message', evidenceRefs: ['ban'] }] }
  ] as IntentEffectScope[]) assert.equal(supportsIntentEffectScope('test_runner', invalid, 'workspace'), false);
  assert.equal(supportsIntentEffectScope('generic_llm', report, 'workspace'), false);
});

test('effect support rejects unsupported execution, wrong resource, and unresolved prohibition', () => {
  assert.equal(supportsIntentEffectScope('generic_llm', scope, 'workspace-1'), true);
  assert.equal(supportsIntentEffectScope('codex', scope, 'workspace-1'), false);
  assert.equal(supportsIntentEffectScope('generic_llm', scope, 'another-workspace'), false);
  assert.equal(supportsIntentEffectScope('generic_llm', { ...scope, grantIds: [] }, 'workspace-1'), false);
  assert.equal(supportsIntentEffectScope('generic_llm', { ...scope, prohibitions: [{ effectKind: 'read_workspace',
    object: { kind: 'source', refId: 'private' }, scope: 'message', evidenceRefs: ['ban'] }] }, 'workspace-1'), false);
});

test('runtime boundary rechecks catalog, source writes, and execution binding', () => {
  const plan = { effectScope: scope, executionTarget: { runtimeType: 'generic_llm', writeMode: 'none' },
    contextEnvelope: { workspaceId: 'workspace-1' }, toolCatalog: { tools: [{ name: 'read_file' }] } } as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  assert.throws(() => assertIntentInvocationScope({ ...plan, toolCatalog: { ...plan.toolCatalog, tools: [{ name: 'run_test', description: '', inputSchema: {} }] } }), /TOOL_SCOPE_MISMATCH/);
  assert.throws(() => assertIntentInvocationScope({ ...plan, executionTarget: { ...plan.executionTarget, writeMode: 'propose_changes' } }), /SOURCE_WRITE_NOT_AUTHORIZED/);
  assert.throws(() => assertIntentInvocationScope({ ...plan, executionBinding: { effectScopeHash: 'old' } as InvocationPlan['executionBinding'] }), /SCOPE_HASH_MISMATCH/);
  assert.throws(() => assertIntentInvocationScope({ ...plan, effectScope: undefined, executionBinding: { effectScopeHash: 'old' } as InvocationPlan['executionBinding'] }), /SCOPE_REQUIRED/);
});

test('restricted classification accepts no tools and does not treat a CLI sandbox as tool-free', () => {
  const plan = { admissionClass: 'routing', dataEpoch: 'epoch', phase: 'user_message_routing',
    expectedOutput: { kind: 'intent_routing_decision' },
    executionTarget: { runtimeType: 'generic_llm', writeMode: 'none', requiredCapabilities: [] },
    toolCatalog: { tools: [] } } as unknown as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  assert.throws(() => assertIntentInvocationScope({ ...plan, executionTarget: { ...plan.executionTarget, runtimeType: 'codex' } }), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertIntentInvocationScope({ ...plan, phase: 'task_execution' }), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => assertIntentInvocationScope({ ...plan, toolCatalog: { ...plan.toolCatalog, tools: [{ name: 'read_file', description: '', inputSchema: {} }] } }), /CAPABILITY_UNAVAILABLE/);
});

test('Claude classification is admitted only through the isolated server profile, never a legacy bridge', () => {
  const plan = { admissionClass: 'routing', dataEpoch: 'epoch', phase: 'user_message_routing',
    expectedOutput: { kind: 'intent_understanding', schemaVersion: '1.0' },
    executionTarget: { runtimeType: 'claude_code', workspaceProviderKind: 'server_local', writeMode: 'none', requiredCapabilities: [] },
    toolCatalog: { tools: [] } } as unknown as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  for (const patch of [{ executionTarget: { ...plan.executionTarget, workspaceProviderKind: 'local_bridge' } },
    { resume: {} }, { expectedOutput: { kind: 'intent_understanding', schemaVersion: '2.0' } }]) {
    assert.throws(() => assertIntentInvocationScope({ ...plan, ...patch } as InvocationPlan), /CAPABILITY_UNAVAILABLE/);
  }
});

test('restricted answer admission requires a plan-bound tool-free answer with no task execution', () => {
  const plan = { admissionClass: 'response', intentStepId: 'step', dataEpoch: 'epoch', phase: 'user_message_response',
    executionBinding: { effectScopeHash: 'answer-scope' }, expectedOutput: { kind: 'agent_message' },
    effectScope: { effects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }],
      prohibitions: [], grantIds: [], scopeHash: 'answer-scope' }, contextEnvelope: { workspaceId: 'workspace' },
    executionTarget: { runtimeType: 'generic_llm', writeMode: 'none', requiredCapabilities: [] }, toolCatalog: { tools: [] } } as unknown as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  for (const patch of [{ intentStepId: undefined }, { executionBinding: undefined }, { phase: 'task_execution' }, { taskId: 'task' },
    { effectScope: scope }, { executionTarget: { ...plan.executionTarget, runtimeType: 'codex' } },
    { toolCatalog: { ...plan.toolCatalog, tools: [{ name: 'read_file' }] } }]) {
    assert.throws(() => assertIntentInvocationScope({ ...plan, ...patch } as InvocationPlan), /RESTRICTED_RESPONSE_CAPABILITY_UNAVAILABLE/);
  }
});

test('a workspace answer admits read tools only with a bound server workspace scope', () => {
  const readScope = { ...scope, effects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }, ...scope.effects] };
  const plan = { admissionClass: 'response', intentStepId: 'step', dataEpoch: 'epoch', phase: 'user_message_response',
    executionBinding: { effectScopeHash: scope.scopeHash }, expectedOutput: { kind: 'agent_message' }, effectScope: readScope,
    contextEnvelope: { workspaceId: 'workspace-1' }, executionTarget: { runtimeType: 'generic_llm', writeMode: 'none',
      requiredCapabilities: ['read'], workspaceProviderKind: 'server_local' }, toolCatalog: { tools: [{ name: 'read_file' }, { name: 'search_code' }] } } as unknown as InvocationPlan;
  assert.doesNotThrow(() => assertIntentInvocationScope(plan));
  for (const patch of [{ toolCatalog: { ...plan.toolCatalog, tools: [] } },
    { executionTarget: { ...plan.executionTarget, workspaceProviderKind: 'local_bridge' } },
    { executionTarget: { ...plan.executionTarget, requiredCapabilities: ['read', 'command'] } },
    { effectScope: { ...plan.effectScope!, grantIds: [] } }]) {
    assert.throws(() => assertIntentInvocationScope({ ...plan, ...patch } as InvocationPlan), /CAPABILITY_UNAVAILABLE/);
  }
  assert.throws(() => assertIntentInvocationScope({ ...plan, toolCatalog: { ...plan.toolCatalog, tools: [...plan.toolCatalog.tools,
    { name: 'write_file', description: '', inputSchema: {} }] } }), /TOOL_SCOPE_MISMATCH/);
});
