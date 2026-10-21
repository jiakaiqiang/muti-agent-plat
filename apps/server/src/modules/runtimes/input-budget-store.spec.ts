import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionLifecycleStore } from './session-lifecycle-store.js';
import { LogicalOperationStore } from './logical-operation-store.js';
import { InputBudgetStore } from './input-budget-store.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { SessionsService } from '../sessions/sessions.service.js';

test('a larger preflight supersedes the unconsumed grant and replay cannot reschedule it', async t => {
  const { persistence, plan, store, estimate } = await budgetFixture(t);
  let first: any, larger: any;
  await assert.rejects(store.assert(plan, estimate, false), (error: any) => { first = error.inputBudgetDecision; return true; });
  const request = { operationId: 'op', decisionId: first.id, decision: 'continue' as const };
  await store.decide('session', 'user', request);
  await assert.rejects(store.assert(plan, { ...estimate, estimatedInputTokens: 200 }, false), (error: any) => { larger = error.inputBudgetDecision; return true; });
  assert.notEqual(first.id, larger.id);
  const session: any = { id: 'session', ownerId: 'user', status: 'WAIT_USER_DECISION' };
  const task: any = { id: 'task', status: 'waiting' };
  let resumes = 0;
  const facade: any = { persistence, get: () => session, tasks: { find: () => task, update: (row: any, patch: any) => Object.assign(row, patch) },
    events: { createOnce: () => undefined }, setStatus: (row: any, status: string) => { row.status = status; }, resumeExecution: () => { resumes++; } };
  await (SessionsService.prototype as any).decideInputBudget.call(facade, 'session', request);
  assert.equal(resumes, 0); assert.equal(task.status, 'waiting');
});

test('pending decision survives reload but cannot cross epoch, generation or closed admission', async t => {
  const { persistence, plan, store, estimate, filePath } = await budgetFixture(t);
  let hold: any;
  await assert.rejects(store.assert(plan, estimate, true), (error: any) => { hold = error.inputBudgetDecision; return true; });
  const restarted = new PersistenceService({ backend: 'file', filePath }); await restarted.initialize();
  t.after(() => restarted.onModuleDestroy());
  const request = { operationId: 'op', decisionId: hold.id, decision: 'continue' as const };
  assert.equal((await new InputBudgetStore(restarted).decide('session', 'user', request)).hold.status, 'granted');
  for (const patch of [{ dataEpoch: 'new-epoch' }, { generation: 2 }, { admission: 'closed' }]) {
    await persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
      Object.assign((draft.sessionLifecyclesBySession as any).session, { dataEpoch: 'epoch', generation: 1, admission: 'open' }, patch);
    });
    await assert.rejects(store.decide('session', 'user', request), /INPUT_BUDGET_SCOPE_STALE/);
    await assert.rejects(store.assert(plan, estimate, true), /INPUT_BUDGET_SCOPE_STALE/);
  }
});

async function budgetFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'input-budget-scope-')), filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  await persistence.setCollection('sessions', [{ id: 'session', ownerId: 'user', dataEpoch: 'epoch', status: 'EXECUTING' }]);
  await persistence.setCollection('tasksBySession', { session: [{ id: 'task', sessionId: 'session', status: 'running' }] });
  const { lifecycle } = await new SessionLifecycleStore(persistence).initialize('session', 'epoch');
  const operation = await new LogicalOperationStore(persistence).begin({ id: 'op', sessionId: 'session', taskId: 'task', phase: 'task_execution' });
  const plan = makeInvocationPlan({ sessionId: 'session', taskId: 'task', invocationId: 'first', operation,
    inputBudgetPolicy: { actorId: 'user', dataEpoch: 'epoch', sessionGeneration: lifecycle.generation,
      kind: 'agent_task', taskId: 'task', slot: 'task:task:task_execution:op' } });
  const estimate = { estimatedInputTokens: 100, outputReservationTokens: 20, effectiveMaxInputTokens: 90, maxInputTokens: 100, safetyMarginTokens: 10 };
  return { persistence, plan, store: new InputBudgetStore(persistence), estimate, filePath };
}

test('durable grant permits one whole rerun, with changed messages/rounds, but not a larger estimate or another invocation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'input-budget-'));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  await persistence.setCollection('sessions', [{ id: 'session', ownerId: 'user', dataEpoch: 'epoch', status: 'EXECUTING' }]);
  await persistence.setCollection('tasksBySession', { session: [{ id: 'task', sessionId: 'session', status: 'running' }] });
  const lifecycle = await new SessionLifecycleStore(persistence).initialize('session', 'epoch');
  const operations = new LogicalOperationStore(persistence);
  const operation = await operations.begin({ id: 'op', sessionId: 'session', taskId: 'task', phase: 'task_execution' });
  const plan = makeInvocationPlan({ sessionId: 'session', taskId: 'task', invocationId: 'first', operation,
    inputBudgetPolicy: { actorId: 'user', dataEpoch: 'epoch', sessionGeneration: lifecycle.lifecycle.generation,
      kind: 'agent_task', taskId: 'task', slot: 'task:task:task_execution:op' } });
  const store = new InputBudgetStore(persistence), estimate = { estimatedInputTokens: 100, outputReservationTokens: 20,
    effectiveMaxInputTokens: 90, maxInputTokens: 100, safetyMarginTokens: 10 };
  let hold: any;
  await assert.rejects(store.assert(plan, estimate, true), (error: any) => { hold = error.inputBudgetDecision; return error.code === 'INPUT_BUDGET_EXCEEDED'; });
  assert.equal(hold.status, 'pending');
  await assert.rejects(store.decide('session', 'other', { operationId: 'op', decisionId: hold.id, decision: 'continue' }));
  const request = { operationId: 'op', decisionId: hold.id, decision: 'continue' as const };
  const receipts = await Promise.all([store.decide('session', 'user', request), store.decide('session', 'user', request)]);
  assert.equal(receipts.filter(row => row.idempotentReplay).length, 1);
  plan.invocationId = 'rerun'; plan.contextEnvelope.createdAt = new Date().toISOString();
  await operations.resume('session', 'op');
  await operations.reserve('session', 'op', 'rerun');
  // Preflight only validates. Actual-send CAS consumes; later rounds share that invocation.
  await store.assert(plan, { ...estimate, estimatedInputTokens: 80 }, false);
  await store.assert(plan, { ...estimate, estimatedInputTokens: 80 }, true);
  await new InputBudgetStore(persistence).assert(plan, estimate, true);
  const restarted = new PersistenceService({ backend: 'file', filePath }); await restarted.initialize();
  t.after(() => restarted.onModuleDestroy());
  await assert.rejects((new (InputBudgetStore as any)(restarted, 'restarted-process')).assert(plan, estimate, true),
    /INPUT_BUDGET_GRANT_ALREADY_CONSUMED/);
  const competitor = { ...plan, invocationId: 'competing-rerun' };
  await assert.rejects(store.assert(competitor, estimate, true));
  // A larger round asks again, even within the already admitted rerun.
  let larger: any;
  await assert.rejects(store.assert(plan, { ...estimate, estimatedInputTokens: 101 }, true), (error: any) => {
    larger = error.inputBudgetDecision; assert.notEqual(larger.id, hold.id); return true;
  });
  const session: any = persistence.getCollection('sessions', [])[0];
  assert.equal(session.status, 'EXECUTING');
  assert.deepEqual(persistence.getCollection('workspaceWritebacks', []), []);
  assert.equal(JSON.stringify(persistence.getCollection('logicalOperationsBySession', {})).includes('messages'), false);
  const task: any = { id: 'task', sessionId: 'session', status: 'waiting' };
  let resumes = 0;
  const facade: any = { persistence, get: () => session,
    tasks: { find: () => task, update: (row: any, patch: any) => Object.assign(row, patch) },
    events: { createOnce: () => undefined }, setStatus: (row: any, status: string) => { row.status = status; },
    resumeExecution: () => { resumes++; }, cancelSession: () => { throw new Error('must not cancel Session'); } };
  const end = { operationId: 'op', decisionId: larger.id, decision: 'end' as const };
  await operations.settle('session', 'op', 'rerun', 'confirmed', true);
  await (SessionsService.prototype as any).decideInputBudget.call(facade, 'session', end);
  await (SessionsService.prototype as any).decideInputBudget.call(facade, 'session', end);
  assert.equal(task.status, 'cancelled'); assert.notEqual(session.status, 'CANCELLED');
  assert.equal(resumes, 1, 'double click must not schedule a second execution');
});
