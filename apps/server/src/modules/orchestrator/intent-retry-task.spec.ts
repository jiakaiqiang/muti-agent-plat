import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestratorService } from './orchestrator.service.js';
import { approvedResumeState } from '../message-routing/intent-resume.fixture.js';
import { seedFailedRetry } from '../message-routing/intent-retry.fixture.js';
import { approvedRetryState } from '../message-routing/intent-retry.fixture.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';

test('R8 retry mode invokes exactly the bound failed task and never expands dependencies, reviews or delivery', async () => {
  const state: any = approvedResumeState();
  // seed uses a clean state to keep the original execution proof unique.
  for (const key of ['tasksBySession', 'briefsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession']) delete state[key];
  const binding = seedFailedRetry(state, state.sessions[0], state.workItemsBySession.session[0]);
  const task = state.tasksBySession.session[0]; task.status = 'pending'; task.dependsOnTaskIds = ['upstream'];
  const other = [{ id: 'upstream', sessionId: 'session', status: 'completed', dependsOnTaskIds: [] },
    { id: 'sibling', sessionId: 'session', status: 'pending', dependsOnTaskIds: [] }];
  const before = structuredClone(other), calls: string[] = [];
  const service = Object.create(OrchestratorService.prototype) as any;
  service.tasks = { list: () => [task, ...other], find: (_session: string, id: string) => [task, ...other].find(row => row.id === id) };
  service.runtime = { operations: { list: () => [] } };
  service.persistence = { getCollection: (key: string, fallback: unknown) => state[key] ?? fallback,
    mutateCollections: async (_keys: string[], fn: (draft: any) => unknown) => fn(state) };
  service.runOneTask = async (_session: unknown, _brief: unknown, item: any) => {
    calls.push(item.id); item.status = 'completed'; return { ok: true };
  };
  service.runPostReview = () => { throw new Error('retry must not enter review'); };
  service.latestLimitedDeliveryAction = () => undefined;
  service.runtimeSwitches = undefined;
  // Dispatch identity: exactly this attempt was claimed before the task was reset.
  state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'running', binding, processId: 'test' }];
  state.sessions[0].status = 'EXECUTING';
  const result = await service.runPipeline(state.sessions[0], state.briefsBySession.session[0], [task], undefined, binding);
  assert.equal(result.kind, 'retry_task_completed');
  assert.deepEqual(calls, ['original-task']); assert.deepEqual(other, before);
});

test('R8 duplicate queue deliveries claim execution once before any task call', async () => {
  const state: any = approvedRetryState(), session = state.sessions[0], task = state.tasksBySession.session[0];
  const binding = session.activeRecoveryCheckpoint.retryBinding;
  session.status = 'EXECUTING'; task.status = 'pending';
  state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'applied', binding, processId: 'dispatch-process' }];
  const service = Object.create(OrchestratorService.prototype) as any;
  service.persistence = { getCollection: (key: string, fallback: unknown) => state[key] ?? fallback,
    mutateCollections: async (_keys: string[], fn: (draft: any) => unknown) => fn(state) };
  service.tasks = { list: () => [task], find: () => task };
  service.runtime = { operations: { list: () => [] } };
  let release!: () => void, calls = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  service.runOneTask = async () => { calls++; if (calls === 1) await wait; return { ok: true }; };
  const invoke = () => service.runPipeline(session, state.briefsBySession.session[0], [task], undefined, binding);
  const first = invoke();
  await new Promise(resolve => setImmediate(resolve));
  try { await assert.rejects(invoke(), /INTENT_RETRY_IN_PROGRESS/); } finally { release(); }
  await first;
  await assert.rejects(invoke(), /INTENT_RETRY_ALREADY_EXECUTED/);
  assert.equal(calls, 1);
});

test('R8 a crashed execution claim requires reconciliation and never calls the task', async () => {
  const state: any = approvedRetryState(), session = state.sessions[0], task = state.tasksBySession.session[0];
  const binding = session.activeRecoveryCheckpoint.retryBinding;
  session.status = 'EXECUTING'; task.status = 'pending';
  state.intentPlanStepsBySession.session[0].retryReceipts = [{ status: 'applied', binding, processId: 'dispatch-process',
    execution: { status: 'running', processId: 'previous-process', claimId: 'previous-claim' } }];
  const service = Object.create(OrchestratorService.prototype) as any;
  service.persistence = { getCollection: (key: string, fallback: unknown) => state[key] ?? fallback,
    mutateCollections: async (_keys: string[], fn: (draft: any) => unknown) => fn(state) };
  service.tasks = { list: () => [task], find: () => task };
  service.runtime = { operations: { list: () => [] } };
  let calls = 0; service.runOneTask = async () => { calls++; return { ok: true }; };
  await assert.rejects(service.runPipeline(session, state.briefsBySession.session[0], [task], undefined, binding),
    /INTENT_RETRY_RECONCILIATION_REQUIRED/);
  assert.equal(calls, 0);
  assert.equal(state.intentPlanStepsBySession.session[0].retryReceipts[0].execution.status, 'reconciliation_required');
});

test('R8 task retry reserves the same real logical operation and preserves the consumed budget', async () => {
  const state: any = approvedRetryState(), session = state.sessions[0], task = state.tasksBySession.session[0];
  const binding = session.activeRecoveryCheckpoint.retryBinding;
  session.status = 'EXECUTING'; task.status = 'pending'; state.sessionLifecyclesBySession.session.admission = 'open';
  const persistence = { getCollection: (key: string, fallback: unknown) => structuredClone(state[key] ?? fallback),
    mutateCollections: async (_keys: string[], fn: (draft: any) => unknown) => fn(state) };
  const operations = new LogicalOperationStore(persistence as never);
  const service = Object.create(OrchestratorService.prototype) as any;
  service.persistence = persistence; service.runtime = { operations }; service.tasks = { update: (row: any, patch: any) => Object.assign(row, patch) };
  service.retryTaskBindings = new Map([['session:original-task', binding]]);
  const before = structuredClone(state.logicalOperationsBySession.session[0]);
  const operation = await service.taskExecutionOperation(session, task, 'retry-call');
  assert.equal(operation.id, 'original-operation'); assert.deepEqual(operation.executionBinding, before.executionBinding);
  assert.equal(operation.attemptsUsed, before.attemptsUsed); assert.equal(operation.deadlineAt, before.deadlineAt);
  await operations.reserve('session', operation.id, 'retry-call');
  const saved = operations.list('session'); assert.equal(saved.length, 1);
  assert.equal(saved[0].attemptsUsed, before.attemptsUsed + 1);
  assert.deepEqual(saved[0].invocationIds, ['failed-call', 'retry-call']);
});
