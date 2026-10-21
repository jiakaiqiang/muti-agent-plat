import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedResumeState } from './intent-resume.fixture.js';
import { assertActiveIntentContinuation, assertNoPendingInputBudget, bindIntentResume } from './intent-resume-guard.js';
import { IntentResumeControlService } from './intent-resume-control.service.js';
import type { PersistedState } from '../persistence/persistence.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('R7 real File persistence stores resume receipts and preserves replay protection after reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-r7-resume-')), filePath = join(directory, 'state.json');
  const store = new PersistenceService({ backend: 'file', filePath }); await store.initialize();
  t.after(async () => { await store.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  for (const [key, value] of Object.entries(approvedResumeState())) await store.setCollection(key, value);
  let calls = 0;
  await new IntentResumeControlService(store).resume('session', 'user', async () => { calls++; });
  await assert.rejects(store.mutateCollections(['intentPlanStepsBySession'], draft => {
    (draft.intentPlanStepsBySession as any).session[0].resumeReceipts[0].binding.workItemId = 'forged';
  }, { sessionIds: ['session'] }), /INTENT_RESUME_RECEIPT_CONFLICT/);
  await assert.rejects(store.mutateCollections(['intentPlanStepsBySession'], draft => {
    (draft.intentPlanStepsBySession as any).session[0].resumeReceipts[0].status = 'running';
  }, { sessionIds: ['session'] }), /INTENT_RESUME_RECEIPT_CONFLICT/);
  const reload = new PersistenceService({ backend: 'file', filePath }); await reload.initialize(); t.after(() => reload.onModuleDestroy());
  await new IntentResumeControlService(reload).resume('session', 'user', async () => { calls++; });
  assert.equal(calls, 1);
});

test('R7 binds the original executable revision, not the empty resume message or Brief receipt', () => {
  const state = approvedResumeState(), binding = bindIntentResume(state, 'session', 'user');
  assert.equal(binding.routingId, 'original-route'); assert.equal(binding.tasks[0].operationId, 'original-operation');
  assert.equal(binding.briefVersion, 1); assert.equal(binding.pauseRevision, 1);
});

const cases: Array<[string, string, (state: any) => void]> = [
  ['actor', 'SESSION_UNAVAILABLE', state => { state.sessions[0].ownerId = 'other'; }],
  ['archive', 'SESSION_UNAVAILABLE', state => { state.sessions[0].archivedAt = 'archived'; }],
  ['state', 'STATE_INVALID', state => { state.sessions[0].status = 'FAILED'; }],
  ['paused discussion', 'STATE_INVALID', state => { state.sessions[0].pauseState.previousStatus = 'AGENT_DISCUSSING'; }],
  ['stop unconfirmed', 'STOP_UNCONFIRMED', state => { state.logicalOperationsBySession.session[0].stopState = 'unconfirmed'; }],
  ['stop target unknown', 'STOP_UNCONFIRMED', state => { state.sessionStopRequestsBySession = { session: [{ status: 'confirmed', targets: [{ state: 'unknown' }] }] }; }],
  ['active call', 'STOP_UNCONFIRMED', state => { state.logicalOperationsBySession.session[0].activeInvocationId = 'running'; }],
  ['generation', 'IDENTITY_STALE', state => { state.sessionLifecyclesBySession.session.generation++; }],
  ['dataEpoch', 'IDENTITY_STALE', state => { state.logicalOperationsBySession.session[0].dataEpoch = 'old'; }],
  ['missing generation', 'IDENTITY_STALE', state => { delete state.logicalOperationsBySession.session[0].sessionGeneration; }],
  ['intent revision', 'VERSION_STALE', state => { state.intentRoutingRecordsBySession.session[0].effectiveIntentRevision++; }],
  ['requirement revision', 'VERSION_STALE', state => { state.workItemsBySession.session[0].requirementRevision++; }],
  ['execution epoch', 'VERSION_STALE', state => { state.workItemsBySession.session[0].executionEpoch++; }],
  ['Brief version', 'VERSION_STALE', state => { state.briefsBySession.session[0].version++; }],
  ['cancelled WorkItem', 'TARGET_OBSOLETE', state => { state.workItemsBySession.session[0].status = 'CANCELLED'; }],
  ['cancelled task', 'TARGET_OBSOLETE', state => { state.tasksBySession.session[0].status = 'cancelled'; }],
  ['stale task', 'TARGET_OBSOLETE', state => { state.tasksBySession.session[0].stale = true; }],
  ['superseded Brief', 'TARGET_OBSOLETE', state => { state.briefsBySession.session.push({ id: 'replacement', supersedesBriefId: 'approved-brief' }); }],
  ['grant revoked', 'GRANT_STALE', state => { state.sessions[0].intentWorkspaceReadAuthority.grant.revokedAt = 'revoked'; }],
  ['grant changed', 'GRANT_STALE', state => { state.sessions[0].intentWorkspaceReadAuthority.grant.revision++; }],
  ['workspace rebound', 'GRANT_STALE', state => { state.sessions[0].workingDirectory.selectedAt = 'changed'; }],
  ['held target', 'INTENT_DISPATCH_HELD', state => { state.workItemsBySession.session[0].dispatchHold = { correctionId: 'held' }; }],
  ['scope changed', 'INTENT_EXECUTION_SCOPE_STALE', state => { state.intentPlanStepsBySession.session[0].step.effectScope.scopeHash = 'bad'; }],
  ['decision changed', 'INTENT_EXECUTION_DECISIONS_STALE', state => { state.intentPlanStepsBySession.session[0].step.executionBinding.decisionSetHash = 'bad';
    state.intentRouteRevisionsBySession.session[0].validatedPlan.steps[0].executionBinding.decisionSetHash = 'bad';
    state.logicalOperationsBySession.session[0].executionBinding.decisionSetHash = 'bad'; }],
  ['missing Brief', 'PLAN_MISSING', state => { state.briefsBySession.session = []; }],
  ['missing revision', 'PLAN_MISSING', state => { state.intentRouteRevisionsBySession.session = []; }],
  ['duplicate revision', 'PLAN_AMBIGUOUS', state => { state.intentRouteRevisionsBySession.session.push(structuredClone(state.intentRouteRevisionsBySession.session[0])); }],
  ['missing execution authority', 'AUTHORITY_UNPROVEN', state => { delete state.logicalOperationsBySession.session[0].executionBinding; }],
  ['Brief only', 'AUTHORITY_UNPROVEN', state => { state.logicalOperationsBySession.session = []; }],
  ['unknown authorization', 'AUTHORITY_UNPROVEN', state => { state.intentRouteRevisionsBySession.session[0].authorizationState = 'unknown'; }],
  ['preparation is not execution', 'AUTHORITY_UNPROVEN', state => { state.intentRouteRevisionsBySession.session[0].validatedPlan.steps[0].action = 'prepare_brief'; }]
];
for (const [name, code, mutate] of cases) test(`R7 guard blocks ${name}`, () => {
  const state = approvedResumeState(); mutate(state);
  const before = structuredClone(state);
  assert.throws(() => bindIntentResume(state, 'session', 'user'), new RegExp(code.startsWith('INTENT_') ? code : `INTENT_RESUME_${code}`));
  assert.deepEqual(state, before, 'guard is read-only');
});

test('R7 dispatch rechecks saved authority and rejects an intervening version, grant or task change', () => {
  for (const mutation of [cases[11][2], cases[18][2], cases[15][2]]) {
    const state = approvedResumeState(), binding = bindIntentResume(state, 'session', 'user');
    mutation(state); assert.throws(() => bindIntentResume(state, 'session', 'user', binding, true));
  }
});

test('R7 continuation requires activity of this WorkItem, not another task or a routing invocation', () => {
  const state: any = approvedResumeState(), session = state.sessions[0]; session.status = 'EXECUTING';
  assert.throws(() => assertActiveIntentContinuation(state, session, 'work'), /INTENT_CONTINUATION_NOT_ACTIVE/);
  state.tasksBySession.session[0].status = 'running';
  assert.doesNotThrow(() => assertActiveIntentContinuation(state, session, 'work'));
  state.tasksBySession.session[0].workItemId = 'other';
  assert.throws(() => assertActiveIntentContinuation(state, session, 'work'), /INTENT_CONTINUATION_NOT_ACTIVE/);
  Object.assign(state.logicalOperationsBySession.session[0], { status: 'running', activeInvocationId: 'call', stopState: 'none', admissionClass: 'routing' });
  assert.throws(() => assertActiveIntentContinuation(state, session, 'work'), /INTENT_CONTINUATION_NOT_ACTIVE/);
  state.tasksBySession.session[0].workItemId = 'work'; state.tasksBySession.session[0].status = 'assigned';
  state.logicalOperationsBySession.session[0].admissionClass = 'business';
  assert.doesNotThrow(() => assertActiveIntentContinuation(state, session, 'work'), 'an actual business invocation also proves activity');
});

test('R7 workflow binding fixes the current node and rejects generation, terminal and definition changes', () => {
  const state: any = approvedResumeState(); state.sessions[0].workflowRunId = 'run';
  state.workflowRuntime = { runs: [{ id: 'run', sessionId: 'session', workItemId: 'work', briefId: 'approved-brief',
    sessionGeneration: 1, status: 'running', currentNodeId: 'node', definitionSnapshot: { nodes: [{ id: 'node' }] } }],
    nodeRunsByRunId: { run: [{ id: 'node-run', nodeId: 'node', status: 'running', relatedTaskId: 'original-task' }] } };
  Object.assign(state.tasksBySession.session[0], { workflowRunId: 'run', workflowNodeId: 'node', workflowNodeRunId: 'node-run' });
  state.workflowRuntime.nodeRunsByRunId.run[0].workflowRunId = 'run';
  const binding = bindIntentResume(state, 'session', 'user'); assert.equal(binding.workflow?.nodeRunId, 'node-run');
  for (const property of ['workflowRunId', 'workflowNodeId', 'workflowNodeRunId']) {
    const changed = structuredClone(state); changed.tasksBySession.session[0][property] = 'another';
    assert.throws(() => bindIntentResume(changed, 'session', 'user'), /INTENT_RESUME_TARGET_OBSOLETE/);
  }
  const wrongNode = structuredClone(state); wrongNode.workflowRuntime.nodeRunsByRunId.run[0].workflowRunId = 'another';
  assert.throws(() => bindIntentResume(wrongNode, 'session', 'user'), /INTENT_RESUME_TARGET_OBSOLETE/);
  for (const [property, value, code] of [['sessionGeneration', 2, 'IDENTITY_STALE'], ['status', 'cancelled', 'TARGET_OBSOLETE'],
    ['definitionSnapshot', { nodes: [] }, 'VERSION_STALE']] as const) {
    const changed = structuredClone(state); changed.workflowRuntime.runs[0][property] = value;
    assert.throws(() => bindIntentResume(changed, 'session', 'user', binding), new RegExp(code));
  }
});

test('R7 budget hold wins even while paused or a failed workflow could otherwise be retried', () => {
  const state: any = approvedResumeState(), session = state.sessions[0];
  state.logicalOperationsBySession.session[0].inputBudgetDecisions = [{ status: 'pending', dataEpoch: 'epoch', sessionGeneration: 1 }];
  for (const status of ['PAUSED', 'WAIT_USER_DECISION', 'EXECUTING']) {
    session.status = status; const before = structuredClone(state);
    assert.throws(() => bindIntentResume(state, 'session', 'user'), /INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED/);
    assert.deepEqual(state, before);
  }
  delete session.intentContractVersion;
  assert.doesNotThrow(() => assertNoPendingInputBudget(state, session), 'legacy chain unchanged');
});

function memoryStore(state: PersistedState) {
  return { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback),
    async mutateCollections(_keys: string[], fn: (draft: PersistedState) => unknown) {
      const draft = structuredClone(state), result = fn(draft); Object.assign(state, draft); return result;
    } } as any;
}

test('R7 shared resume claims once across concurrent callers and a replay cannot redispatch', async () => {
  const state = approvedResumeState(), control = new IntentResumeControlService(memoryStore(state)); let calls = 0;
  const run = () => control.resume('session', 'user', async () => { calls++; });
  await Promise.all([run(), run()]); await run(); assert.equal(calls, 1);
});

test('R7 a process restart with an unknown resume delivery requires reconciliation and never calls the port', async () => {
  const state = approvedResumeState(), store = memoryStore(state), binding = bindIntentResume(state, 'session', 'user');
  (state.intentPlanStepsBySession as any).session[0].resumeReceipts = [{ pauseRevision: 1, status: 'running', processId: 'old-process', binding }];
  let calls = 0; const restarted = new IntentResumeControlService(store);
  await assert.rejects(restarted.resume('session', 'user', async () => { calls++; }), /INTENT_RESUME_RECONCILIATION_REQUIRED/);
  assert.equal(calls, 0); assert.equal((state.intentPlanStepsBySession as any).session[0].resumeReceipts[0].status, 'reconciliation_required');
});

test('R7 an interrupted port delivery is not automatically retried', async () => {
  const state = approvedResumeState(), control = new IntentResumeControlService(memoryStore(state)); let calls = 0;
  const invoke = async () => { calls++; throw new Error('delivery outcome unknown'); };
  await assert.rejects(control.resume('session', 'user', invoke), /delivery outcome unknown/);
  (state.sessions as any)[0].revision++;
  await assert.rejects(control.resume('session', 'user', invoke), /INTENT_RESUME_RECONCILIATION_REQUIRED/);
  assert.equal(calls, 1);
});
