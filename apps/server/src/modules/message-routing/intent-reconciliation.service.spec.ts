import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionsController } from '../sessions/sessions.controller.js';
import { approvedRetryState } from './intent-retry.fixture.js';
import { approvedResumeState } from './intent-resume.fixture.js';
import { bindIntentResume } from './intent-resume-guard.js';
import { IntentReconciliationService } from './intent-reconciliation.service.js';
import { CLI_RISK_VERSION, RECONCILIATIONS, activeReconciliationAttempt, assertReconciliationFence,
  assertReconciliationOutcome, claimReconciliationExecution, reserveReconciliationInvocation, settleReconciliationExecution,
  hasReconciledCliConfirmation, reconciliationHash } from './intent-reconciliation-state.js';
import { IntentResumeControlService } from './intent-resume-control.service.js';
import { bindIntentRetry } from './intent-retry-guard.js';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkflowRuntimeService } from '../workflows/workflow-runtime.service.js';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');
const repositoryRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
const serverTsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));

function seed(kind = 'retry', runtimeType = 'generic_llm'): any {
  const state: any = kind === 'resume' ? approvedResumeState() : approvedRetryState();
  const binding = kind === 'resume' ? bindIntentResume(state, 'session', 'user') : state.sessions[0].activeRecoveryCheckpoint.retryBinding;
  if (kind !== 'resume') {
    binding.failure.runtimeType = runtimeType; state.runtimeInvocationsBySession.session[0].runtimeType = runtimeType;
  }
  state.intentPlanStepsBySession.session[0][kind === 'resume' ? 'resumeReceipts' : 'retryReceipts'] = [
    { status: 'reconciliation_required', processId: 'old-process', binding, ...(kind === 'resume' ? { pauseRevision: binding.pauseRevision } : {}) }
  ];
  return state;
}
function memoryStore(state: PersistedState): PersistenceService {
  let tail = Promise.resolve();
  return { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback),
    mutateCollections(_keys: string[], fn: (draft: PersistedState) => unknown) {
      const result = tail.then(() => { const draft = structuredClone(state); const result = fn(draft); Object.assign(state, draft); return result; });
      tail = result.then(() => undefined, () => undefined); return result;
    } } as unknown as PersistenceService;
}
const decision = (view: any, action = 'redispatch', key = 'one') => ({ expectedCaseRevision: view.record.revision,
  expectedSessionRevision: view.sessionRevision, action, idempotencyKey: key });
async function harness(kind = 'retry', runtime = 'generic_llm') {
  const state = seed(kind, runtime), store = memoryStore(state), service = new IntentReconciliationService(store);
  let calls = 0; let binding: any;
  const control = new IntentResumeControlService(store);
  service.bind(async (id, ref) => {
    const invoke = async (value: any) => { calls++; binding = value; };
    if (kind === 'resume') await control.resume(id, 'user', invoke, undefined, ref);
    else await control.retry(id, 'user', invoke, undefined, ref);
  });
  const view = (await service.list('session', 'user'))[0];
  return { state, store, service, view, calls: () => calls, binding: () => binding };
}

test('R9a exposes a server exit from R7/R8 reconciliation instead of leaving the task stuck', () => {
  assert.equal(typeof (SessionsController.prototype as any).intentReconciliationsList, 'function', 'missing evidence/list API');
  assert.equal(typeof (SessionsController.prototype as any).decideIntentReconciliation, 'function', 'missing human decision API');
});

for (const kind of ['resume', 'retry']) test(`R9a ${kind}: one human redispatch, duplicate keys and normal dispatch stay fenced`, async () => {
  const h = await harness(kind), history = structuredClone(h.state.intentPlanStepsBySession.session);
  const input = decision(h.view);
  const result = await Promise.all([h.service.decide('session', h.view.record.id, 'user', input), h.service.decide('session', h.view.record.id, 'user', input)]);
  assert.equal(h.calls(), 1); assert.equal(result.filter(row => row.idempotentReplay).length, 1);
  assert.deepEqual(h.state.intentPlanStepsBySession.session, history, 'original receipts remain immutable');
  assert.throws(() => assertReconciliationFence(h.state, { sessionId: 'session', taskId: 'original-task' }), /DECISION_REQUIRED/);
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', { ...input, action: 'abandon' }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', decision(h.view, 'abandon', 'competitor')), /VERSION_STALE/);
});

for (const action of ['confirm_completed', 'abandon']) test(`R9a ${action}: no dispatch, WAIT_USER_DECISION, notification and no task revival`, async () => {
  const h = await harness();
  h.state.tasksBySession.session.push({ id: 'sibling', status: 'completed', resultSummary: 'kept' });
  const sibling = structuredClone(h.state.tasksBySession.session[1]);
  await h.service.decide('session', h.view.record.id, 'user', decision(h.view, action));
  assert.equal(h.calls(), 0); assert.equal(h.state.tasksBySession.session[0].status, action === 'abandon' ? 'cancelled' : 'completed');
  assert.deepEqual(h.state.tasksBySession.session[1], sibling);
  assert.equal(h.state.sessions[0].status, 'WAIT_USER_DECISION');
  assert.ok(h.state.eventsBySession.session.some((row: any) => row.type === 'session_status_changed' && row.metadata.payload.status === 'WAIT_USER_DECISION'));
  assert.throws(() => assertReconciliationOutcome(h.state, 'session', ['original-task']), /OUTCOME_STALE/);
  assert.throws(() => bindIntentRetry(h.state, 'session', 'user'), /RETRY_CHECKPOINT_REQUIRED/);
});

for (const runtime of ['codex', 'claude_code']) {
  for (const extra of [{}, { acceptWorkspaceResponsibility: true }, { riskVersion: CLI_RISK_VERSION }]) {
    test(`R9a ${runtime} requires both explicit CLI fields ${JSON.stringify(extra)}`, async () => {
      const h = await harness('retry', runtime), before = structuredClone(h.state);
      await assert.rejects(h.service.decide('session', h.view.record.id, 'user', { ...decision(h.view), ...extra }), /CLI_CONFIRMATION_REQUIRED/);
      assert.equal(h.calls(), 0); assert.deepEqual(h.state, before);
    });
  }
  test(`R9a ${runtime} confirmation authorizes only this case and this attempt`, async () => {
    const h = await harness('retry', runtime);
    await h.service.decide('session', h.view.record.id, 'user', { ...decision(h.view), acceptWorkspaceResponsibility: true, riskVersion: CLI_RISK_VERSION });
    const binding = h.binding(), ref = binding.reconciliationAttempt;
    assert.equal(hasReconciledCliConfirmation(h.state, binding, runtime as any), true);
    assert.equal(hasReconciledCliConfirmation(h.state, binding, runtime === 'codex' ? 'claude_code' : 'codex'), false);
    assert.throws(() => activeReconciliationAttempt(h.state, 'session', { ...ref, caseId: 'other' }), /ATTEMPT_STALE/);
    assert.throws(() => activeReconciliationAttempt(h.state, 'session', { ...ref, attemptId: 'next' }), /ATTEMPT_STALE/);
    const claim = await claimReconciliationExecution(h.store, 'session', ref);
    await assert.rejects(claimReconciliationExecution(h.store, 'session', ref), /ALREADY_CLAIMED/);
    await reserveReconciliationInvocation(h.store, { sessionId: 'session', taskId: 'original-task', invocationId: 'rerun', reconciliationAttempt: ref });
    await assert.rejects(reserveReconciliationInvocation(h.store, { sessionId: 'session', taskId: 'original-task', invocationId: 'again', reconciliationAttempt: ref }), /ONCE_EXHAUSTED/);
    await settleReconciliationExecution(h.store, 'session', ref, claim);
    assert.throws(() => hasReconciledCliConfirmation(h.state, binding, runtime as any), /ATTEMPT_STALE/);
  });
}
for (const runtime of ['mcp_tool', 'test_runner', 'human']) test(`R9a ${runtime} cannot use a CLI responsibility confirmation`, async () => {
  const h = await harness('retry', runtime);
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', { ...decision(h.view), acceptWorkspaceResponsibility: true, riskVersion: CLI_RISK_VERSION }), /CLI_CONFIRMATION_INVALID/);
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', decision(h.view)), /RECONCILIATION_REQUIRED/);
  assert.equal(h.calls(), 0);
});

const guards: Array<[string, (s: any) => void]> = [
  ['grant revoked', s => { s.sessions[0].intentWorkspaceReadAuthority.grant.revokedAt = 'now'; }],
  ['intent changed', s => { s.intentRoutingRecordsBySession.session[0].effectiveIntentRevision++; }],
  ['requirement changed', s => { s.workItemsBySession.session[0].requirementRevision++; }],
  ['cancelled work', s => { s.workItemsBySession.session[0].status = 'CANCELLED'; }],
  ['budget hold', s => { s.logicalOperationsBySession.session[0].inputBudgetDecisions = [{ status: 'pending', dataEpoch: 'epoch', sessionGeneration: 1 }]; }],
  ['operation budget', s => { s.logicalOperationsBySession.session[0].attemptsUsed = 3; }],
  ['candidate', s => { s.runtimeInvocationsBySession.session[0].executionCandidate = { id: 'candidate' }; }],
  ['writeback', s => { s.workspaceWritebacks = [{ id: 'write', sessionId: 'session', taskId: 'original-task', status: 'conflicted' }]; }],
  ['active invocation', s => { s.logicalOperationsBySession.session[0].activeInvocationId = 'active'; }]
];
for (const [name, mutate] of guards) test(`R9a redispatch does not bypass ${name}`, async () => {
  const h = await harness(); mutate(h.state); const view = (await h.service.list('session', 'user'))[0];
  const before = structuredClone(h.state);
  await assert.rejects(h.service.decide('session', view.record.id, 'user', decision(view)));
  assert.equal(h.calls(), 0); assert.deepEqual(h.state, before);
});

test('R9a stale evidence, wrong actor, old generation and legacy session cannot decide', async () => {
  const h = await harness();
  h.state.tasksBySession.session[0].updatedAt = 'changed';
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', decision(h.view)), /VERSION_STALE/);
  await assert.rejects(h.service.decide('session', h.view.record.id, 'other', decision(h.view)), /SESSION_UNAVAILABLE/);
  h.state.sessionLifecyclesBySession.session.generation++;
  await assert.rejects(h.service.decide('session', h.view.record.id, 'user', decision(h.view)), /VERSION_STALE/);
  delete h.state.sessions[0].intentContractVersion;
  const before = structuredClone(h.state);
  await assert.rejects(h.service.list('session', 'user'), /SESSION_UNAVAILABLE/); assert.deepEqual(h.state, before);
});

test('R9a exposes unknown workspace attribution and other reconciliation sources read-only', async () => {
  const h = await harness();
  h.state.intentPlanStepsBySession.session.push({ ...h.state.intentPlanStepsBySession.session[0], id: 'other', status: 'reconciliation_required', retryReceipts: undefined });
  const views = await h.service.list('session', 'user');
  assert.equal(views[0].evidence.unownedWorkspaceChanges, '未知');
  const readOnly = views.find(row => row.readOnly)!; assert.ok(readOnly); assert.deepEqual(readOnly.actions, []);
  await assert.rejects(h.service.decide('session', readOnly.record.id, 'user', decision(readOnly, 'abandon')), /READ_ONLY/);
});

test('R9a abandoning an active target commits its fence before stopping only that invocation', async () => {
  const h = await harness();
  const op = h.state.logicalOperationsBySession.session[0]; op.activeInvocationId = 'active-target';
  let sync = 0; const stopped: string[][] = [];
  h.service.bind(async () => { throw new Error('must not dispatch'); }, {
    committed: () => { sync++; assert.equal(h.state.sessions[0].status, 'WAIT_USER_DECISION'); },
    stop: async (_id: string, ids: string[]) => {
      assert.throws(() => assertReconciliationFence(h.state, { sessionId: 'session', taskId: 'original-task' }), /DECISION_REQUIRED/);
      stopped.push(ids); return { stopConfirmed: false };
    }
  });
  const view = (await h.service.list('session', 'user'))[0], input = decision(view, 'abandon');
  await h.service.decide('session', view.record.id, 'user', input);
  await h.service.decide('session', view.record.id, 'user', input);
  assert.deepEqual(stopped, [['active-target']]); assert.ok(sync >= 1);
  assert.equal(h.state.sessions[0].activeRecoveryCheckpoint, undefined);
  assert.equal(op.stopState, 'confirmed', 'test retains historical object; service does not invent stop confirmation');
});

test('R9a foreign-process attempts cannot execute and list reopens the case without redispatch', async () => {
  const h = await harness(); await h.service.decide('session', h.view.record.id, 'user', decision(h.view));
  const row = h.state[RECONCILIATIONS].session[0]; row.attempts[0].processId = 'dead-process';
  await assert.rejects(claimReconciliationExecution(h.store, 'session', h.binding().reconciliationAttempt), /ATTEMPT_STALE/);
  const view = (await h.service.list('session', 'user'))[0];
  assert.equal(view.record.status, 'open'); assert.equal(view.record.attempts[0].status, 'reconciliation_required'); assert.equal(h.calls(), 1);
});

test('R9a settled redispatch does not admit a late outcome from the original queue job', async () => {
  const h = await harness(); await h.service.decide('session', h.view.record.id, 'user', decision(h.view));
  const ref = h.binding().reconciliationAttempt, claim = await claimReconciliationExecution(h.store, 'session', ref);
  await settleReconciliationExecution(h.store, 'session', ref, claim);
  assert.throws(() => assertReconciliationOutcome(h.state, 'session', ['original-task']), /OUTCOME_STALE/);
  assert.doesNotThrow(() => assertReconciliationOutcome(h.state, 'session', ['original-task'], ref));
});

for (const kind of ['resume', 'retry']) test(`R9a ${kind} reaches the same original logical operation without resetting its budget`, async () => {
  const h = await harness(kind); await h.service.decide('session', h.view.record.id, 'user', decision(h.view));
  const binding = h.binding(), ref = binding.reconciliationAttempt;
  await claimReconciliationExecution(h.store, 'session', ref);
  h.state.sessions[0].status = 'EXECUTING'; h.state.sessionLifecyclesBySession.session.admission = 'open';
  const operations = new LogicalOperationStore(h.store), service = Object.create(OrchestratorService.prototype) as any;
  service.persistence = h.store; service.runtime = { operations }; service.tasks = { update: Object.assign };
  service.retryTaskBindings = new Map(kind === 'retry' ? [['session:original-task', binding]] : []);
  service.reconciliationTaskBindings = new Map(kind === 'resume' ? [['session:original-task', ref]] : []);
  const before = structuredClone(h.state.logicalOperationsBySession.session[0]);
  const operation = await service.taskExecutionOperation(h.state.sessions[0], h.state.tasksBySession.session[0], 'human-call');
  assert.equal(operation.id, before.id); assert.equal(operation.attemptsUsed, before.attemptsUsed);
  assert.deepEqual(operation.reconciliationAttempt, ref);
  await reserveReconciliationInvocation(h.store, { sessionId: 'session', taskId: 'original-task', invocationId: 'human-call', reconciliationAttempt: ref });
  await operations.reserve('session', operation.id, 'human-call');
  assert.equal(operations.list('session').length, 1); assert.equal(operations.list('session')[0].attemptsUsed, before.attemptsUsed + 1);
});

test('R9a committed manual decision refreshes Session, task and workflow live objects without advancing', async () => {
  const h = await harness(), session = structuredClone(h.state.sessions[0]);
  const tasks = new TasksService(h.store), task = tasks.list('session')[0];
  const workflow = new WorkflowRuntimeService({} as never, {} as never, tasks, {} as never, {} as never, h.store);
  const sessions = Object.create(SessionsService.prototype) as any;
  Object.assign(sessions, { persistence: h.store, sessions: new Map([['session', session]]), tasks, workflowRuntime: workflow });
  h.service.bind(async () => {}, { committed: id => sessions.acceptReconciledState(id) });
  await h.service.decide('session', h.view.record.id, 'user', decision(h.view, 'confirm_completed'));
  assert.equal(session.status, 'WAIT_USER_DECISION'); assert.equal(session.activeRecoveryCheckpoint, undefined);
  assert.equal(task.status, 'completed'); assert.equal(tasks.list('session')[0], task);
});

for (const action of ['confirm_completed', 'abandon']) test(`R9a workflow ${action} changes only the bound node, parks the run and emits a user result`, async () => {
  const state = seed(), binding = state.sessions[0].activeRecoveryCheckpoint.retryBinding;
  binding.workflow = { id: 'run', nodeRunId: 'node-run', definitionHash: reconciliationHash({}), revision: 1, attempt: 1 };
  state.sessions[0].workflowRunId = 'run';
  Object.assign(state.tasksBySession.session[0], { workflowRunId: 'run', workflowNodeId: 'node', workflowNodeRunId: 'node-run' });
  state.workflowRuntime = { runs: [{ id: 'run', sessionId: 'session', status: 'failed', revision: 1, sessionGeneration: 1,
    workItemId: 'work', briefId: 'approved-brief', currentNodeId: 'node', definitionSnapshot: {} }],
    nodeRunsByRunId: { run: [{ id: 'node-run', nodeId: 'node', workflowRunId: 'run', relatedTaskId: 'original-task', status: 'failed', attempt: 1 },
      { id: 'upstream', workflowRunId: 'run', status: 'completed' }, { id: 'downstream', workflowRunId: 'run', status: 'pending' }] } };
  const store = memoryStore(state), service = new IntentReconciliationService(store);
  const view = (await service.list('session', 'user'))[0], siblings = structuredClone(state.workflowRuntime.nodeRunsByRunId.run.slice(1));
  await service.decide('session', view.record.id, 'user', decision(view, action));
  assert.equal(state.workflowRuntime.nodeRunsByRunId.run[0].status, action === 'abandon' ? 'cancelled' : 'completed');
  assert.equal(state.workflowRuntime.runs[0].status, 'waiting_human');
  assert.deepEqual(state.workflowRuntime.nodeRunsByRunId.run.slice(1), siblings);
  assert.equal(state.sessions[0].status, 'WAIT_USER_DECISION');
});

test('R9a File restart retains decisions and rejects mutation of historical audit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-r9a-')), filePath = join(directory, 'state.json');
  const store = new PersistenceService({ backend: 'file', filePath }); await store.initialize();
  t.after(async () => { await store.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  const initial = seed(), receipt = initial.intentPlanStepsBySession.session[0].retryReceipts[0];
  receipt.status = 'running';
  for (const [key, value] of Object.entries(initial)) await store.setCollection(key, value);
  await store.mutateCollections(['intentPlanStepsBySession'], draft => {
    (draft.intentPlanStepsBySession as any).session[0].retryReceipts[0].status = 'reconciliation_required';
  });
  const service = new IntentReconciliationService(store), view = (await service.list('session', 'user'))[0];
  const input = decision(view, 'confirm_completed'); await service.decide('session', view.record.id, 'user', input);
  const restored = new PersistenceService({ backend: 'file', filePath }); await restored.initialize(); t.after(() => restored.onModuleDestroy());
  assert.equal((await new IntentReconciliationService(restored).decide('session', view.record.id, 'user', input)).idempotentReplay, true);
  await assert.rejects(store.mutateCollections([RECONCILIATIONS], draft => { (draft[RECONCILIATIONS] as any).session[0].decisions[0].actorId = 'forged'; }), /RECORD_CONFLICT/);
});

test('R9a File claim survives a real process exit; restart never auto-dispatches and new attempt leaves old audit intact', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-r9a-crash-')), filePath = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `
    import { approvedRetryState } from './apps/server/src/modules/message-routing/intent-retry.fixture.ts';
    import { PersistenceService } from './apps/server/src/modules/persistence/persistence.service.ts';
    import { IntentResumeControlService } from './apps/server/src/modules/message-routing/intent-resume-control.service.ts';
    import { IntentReconciliationService } from './apps/server/src/modules/message-routing/intent-reconciliation.service.ts';
    (async () => {
      const store = new PersistenceService({ backend: 'file', filePath: ${JSON.stringify(filePath)} }); await store.initialize();
      for (const [key,value] of Object.entries(approvedRetryState())) await store.setCollection(key,value);
      const control = new IntentResumeControlService(store);
      await control.retry('session','user',async()=>{ throw Error('unknown delivery'); }).catch(()=>{});
      const service = new IntentReconciliationService(store);
      service.bind((id,ref)=>control.retry(id,'user',async()=>{},undefined,ref));
      const view = (await service.list('session','user'))[0];
      await service.decide('session',view.record.id,'user',{action:'redispatch', idempotencyKey:'child',expectedCaseRevision:view.record.revision,expectedSessionRevision:view.sessionRevision});
      await store.onModuleDestroy();
    })().catch(error=>{ console.error(error);process.exitCode=1; });`;
  const childPath = join(directory, 'child.mts');
  writeFileSync(childPath, script.replace(/'\.\/(apps\/[^']+)'/g, (_match, path) => JSON.stringify(pathToFileURL(resolve(repositoryRoot, path)).href)));
  const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [tsxCliPath, '--tsconfig', serverTsconfigPath, childPath],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, env: childEnvironment });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).sessions?.[0]?.id, 'session', child.stdout);
  const store = new PersistenceService({ backend: 'file', filePath }); await store.initialize();
  t.after(() => store.onModuleDestroy());
  const service = new IntentReconciliationService(store), view = (await service.list('session', 'user'))[0];
  assert.equal(view.record.status, 'open'); assert.equal(view.record.attempts[0].status, 'reconciliation_required');
  const history = structuredClone(view.record.attempts[0]); let calls = 0; let ref: any;
  const control = new IntentResumeControlService(store);
  service.bind((id, value) => control.retry(id, 'user', async () => { calls++; ref = value; }, undefined, value));
  await service.decide('session', view.record.id, 'user', decision(view, 'redispatch', 'parent'));
  const claim = await claimReconciliationExecution(store, 'session', ref);
  await reserveReconciliationInvocation(store, { sessionId: 'session', taskId: 'original-task', invocationId: 'parent-call', reconciliationAttempt: ref });
  for (const change of [
    (row: any) => { row.attempts[1].cliConfirmation = { actorId: 'forged' }; },
    (row: any) => { row.attempts[1].claimId = 'forged'; },
    (row: any) => { row.attempts[1].invocationIds = []; },
    (row: any) => { row.attempts = []; }
  ]) await assert.rejects(store.mutateCollections([RECONCILIATIONS], (draft: any) => change(draft[RECONCILIATIONS].session[0])), /RECORD_CONFLICT/);
  await settleReconciliationExecution(store, 'session', ref, claim, true);
  const current = (await service.list('session', 'user'))[0];
  assert.deepEqual(current.record.attempts[0], history); assert.equal(current.record.attempts.length, 2); assert.equal(calls, 1);
});

test('R9a discovers six stored source types; non-R7/R8 sources stay read-only', async () => {
  const h = await harness(), resume: any = seed('resume');
  h.state.intentPlanStepsBySession.session.push({ ...resume.intentPlanStepsBySession.session[0], id: 'resume-history', localKey: 'resume-history' });
  h.state.intentPlanStepsBySession.session.push({ id: 'read-only-step', routingId: 'original-route', dataEpoch: 'epoch', status: 'reconciliation_required' });
  h.state.intentCorrectionsBySession = { session: [{ id: 'correction', dataEpoch: 'epoch', routingId: 'original-route', status: 'reconciliation_required' }] };
  h.state.logicalOperationsBySession.session.push({ id: 'test-operation', dataEpoch: 'epoch', executionBinding: { routingId: 'original-route' }, invocationIds: [],
    isolatedTestAttempts: [{ invocationId: 'test-call', phase: 'reconciliation_required' }] });
  const views = await h.service.list('session', 'user');
  assert.deepEqual([...new Set(views.map(item => item.record.source))].sort(), ['correction', 'isolated_test', 'plan_step', 'resume', 'retry']);
  for (const view of views.filter(item => ['correction', 'isolated_test', 'plan_step'].includes(item.record.source))) {
    assert.equal(view.readOnly, true); assert.deepEqual(view.actions, []); assert.ok(view.handler);
  }
  const cli = await harness('retry', 'codex');
  delete cli.state.intentPlanStepsBySession.session[0].retryReceipts;
  delete cli.state[RECONCILIATIONS];
  assert.equal((await cli.service.list('session', 'user'))[0].record.source, 'runtime_safety');
});
