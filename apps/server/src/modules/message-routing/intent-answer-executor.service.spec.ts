import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { intentUnderstandingExample, type IntentPlanStepRecord, type SessionDetail } from '@agent-cluster/shared';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { IntentAnswerExecutorService } from './intent-answer-executor.service.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';

const answer = { schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer', content: '系统先识别消息，再校验并提交路由计划。',
  targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] };
async function fixture(t: TestContext, invoke: (input: any) => Promise<any> = async () => ({ status: 'completed', output: answer }), targets: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-answer-')); const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  const backends = [persistence];
  const executors: IntentAnswerExecutorService[] = [];
  t.after(async () => { executors.forEach(service => service.onModuleDestroy()); for (const backend of backends) await backend.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1, decisionLedgerRevision: 0,
    title: '问答', originalInput: '解释当前系统的意图路由', status: 'PAUSED', tokenUsed: 0, participatingAgentIds: [...targets], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('eventsBySession', { session: [{ id: 'message-1', sessionId: 'session', type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: session.createdAt, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } }] });
  const lifecycle = new SessionLifecycleStore(persistence); await lifecycle.initialize('session', 'epoch');
  await persistence.mutateCollections(['sessionLifecyclesBySession'], draft => { (draft.sessionLifecyclesBySession as any).session.admission = 'closed'; });
  const context = new ContextManagementService(persistence);
  const route = await context.createRoutingRecord({ session, sourceEventId: 'message-1', idempotencyKey: 'route', rolloutMode: 'enforce_all_current_epoch' });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'message-1', currentMessage: session.originalInput, latestEventSeq: 1, mentionedAgentIds: targets });
  const understanding = structuredClone(intentUnderstandingExample); understanding.segments[0].target.agentIds.push(...targets);
  const proposal = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ sessionId: 'session', routingId: route.id, snapshotId: snapshot.id });
  const committed = await new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never)
    .commit({ sessionId: 'session', routingId: route.id, actorId: 'user', expectedRoutingRevision: proposal.routingRevision! });
  const reference = { sessionId: 'session', stepId: committed.plan.steps[0].stepId };
  const calls: any[] = [];
  const unavailable = new Set<string>();
  const make = (backend = persistence) => {
    const service = new IntentAnswerExecutorService(backend, { invoke: async (input: any) => { calls.push(input); return invoke(input); } } as never,
      { resolveSystemRole: () => ({ id: 'coordinator' }), getForSurface: (id: string) => {
        if (unavailable.has(id)) throw new Error('AGENT_SURFACE_NOT_ALLOWED');
        return { id, key: id, capabilityIds: [], profileMarkdown: `Agent ${id}` };
      } } as never, { get: () => ({}) } as never);
    executors.push(service); return service;
  };
  const service = make();
  const state = () => JSON.parse(readFileSync(filePath, 'utf8'));
  const step = () => persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[0];
  const restore = async () => {
    const backend = new PersistenceService({ backend: 'file', filePath }); await backend.initialize(); backends.push(backend); return make(backend);
  };
  return { persistence, context, lifecycle, reference, references: committed.plan.steps.map(step => ({ sessionId: 'session', stepId: step.stepId })),
    service, make, restore, state, step, calls, route, snapshot, session, unavailable };
}

test('all explicitly targeted agents answer independently and the route completes only after every answer', async t => {
  const f = await fixture(t, undefined, ['architect', 'reviewer']);
  assert.equal(f.references.length, 2);
  assert.equal(new Set(f.state().intentPlanStepsBySession.session.map((row: any) => row.localKey)).size, 2);
  await f.service.process(f.references[0]);
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'applying');
  f.service.onModuleDestroy(); // File backend restart has one active writer.
  const restored = await f.restore(); await restored.process(f.references[1]);
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'applied');
  assert.deepEqual(f.calls.map(row => row.agent.id), ['architect', 'reviewer']);
  assert.equal(new Set(f.calls.map(row => row.operationId)).size, 2);
  assert.equal(f.state().sessions[0].status, 'PAUSED');
  const responses = f.state().eventsBySession.session.filter((row: any) => row.type === 'agent_message');
  assert.deepEqual(responses.map((row: any) => row.fromAgentId), ['architect', 'reviewer']);
  for (const ref of f.references) await restored.process(ref);
  assert.equal(f.calls.length, 2);
});

test('a sibling success or claim cannot hide an earlier target failure', async t => {
  const f = await fixture(t, async input => input.agent.id === 'architect'
    ? { status: 'failed', error: { code: 'MODEL_ERROR', retryable: false, details: { httpStatus: 401 } } }
    : { status: 'completed', output: answer }, ['architect', 'reviewer']);
  for (const ref of f.references) await f.service.process(ref);
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'failed');
  assert.deepEqual(f.state().intentPlanStepsBySession.session.map((row: any) => row.status), ['failed', 'completed']);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'agent_message').length, 1);
});

test('an unavailable explicit target fails visibly without substituting the coordinator', async t => {
  const f = await fixture(t, undefined, ['architect', 'reviewer']); f.unavailable.add('architect');
  for (const ref of f.references) await f.service.process(ref);
  assert.deepEqual(f.calls.map(row => row.agent.id), ['reviewer']);
  assert.equal(f.step().failureCode, 'INTENT_ANSWER_TARGET_UNAVAILABLE');
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'failed');
});

test('concurrent executors claim each target once and enforce the actual runtime agent identity', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async input => {
    const identity = { ...input, agent: { agentId: input.agent.id } };
    assert.doesNotThrow(() => assertIntentExecutionCurrent(f.state(), identity));
    assert.throws(() => assertIntentExecutionCurrent(f.state(), { ...identity, agent: { agentId: 'coordinator' } }), /INTENT_RESPONSE_AGENT_MISMATCH/);
    return { status: 'completed', output: answer };
  }, ['architect', 'reviewer']);
  await Promise.all(f.references.flatMap(ref => [f.service.process(ref), f.make().process(ref)]));
  assert.equal(f.calls.length, 2); assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'applied');
});

test('a correction hold invalidates every outstanding targeted answer before publication', async t => {
  const releases: Array<(value: any) => void> = []; let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, async () => new Promise(resolve => { releases.push(resolve); if (releases.length === 2) ready(); }), ['a', 'b']);
  const running = Promise.all(f.references.map(ref => f.service.process(ref))); await started;
  await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    (draft.intentRoutingRecordsBySession as any).session[0].dispatchHold = { correctionId: 'new', executionEpoch: 2, reason: 'correction', createdAt: new Date().toISOString() };
  });
  releases.forEach(resolve => resolve({ status: 'completed', output: answer })); await running;
  assert.ok(f.state().intentPlanStepsBySession.session.every((row: any) => row.status === 'invalidated'));
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'agent_message').length, 0);
});

test('a stored answer recovers after a sibling completes without repeating either model call', async t => {
  const f = await fixture(t, undefined, ['a', 'b']); const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => {
    if (state.eventsBySession?.session?.some((row: any) => row.id === `intent-answer:${f.references[0].stepId}`)) throw new Error('targeted answer write failure');
    return write(state);
  };
  try { await assert.rejects(f.service.process(f.references[0]), /targeted answer write failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  await f.service.process(f.references[1]); assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'applying');
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => { (draft.intentPlanStepsBySession as any).session[0].processing.leaseExpiresAt = new Date(0).toISOString(); });
  f.service.onModuleDestroy(); const restored = await f.restore(); await restored.process(f.references[0]);
  assert.equal(f.calls.length, 2); assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'applied');
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'agent_message').length, 2);
});

test('paused answer publishes exactly once without tasks, tools, resume or business admission changes', async t => {
  const f = await fixture(t); await f.service.process(f.reference); await f.make().process(f.reference);
  assert.equal(f.calls.length, 1); assert.equal(f.step().status, 'completed');
  assert.equal(f.state().eventsBySession.session.filter((event: any) => event.id === `intent-answer:${f.reference.stepId}`).length, 1);
  assert.equal(f.state().eventOutbox.filter((row: any) => row.id === `outbox:intent-answer:${f.reference.stepId}`).length, 1);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.state().sessions[0].status, 'PAUSED');
  assert.equal(f.lifecycle.get('session')?.admission, 'closed'); assert.equal(f.lifecycle.generation('session'), 1);
  assert.equal(f.calls[0].admissionClass, 'response'); assert.equal(f.calls[0].intentStepId, f.reference.stepId);
  assert.equal(f.calls[0].taskRequiresCodeChanges, false); assert.deepEqual(f.calls[0].workspace.capabilities, { read: false, write: false, command: false, test: false });
  const envelope = f.calls[0].contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'hash', profileRevision: 1 }, toolCatalog: { catalogHash: 'tools' } });
  assert.equal(envelope.L1.currentUserMessage, f.session.originalInput); assert.equal(envelope.L3.files.length, 0);
});

test('two executor instances reserve one response while a model request is outstanding', async t => {
  let resolve!: (value: any) => void; let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  const f = await fixture(t, async () => { started(); return new Promise(done => { resolve = done; }); });
  const pending = f.service.process(f.reference); await ready;
  await f.make().process(f.reference); assert.equal(f.calls.length, 1);
  resolve({ status: 'completed', output: answer }); await pending;
  assert.equal(f.step().status, 'completed'); assert.equal(f.calls.length, 1);
});

test('one schema repair retains the same operation, deadline and original question', async t => {
  let count = 0;
  const f = await fixture(t, async () => ++count === 1 ? { status: 'completed', output: { ...answer, messageKind: 'handoff', targetAgentIds: ['invented'] } } : { status: 'completed', output: answer });
  await f.service.process(f.reference);
  assert.equal(f.calls.length, 2); assert.equal(f.step().status, 'completed'); assert.equal(f.step().processing?.attemptsUsed, 2);
  assert.equal(f.calls[0].operationId, f.calls[1].operationId); assert.equal(f.calls[0].operationDeadlineAt, f.calls[1].operationDeadlineAt);
  assert.notEqual(f.calls[0].invocationId, f.calls[1].invocationId);
  const envelope = f.calls[1].contextEnvelopeFactory({ identity: {}, toolCatalog: {} });
  assert.ok(envelope.L5.bullets.some((text: string) => text.includes('Repair structured output')));
  assert.equal(envelope.L1.currentUserMessage, f.session.originalInput);
});

test('repeated invalid outputs and authentication failures terminate without fake answers or budget resets', async t => {
  for (const mode of ['invalid', 'auth']) {
    const f = await fixture(t, async () => mode === 'invalid' ? { status: 'completed', output: { invalid: true } } :
      { status: 'failed', error: { code: 'HTTP_401', retryable: true } });
    await f.service.process(f.reference); await f.make().process(f.reference);
    assert.equal(f.calls.length, mode === 'invalid' ? 2 : 1); assert.equal(f.step().status, 'failed');
    assert.equal(f.state().eventsBySession.session.filter((event: any) => event.type === 'agent_message').length, 0);
    assert.equal(f.state().eventsBySession.session.filter((event: any) => event.id.startsWith('intent-answer-failed:')).length, 1);
  }
});

test('hold, changed generation and deletion discard late answers before atomic publication', async t => {
  for (const mode of ['hold', 'generation', 'delete']) {
    let resolve!: (value: any) => void; let started!: () => void;
    const ready = new Promise<void>(done => { started = done; });
    const f = await fixture(t, async () => { started(); return new Promise(done => { resolve = done; }); });
    const pending = f.service.process(f.reference); await ready;
    if (mode === 'hold') await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
      (draft.intentRoutingRecordsBySession as any).session[0].dispatchHold = { correctionId: 'new', executionEpoch: 2, reason: 'correction', createdAt: new Date().toISOString() };
    });
    if (mode === 'generation') await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => { (draft.sessionLifecyclesBySession as any).session.generation++; });
    if (mode === 'delete') await f.lifecycle.beginDelete('session', 'epoch', 'delete');
    resolve({ status: 'completed', output: answer }); await pending;
    assert.equal(f.state().eventsBySession.session.filter((event: any) => event.type === 'agent_message').length, 0, mode);
    assert.notEqual(f.step().status, 'completed', mode);
  }
});

test('response event write failure preserves a durable result and restart publishes without another model call', async t => {
  const f = await fixture(t); const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => {
    if (state.eventsBySession?.session?.some((event: any) => event.id === `intent-answer:${f.reference.stepId}`)) throw new Error('answer disk failure');
    return write(state);
  };
  try { await assert.rejects(f.service.process(f.reference), /answer disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.step().status, 'running'); assert.equal(f.step().processing?.result?.content, answer.content);
  assert.equal(f.state().eventsBySession.session.filter((event: any) => event.type === 'agent_message').length, 0);
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => { (draft.intentPlanStepsBySession as any).session[0].processing.leaseExpiresAt = new Date(0).toISOString(); });
  await (await f.restore()).process(f.reference); assert.equal(f.calls.length, 1);
  assert.equal(f.state().intentPlanStepsBySession.session[0].status, 'completed');
});

test('an expired deadline or an unsettled old process never resets the budget on recovery', async t => {
  for (const mode of ['deadline', 'active']) {
    const f = await fixture(t);
    await f.persistence.mutateCollections(['intentPlanStepsBySession', 'logicalOperationsBySession'], draft => {
      const step = (draft.intentPlanStepsBySession as any).session[0]; step.status = 'running';
      step.processing = { ownerId: 'old', attemptsUsed: 1, leaseExpiresAt: new Date(0).toISOString(),
        deadlineAt: new Date(mode === 'deadline' ? 0 : Date.now() + 60_000).toISOString() };
      if (mode === 'active') draft.logicalOperationsBySession = { session: [{ id: `answer:${step.id}`, activeInvocationId: 'outstanding' }] };
    });
    await f.make().process(f.reference); assert.equal(f.calls.length, 0);
    assert.equal(f.step().status, mode === 'deadline' ? 'failed' : 'reconciliation_required');
    assert.equal(f.step().processing?.attemptsUsed, 1);
  }
});

test('Retry-After is durable and a delay outside the total budget does not trigger another request', async t => {
  for (const delay of [1000, 999_999]) {
    const f = await fixture(t, async () => ({ status: 'failed', error: { code: 'HTTP_429', retryable: true, details: { retryAfterMs: delay } } }));
    await f.service.process(f.reference);
    assert.equal(f.calls.length, 1);
    if (delay === 1000) {
      assert.equal(f.step().status, 'running');
      assert.ok(Date.parse(f.step().processing!.retryAt!) > Date.now());
      assert.equal(f.step().processing?.attemptsUsed, 1);
    } else assert.equal(f.step().status, 'failed');
    f.service.onModuleDestroy();
  }
});

test('a deadline expiring during the model call finishes failed and never publishes the late content', async t => {
  const f = await fixture(t, async () => {
    await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
      (draft.intentPlanStepsBySession as any).session[0].processing.deadlineAt = new Date(0).toISOString();
    });
    return { status: 'completed', output: answer };
  });
  await f.service.process(f.reference);
  assert.equal(f.step().status, 'failed'); assert.equal(f.step().failureCode, 'INTENT_RESPONSE_BUDGET_EXHAUSTED');
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'failed');
  assert.equal(f.state().eventsBySession.session.filter((event: any) => event.type === 'agent_message').length, 0);
});

test('durable response admission is restricted to its active bound answer step', async t => {
  const f = await fixture(t, async input => {
    const store = new LogicalOperationStore(f.persistence);
    const operation = { id: input.operationId, sessionId: 'session', phase: input.phase, admissionClass: input.admissionClass,
      dataEpoch: input.dataEpoch, intentStepId: input.intentStepId, executionBinding: input.executionBinding };
    await store.begin(operation); await store.reserve('session', operation.id, input.invocationId, { admissionClass: 'response' });
    await assert.rejects(store.begin({ ...operation, id: 'wrong-phase', phase: 'task_execution' }), /ADMISSION_INVALID/);
    await assert.rejects(store.begin({ ...operation, id: 'wrong-step', intentStepId: 'invented' }), /STEP_STALE/);
    await store.settle('session', operation.id, input.invocationId);
    return { status: 'completed', output: answer };
  });
  await f.service.process(f.reference); assert.equal(f.step().status, 'completed');
  const store = new LogicalOperationStore(f.persistence);
  await assert.rejects(store.begin({ id: 'late', sessionId: 'session', phase: 'user_message_response', admissionClass: 'response',
    dataEpoch: 'epoch', intentStepId: f.reference.stepId, executionBinding: f.step().step.executionBinding }), /STEP_STALE/);
});
