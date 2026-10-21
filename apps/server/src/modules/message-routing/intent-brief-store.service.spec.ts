import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { intentUnderstandingExample, validateRuntimeOutput, type IntentPlanStepRecord, type IntentRouteRevision,
  type SessionDetail, type TaskBriefOutput } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { deriveIntentBriefStep, IntentBriefStoreService } from './intent-brief-store.service.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';

const output: TaskBriefOutput = { schemaVersion: '1.0', kind: 'task_brief', goal: '实现登录', scope: ['登录'], outOfScope: [],
  constraints: [], acceptanceCriteria: ['验证登录'], risks: [], openQuestions: [], suggestedTasks: [{ title: '建议实现', description: '等待单独执行授权',
    suggestedAgentKey: null, routingMode: 'coordinator_controlled', assignmentReason: null, contextRequirements: [], verificationPlan: [], riskNotes: [],
    requiresUserConfirmation: false, dependsOnTaskTitles: [], acceptanceCriteria: [] }] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-brief-')), filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize(); const backends = [persistence];
  t.after(async () => { for (const backend of backends) await backend.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const now = new Date().toISOString();
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', title: '登录', originalInput: '实现登录',
    intentContractVersion: 'intent-understanding-v1', status: 'AGENT_DISCUSSING', tokenUsed: 0, participatingAgentIds: [], createdAt: now, updatedAt: now };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('eventsBySession', { session: [{ id: 'source', sessionId: 'session', type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: now, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } }] });
  await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  const context = new ContextManagementService(persistence), understanding = structuredClone(intentUnderstandingExample);
  Object.assign(understanding.segments[0], { dialogueAct: 'command', scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item',
    contextPolicy: 'clean_task_context', requestedEffects: [], evidence: [{ refId: 'request', sourceEventId: 'source', start: 0, end: session.originalInput.length, quote: session.originalInput }] });
  const route = await context.createRoutingRecord({ session, sourceEventId: 'source', idempotencyKey: 'message', rolloutMode: 'enforce_all_current_epoch' });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'source', currentMessage: session.originalInput, latestEventSeq: 1 });
  const proposed = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ sessionId: session.id, routingId: route.id, snapshotId: snapshot.id });
  // Exercise the real WorkItem/plan commit. Add the server-derived step inside
  // that same transaction, before immutable revision validation and persistence.
  const mutate = persistence.mutateCollections.bind(persistence);
  let derivedId = '';
  persistence.mutateCollections = ((keys: any, action: any, options: any) => mutate(keys, (draft: any) => {
    const result = action(draft);
    const version: IntentRouteRevision | undefined = draft.intentRouteRevisionsBySession?.session?.[0];
    if (version?.validatedPlan?.outcome === 'applicable' && version.validatedPlan.steps.length === 1) {
      const derived = deriveIntentBriefStep(version.validatedPlan); derivedId = derived.stepId;
      version.validatedPlan.steps.push(derived);
      draft.intentRoutingRecordsBySession.session[0].semanticPlan = structuredClone(version.validatedPlan);
      draft.intentRoutingRecordsBySession.session[0].actionStatus = 'pending';
      const step: IntentPlanStepRecord = { id: derived.stepId, sessionId: session.id, dataEpoch: session.dataEpoch, routingId: route.id, intentRevision: 1,
        localKey: derived.segmentKey, step: derived, status: 'running', reusedEffectIds: [], createdAt: now, updatedAt: now,
        processing: { ownerId: 'owner', invocationId: 'invocation', attemptsUsed: 1, deadlineAt: new Date(Date.now() + 120000).toISOString(), leaseExpiresAt: new Date(Date.now() + 30000).toISOString() } };
      draft.intentPlanStepsBySession.session.push(step);
    }
    return result;
  }, options)) as typeof persistence.mutateCollections;
  try { await new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never)
    .commit({ sessionId: session.id, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: proposed.routingRevision! }); }
  finally { persistence.mutateCollections = mutate; }
  assert.ok(derivedId);
  const reference = { sessionId: session.id, stepId: derivedId, ownerId: 'owner', invocationId: 'invocation' };
  const restore = async () => { const backend = new PersistenceService({ backend: 'file', filePath }); await backend.initialize(); backends.push(backend); return new IntentBriefStoreService(backend); };
  return { persistence, reference, store: new IntentBriefStoreService(persistence), restore, state: () => JSON.parse(readFileSync(filePath, 'utf8')) };
}

test('brief draft, suggested tasks, confirmation and outbox publish atomically without granting execution', async t => {
  const f = await fixture(t); await f.store.saveResult(f.reference, 'coordinator', output);
  const [first, replay] = await Promise.all([f.store.publish(f.reference), f.store.publish(f.reference)]);
  assert.equal(first.idempotentReplay, false); assert.equal(replay.idempotentReplay, true); assert.equal(first.brief.id, replay.brief.id);
  const state = f.state(); assert.equal(state.briefsBySession.session.length, 1); assert.equal(first.brief.confirmedByUser, false);
  assert.equal(state.sessions[0].status, 'WAIT_USER_CONFIRM'); assert.equal(state.sessions[0].currentTaskBriefId, first.brief.id);
  assert.equal(state.suggestedTasksByBriefId[first.brief.id][0].requiresUserConfirmation, true);
  assert.equal(state.tasksBySession?.session?.length ?? 0, 0); assert.equal(state.artifacts?.length ?? 0, 0);
  assert.equal(state.eventOutbox.filter((row: any) => first.events.some(event => row.id === `outbox:${event.id}`)).length, 2);
  assert.equal(state.eventsBySession.session.filter((row: any) => row.type === 'user_confirmation_requested').length, 1);
});

test('stored brief survives publication failure and File restart without model replay or duplicate confirmation', async t => {
  const f = await fixture(t); await f.store.saveResult(f.reference, 'coordinator', output);
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => { if (state.briefsBySession?.session?.length) throw new Error('injected brief write failure'); return write(state); };
  try { await assert.rejects(f.store.publish(f.reference), /injected brief write failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.state().sessions[0].status, 'AGENT_DISCUSSING'); assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0);
  assert.equal(f.state().eventsBySession.session.some((row: any) => row.type === 'user_confirmation_requested'), false);
  assert.ok(f.state().intentPlanStepsBySession.session[1].processing.briefResult);
  const restored = await f.restore(), result = await restored.publish(f.reference); assert.equal(result.idempotentReplay, false);
  assert.equal((await restored.publish(f.reference)).idempotentReplay, true);
});

test('model constraints remain unconfirmed questions and never silently become authoritative constraints', async t => {
  const f = await fixture(t); await f.store.saveResult(f.reference, 'coordinator', { ...output, constraints: ['模型自行提出的 10 分钟约束'] });
  const result = await f.store.publish(f.reference); assert.deepEqual(result.brief.constraints, []);
  assert.deepEqual(result.brief.openQuestions, ['待确认约束：模型自行提出的 10 分钟约束']);
});

for (const change of ['hold', 'generation', 'pause', 'epoch', 'lease', 'decision', 'predecessor'] as const) test(`brief publication rejects ${change} changes without partial effects`, async t => {
  const f = await fixture(t); await f.store.saveResult(f.reference, 'coordinator', output);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession', 'intentPlanStepsBySession', 'workItemsBySession', 'decisionRecordsBySession'], (draft: any) => {
    if (change === 'hold') draft.intentRoutingRecordsBySession.session[0].dispatchHold = { correctionId: 'new', executionEpoch: 2, reason: 'correction', createdAt: new Date().toISOString() };
    if (change === 'generation') draft.sessionLifecyclesBySession.session.generation++;
    if (change === 'pause') draft.sessions[0].status = 'PAUSED';
    if (change === 'epoch') draft.workItemsBySession.session[0].executionEpoch++;
    if (change === 'lease') draft.intentPlanStepsBySession.session[1].processing.leaseExpiresAt = new Date(0).toISOString();
    if (change === 'predecessor') draft.intentPlanStepsBySession.session[0].status = 'invalidated';
    if (change === 'decision') {
      (draft.decisionRecordsBySession ??= {}).session = [{ id: 'decision', sessionId: 'session', workItemId: draft.workItemsBySession.session[0].id,
        status: 'confirmed', kind: 'constraint', revision: 1, content: '新的约束' }];
    }
  });
  await assert.rejects(f.store.publish(f.reference), /INTENT_/);
  assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0); assert.equal(f.state().sessions[0].currentTaskBriefId, undefined);
});

test('brief candidate cannot replace a stored result or accept an invalid/unbounded output', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.saveResult(f.reference, 'coordinator', { ...output, extra: true }), /INTENT_BRIEF_OUTPUT_INVALID/);
  await assert.rejects(f.store.saveResult(f.reference, 'coordinator', { ...output, goal: 'x'.repeat(100001) }), /INTENT_BRIEF_OUTPUT_INVALID/);
  await assert.rejects(f.store.saveResult({ ...f.reference, invocationId: 'old' }, 'coordinator', output), /INTENT_BRIEF_STEP_STALE/);
  await f.store.saveResult(f.reference, 'coordinator', output);
  await assert.rejects(f.store.saveResult(f.reference, 'coordinator', { ...output, goal: '另一个需求' }), /INTENT_BRIEF_RESULT_CONFLICT/);
  assert.equal(f.state().intentPlanStepsBySession.session[1].processing.briefResult.output.goal, output.goal);
  const understanding = structuredClone(intentUnderstandingExample);
  Object.assign(understanding.segments[0], { suggestedAction: 'prepare_brief' });
  assert.equal(validateRuntimeOutput('intent_understanding', understanding).valid, false);
});

test('runtime admission rejects parent-only authority, another phase and an obsolete physical invocation', async t => {
  const f = await fixture(t), state = f.state(), step = state.intentPlanStepsBySession.session[1];
  const identity = { sessionId: 'session', dataEpoch: 'epoch', admissionClass: 'business' as const, phase: 'brief_generation',
    intentStepId: step.id, invocationId: 'invocation', workItemId: step.step.target.workItemId,
    executionBinding: step.step.executionBinding, effectScope: step.step.effectScope };
  assert.doesNotThrow(() => assertIntentExecutionCurrent(state, identity));
  for (const patch of [{ intentStepId: undefined }, { intentStepId: state.intentPlanStepsBySession.session[0].id },
    { invocationId: 'obsolete' }, { phase: 'task_execution' }]) {
    assert.throws(() => assertIntentExecutionCurrent(state, { ...identity, ...patch }), /INTENT_BRIEF_STEP_STALE/);
  }
  const modified = structuredClone(state); modified.intentPlanStepsBySession.session[1].step.goal = 'forged';
  assert.throws(() => assertIntentExecutionCurrent(modified, identity), /INTENT_BRIEF_STEP_STALE/);
});
