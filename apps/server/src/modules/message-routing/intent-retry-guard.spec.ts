import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { approvedRetryState } from './intent-retry.fixture.js';
import { bindIntentRetry, captureIntentRetryBinding, assertIntentRetryRuntimeSafe,
  claimIntentRetryExecution, settleIntentRetryExecution } from './intent-retry-guard.js';
import { IntentResumeControlService } from './intent-resume-control.service.js';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';

const cases: Array<[string, string, (state: any) => void]> = [
  ['missing binding', 'RETRY_CHECKPOINT_REQUIRED', s => { delete s.sessions[0].activeRecoveryCheckpoint.retryBinding; }],
  ['duplicate failure log', 'INTENT_RETRY_CHECKPOINT_AMBIGUOUS', s => { s.runtimeInvocationsBySession.session.push(structuredClone(s.runtimeInvocationsBySession.session[0])); }],
  ['wrong failure call', 'INTENT_RETRY_CHECKPOINT_STALE', s => { s.sessions[0].activeRecoveryCheckpoint.retryBinding.failure.invocationId = 'missing'; }],
  ['old generation', 'INTENT_RESUME_IDENTITY_STALE', s => { s.sessionLifecyclesBySession.session.generation++; }],
  ['old epoch', 'INTENT_RETRY_CHECKPOINT_STALE', s => { s.sessions[0].dataEpoch = 'another'; }],
  ['later attempt', 'INTENT_RETRY_CHECKPOINT_STALE', s => { s.logicalOperationsBySession.session[0].invocationIds.push('later'); }],
  ['unknown operation stop', 'INTENT_RETRY_RECONCILIATION_REQUIRED', s => { s.logicalOperationsBySession.session[0].status = 'interrupted'; }],
  ['exhausted original attempts', 'INTENT_RETRY_OPERATION_BUDGET_EXHAUSTED', s => { Object.assign(s.logicalOperationsBySession.session[0], { attemptsUsed: 2, maxAttempts: 2 }); }],
  ['cancelled task', 'INTENT_RETRY_TARGET_OBSOLETE', s => { s.tasksBySession.session[0].status = 'cancelled'; }],
  ['completed task', 'INTENT_RETRY_TARGET_OBSOLETE', s => { s.tasksBySession.session[0].status = 'completed'; }],
  ['stale task', 'INTENT_RETRY_TARGET_OBSOLETE', s => { s.tasksBySession.session[0].stale = true; }],
  ['cancelled work', 'INTENT_RESUME_TARGET_OBSOLETE', s => { s.workItemsBySession.session[0].status = 'CANCELLED'; }],
  ['archive', 'INTENT_RESUME_SESSION_UNAVAILABLE', s => { s.sessions[0].archivedAt = 'now'; }],
  ['wrong actor', 'INTENT_RESUME_SESSION_UNAVAILABLE', s => { s.sessions[0].ownerId = 'other'; }],
  ['unconfirmed stop', 'INTENT_RESUME_STOP_UNCONFIRMED', s => { s.logicalOperationsBySession.session[0].stopState = 'unconfirmed'; }],
  ['active call', 'INTENT_RESUME_STOP_UNCONFIRMED', s => { s.logicalOperationsBySession.session[0].activeInvocationId = 'live'; }],
  ['intent revision changed', 'INTENT_RESUME_VERSION_STALE', s => { s.intentRoutingRecordsBySession.session[0].effectiveIntentRevision++; }],
  ['requirement changed', 'INTENT_RESUME_VERSION_STALE', s => { s.workItemsBySession.session[0].requirementRevision++; }],
  ['execution epoch changed', 'INTENT_RESUME_VERSION_STALE', s => { s.workItemsBySession.session[0].executionEpoch++; }],
  ['Brief superseded', 'INTENT_RESUME_TARGET_OBSOLETE', s => { s.briefsBySession.session.push({ id: 'new', supersedesBriefId: 'approved-brief' }); }],
  ['revoked grant', 'INTENT_RESUME_GRANT_STALE', s => { s.sessions[0].intentWorkspaceReadAuthority.grant.revokedAt = 'now'; }],
  ['authority absent', 'INTENT_RESUME_AUTHORITY_UNPROVEN', s => { s.intentRouteRevisionsBySession.session[0].authorizationState = 'unknown'; }],
  ['dispatch hold', 'INTENT_DISPATCH_HELD', s => { s.workItemsBySession.session[0].dispatchHold = { correctionId: 'held' }; }],
  ['original step invalidated', 'INTENT_EXECUTION_SCOPE_STALE', s => { s.intentPlanStepsBySession.session[0].status = 'invalidated'; }],
  ['budget hold', 'INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED', s => { s.logicalOperationsBySession.session[0].inputBudgetDecisions = [{ status: 'pending', dataEpoch: 'epoch', sessionGeneration: 1 }]; }],
  ['budget failure', 'INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED', s => { s.runtimeInvocationsBySession.session[0].error.code = 'INPUT_BUDGET_EXCEEDED'; }]
];
for (const [name, code, mutate] of cases) test(`R8 retry blocks ${name} without mutation`, () => {
  const state: any = approvedRetryState(); mutate(state); const before = structuredClone(state);
  assert.throws(() => bindIntentRetry(state, 'session', 'user'), new RegExp(code)); assert.deepEqual(state, before);
});

test('R8 checkpoint is captured from the exact failed task and original executable authority', () => {
  const state: any = approvedRetryState();
  const saved = state.sessions[0].activeRecoveryCheckpoint.retryBinding;
  assert.deepEqual(bindIntentRetry(state, 'session', 'user'), saved);
  assert.deepEqual(captureIntentRetryBinding(state, 'session', 'user', 'failed-checkpoint', 'original-task', 'failed-call'), saved);
  assert.equal(captureIntentRetryBinding(state, 'session', 'user', 'new', 'another-task', 'failed-call'), undefined);
  state.intentRouteRevisionsBySession.session = [];
  assert.equal(captureIntentRetryBinding(state, 'session', 'user', 'new', 'original-task', 'failed-call'), undefined);
});

for (const evidence of ['task checkpoint', 'candidate', 'github candidate', 'workspace execution', 'writeback', 'captured changes', 'submitted artifact'] as const) {
  test(`R8 ${evidence} prohibits replay and points to existing writeback resolution`, () => {
    const state: any = approvedRetryState(), call = state.runtimeInvocationsBySession.session[0];
    if (evidence === 'task checkpoint') state.tasksBySession.session[0].executionCheckpoint = { stage: 'submission_validated' };
    if (evidence === 'candidate') call.executionCandidate = { id: 'candidate' };
    if (evidence === 'github candidate') call.githubCandidate = { id: 'candidate' };
    if (evidence === 'workspace execution') call.workspaceExecution = { mode: 'staging_copy' };
    if (evidence === 'writeback') state.workspaceWritebacks = [{ id: 'writeback', sessionId: 'session', taskId: 'original-task', status: 'failed' }];
    if (evidence === 'captured changes') call.systemEvidence = { invocationId: 'failed-call', workspaceChangeSet: { changes: [{ path: 'file' }] } };
    if (evidence === 'submitted artifact') state.artifacts = { artifactsById: { submitted: { id: 'submitted', sessionId: 'session',
      taskId: 'original-task', metadata: { phase: 'task_execution' }, systemEvidence: { invocationId: 'failed-call' } } } };
    const before = structuredClone(state);
    assert.throws(() => bindIntentRetry(state, 'session', 'user'), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      const response = error.getResponse() as any;
      assert.equal(response.code, 'INTENT_RETRY_STEP_UNSUPPORTED');
      assert.equal(response.details.resolution.path, '/sessions/session/workspace-writebacks/:writebackId/resolve'); return true;
    });
    assert.deepEqual(state, before);
  });
}

for (const runtimeType of ['codex', 'claude_code', 'test_runner', 'mcp_tool', 'human'] as const) test(`R8 unproven ${runtimeType} effects require reconciliation`, () => {
  const state: any = approvedRetryState();
  state.runtimeInvocationsBySession.session[0].runtimeType = runtimeType;
  state.sessions[0].activeRecoveryCheckpoint.retryBinding.failure.runtimeType = runtimeType;
  assert.throws(() => bindIntentRetry(state, 'session', 'user'), /INTENT_RETRY_RECONCILIATION_REQUIRED/);
});
test('R8 only audited read-only adapters pass the actual Runtime guard', () => {
  for (const runtimeType of ['generic_llm', 'mock', 'code_reader'] as const) assert.doesNotThrow(() => assertIntentRetryRuntimeSafe(runtimeType));
  assert.throws(() => assertIntentRetryRuntimeSafe('codex'), /INTENT_RETRY_RECONCILIATION_REQUIRED/);
});

function memoryStore(state: PersistedState) {
  return { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback),
    async mutateCollections(_keys: string[], fn: (draft: PersistedState) => unknown) {
      const draft = structuredClone(state), result = fn(draft); Object.assign(state, draft); return result;
    } } as any;
}
test('R8 concurrent and repeated control calls claim one task once', async () => {
  const state = approvedRetryState(), control = new IntentResumeControlService(memoryStore(state)); let calls = 0;
  const invoke = () => control.retry('session', 'user', async () => { calls++; });
  await Promise.all([invoke(), invoke()]); await invoke(); assert.equal(calls, 1);
});
test('R8 unknown control delivery is reconciled instead of replayed', async () => {
  const state: any = approvedRetryState(), binding = bindIntentRetry(state, 'session', 'user');
  state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'running', binding, processId: 'previous-process' }];
  let calls = 0;
  await assert.rejects(new IntentResumeControlService(memoryStore(state)).retry('session', 'user', async () => { calls++; }), /RECONCILIATION_REQUIRED/);
  assert.equal(calls, 0); assert.equal(state.intentPlanStepsBySession.session[0].retryReceipts[0].status, 'reconciliation_required');
});
test('R8 a thrown dispatch is never retried blindly', async () => {
  const state = approvedRetryState(), control = new IntentResumeControlService(memoryStore(state)); let calls = 0;
  const invoke = () => control.retry('session', 'user', async () => { calls++; throw new Error('unknown dispatch'); });
  await assert.rejects(invoke(), /unknown dispatch/); await assert.rejects(invoke(), /RECONCILIATION_REQUIRED/); assert.equal(calls, 1);
});
test('R8 an accepted dispatch with a crashed execution is reconciled before replay', async () => {
  const state: any = approvedRetryState(), binding = state.sessions[0].activeRecoveryCheckpoint.retryBinding;
  state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'applied', processId: 'old-dispatch', binding,
    execution: { processId: 'old-worker', claimId: 'old-claim', status: 'running' } }];
  let calls = 0;
  await assert.rejects(new IntentResumeControlService(memoryStore(state)).retry('session', 'user', async () => { calls++; }),
    /INTENT_RETRY_RECONCILIATION_REQUIRED/);
  assert.equal(calls, 0); assert.equal(state.intentPlanStepsBySession.session[0].retryReceipts[0].execution.status, 'reconciliation_required');
});
test('R8 File persistence preserves immutable checkpoint/append-only receipts across reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-r8-')), filePath = join(directory, 'state.json');
  const store = new PersistenceService({ backend: 'file', filePath }); await store.initialize();
  t.after(async () => { await store.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  for (const [key, value] of Object.entries(approvedRetryState())) await store.setCollection(key, value);
  await assert.rejects(store.mutateCollections(['sessions'], draft => {
    (draft.sessions as any)[0].activeRecoveryCheckpoint.retryBinding.task.taskId = 'forged';
  }), /INTENT_RETRY_BINDING_IMMUTABLE/);
  let calls = 0; await new IntentResumeControlService(store).retry('session', 'user', async () => { calls++; });
  for (const mutate of [
    (row: any) => { row.retryReceipts[0].binding.task.taskId = 'forged'; },
    (row: any) => { row.retryReceipts = []; },
    (row: any) => { row.retryReceipts[0].status = 'running'; }
  ]) await assert.rejects(store.mutateCollections(['intentPlanStepsBySession'], draft => {
    mutate((draft.intentPlanStepsBySession as any).session[0]);
  }), /INTENT_RETRY_RECEIPT_CONFLICT/);
  const reload = new PersistenceService({ backend: 'file', filePath }); await reload.initialize(); t.after(() => reload.onModuleDestroy());
  await new IntentResumeControlService(reload).retry('session', 'user', async () => { calls++; }); assert.equal(calls, 1);
  const binding = reload.getCollection<Record<string, import('@agent-cluster/shared').IntentPlanStepRecord[]>>(
    'intentPlanStepsBySession', {}).session[0].retryReceipts![0].binding;
  const claimId = await claimIntentRetryExecution(reload, binding);
  await assert.rejects(claimIntentRetryExecution(reload, binding), /INTENT_RETRY_IN_PROGRESS/);
  await settleIntentRetryExecution(reload, binding, claimId);
  await assert.rejects(claimIntentRetryExecution(reload, binding), /INTENT_RETRY_ALREADY_EXECUTED/);
  for (const mutate of [
    (row: any) => { delete row.retryReceipts[0].execution; },
    (row: any) => { row.retryReceipts[0].execution.claimId = 'forged'; },
    (row: any) => { row.retryReceipts[0].execution.status = 'running'; }
  ]) await assert.rejects(reload.mutateCollections(['intentPlanStepsBySession'], draft => {
    mutate((draft.intentPlanStepsBySession as any).session[0]);
  }), /INTENT_RETRY_RECEIPT_CONFLICT/);
});
