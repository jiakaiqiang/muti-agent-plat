import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { intentUnderstandingExample, type CollaborationEvent, type IntentPlanStepRecord, type IntentRouteRevision,
  type IntentRoutingRecord, type IntentUnderstandingOutput, type SessionDetail, type SessionFollowUpMessage } from '@agent-cluster/shared';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';
import { IntentAuthorizationRetryService } from './intent-authorization-retry.service.js';
import { issueTestAuthority, testRunnerBinding } from './intent-test-authority.js';
import { seedApprovedResume } from './intent-resume.fixture.js';
import { seedFailedRetry } from './intent-retry.fixture.js';

test('R8 production retry binds the real failure checkpoint and dispatches the shared port once', async t => {
  const f = await fixture(t, 'constraint', output => {
    Object.assign(output.segments[0], { dialogueAct: 'command', suggestedAction: 'retry_failed_step', requestedEffects: [] });
  }, false, async (store, workId) => {
    await store.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'decisionRecordsBySession', 'tasksBySession', 'briefsBySession', 'workItemsBySession', 'intentRoutingRecordsBySession',
      'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession', 'runtimeInvocationsBySession'], draft => {
      seedFailedRetry(draft, (draft.sessions as SessionDetail[])[0], (draft.workItemsBySession as any).session.find((row: any) => row.id === workId));
    });
  });
  const calls: unknown[] = [];
  const service = new IntentPlanCommitService(f.persistence, f.registry as never, undefined, undefined, undefined, undefined,
    { available: true, dispatch: async (input: unknown) => { calls.push(input); } } as never);
  const result = await service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable', result.plan.validation.errorCodes.join(','));
  await service.commit(f.input);
  assert.equal(calls.length, 1);
  assert.equal((f.steps().find(row => row.step.action === 'retry_failed_step') as any).retryBinding.task.taskId, 'original-task');
});

for (const blocker of ['no executor', 'candidate', 'CLI', 'budget'] as const) test(`R8 production retry blocks ${blocker} with zero dispatches`, async t => {
  const f = await fixture(t, 'constraint', output => {
    Object.assign(output.segments[0], { dialogueAct: 'command', suggestedAction: 'retry_failed_step', requestedEffects: [] });
  }, false, async (store, workId) => {
    await store.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'decisionRecordsBySession', 'tasksBySession', 'briefsBySession',
      'workItemsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession',
      'logicalOperationsBySession', 'runtimeInvocationsBySession'], (draft: any) => {
      const session = draft.sessions[0];
      seedFailedRetry(draft, session, draft.workItemsBySession.session.find((row: any) => row.id === workId));
      if (blocker === 'candidate') draft.runtimeInvocationsBySession.session[0].executionCandidate = { id: 'candidate' };
      if (blocker === 'CLI') {
        draft.runtimeInvocationsBySession.session[0].runtimeType = 'codex'; session.activeRecoveryCheckpoint.retryBinding.failure.runtimeType = 'codex';
      }
      if (blocker === 'budget') draft.logicalOperationsBySession.session[0].inputBudgetDecisions = [
        { status: 'pending', dataEpoch: session.dataEpoch, sessionGeneration: 1 }];
    });
  });
  let dispatches = 0;
  const service = new IntentPlanCommitService(f.persistence, f.registry as never, undefined, undefined, undefined, undefined,
    blocker === 'no executor' ? undefined : { available: true, dispatch: async () => { dispatches++; } } as never);
  const before = ['sessions', 'tasksBySession', 'logicalOperationsBySession'].map(key => f.persistence.getCollection(key, {}));
  if (blocker === 'budget') {
    await assert.rejects(service.commit(f.input), /INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED/);
    assert.deepEqual(['sessions', 'tasksBySession', 'logicalOperationsBySession'].map(key => f.persistence.getCollection(key, {})), before);
  } else {
    const result = await service.commit(f.input);
    assert.equal(result.plan.outcome, 'blocked');
    assert.ok(result.plan.validation.errorCodes.includes(blocker === 'no executor' ? 'INTENT_ACTION_EXECUTOR_UNAVAILABLE' :
      blocker === 'candidate' ? 'INTENT_RETRY_STEP_UNSUPPORTED' : 'INTENT_RETRY_RECONCILIATION_REQUIRED'));
    if (blocker === 'candidate') {
      const events = f.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session;
      assert.ok(JSON.stringify(events).includes('/sessions/session/workspace-writebacks/:writebackId/resolve'));
    }
  }
  assert.equal(dispatches, 0);
});

async function controlFixture(t: TestContext, action: 'resume' | 'enqueue_follow_up', active = true) {
  return fixture(t, 'constraint', output => {
    Object.assign(output.segments[0], { dialogueAct: 'command', suggestedAction: action, requestedEffects: [] });
  }, false, async (persistence, workItemId) => {
    await persistence.mutateCollections(['sessions', 'tasksBySession', 'briefsBySession', 'workItemsBySession', 'intentRoutingRecordsBySession',
      'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession', 'decisionRecordsBySession'], draft => {
      const session = (draft.sessions as SessionDetail[])[0];
      session.intentContractVersion = 'intent-understanding-v1';
      session.status = action === 'resume' ? 'PAUSED' : 'EXECUTING';
      session.currentTaskBriefId = 'approved-brief';
      session.pauseState = { previousStatus: 'EXECUTING', pausedAt: session.createdAt, reason: 'pause' };
      if (action === 'resume') seedApprovedResume(draft, session,
        (draft.workItemsBySession as Record<string, import('@agent-cluster/shared').WorkItem[]>).session.find(row => row.id === workItemId)!);
      if (active && action === 'enqueue_follow_up') draft.tasksBySession = { session: [{ id: 'executing-task',
        sessionId: 'session', workItemId, status: 'running' }] };
    });
  });
}

test('R7 pure resume commits and invokes the shared resume control exactly once', async t => {
  const f = await controlFixture(t, 'resume');
  const calls: unknown[] = [];
  const control = { available: true, dispatch: async (input: unknown) => { calls.push(input); } };
  const service = new (IntentPlanCommitService as any)(f.persistence, f.registry, undefined, undefined, undefined, undefined, control);
  const result = await service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable', result.plan.validation.errorCodes.join(','));
  await service.commit(f.input);
  assert.equal(calls.length, 1);
});

test('R7 active empty continuation acknowledges without dispatch, tasks or requirement changes', async t => {
  const f = await controlFixture(t, 'enqueue_follow_up');
  const before = f.persistence.getCollection('tasksBySession', {});
  const invocations = f.persistence.getCollection('runtimeInvocationsBySession', {});
  const followUps = f.persistence.getCollection('followUpMessagesBySession', {});
  let dispatches = 0;
  const executor = { schedule: () => { dispatches++; } };
  const service = new IntentPlanCommitService(f.persistence, f.registry as never, undefined, executor as never,
    executor as never, executor as never, { available: true, dispatch: async () => { dispatches++; } } as never);
  const work = f.context.listWorkItems('session');
  const result = await service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable', result.plan.validation.errorCodes.join(','));
  assert.equal(result.routing.actionStatus, 'applied');
  assert.equal(f.steps()[0].status, 'completed');
  await service.commit(f.input);
  assert.equal(dispatches, 0);
  assert.deepEqual(f.persistence.getCollection('tasksBySession', {}), before);
  assert.deepEqual(f.persistence.getCollection('runtimeInvocationsBySession', {}), invocations);
  assert.deepEqual(Object.fromEntries(Object.entries(f.persistence.getCollection<Record<string, SessionFollowUpMessage[]>>('followUpMessagesBySession', {}))
    .map(([id, rows]) => [id, rows.map(row => row.id)])), Object.fromEntries(Object.entries(followUps as Record<string, SessionFollowUpMessage[]>)
    .map(([id, rows]) => [id, rows.map(row => row.id)])), 'no new FollowUp is created; the input routing envelope may be consumed');
  assert.deepEqual(f.context.listWorkItems('session'), work);
  assert.equal(f.events().filter(event => ['task_created', 'task_assigned', 'task_started'].includes(event.type)).length, 0);
});

test('R7 an EXECUTING state with no active work is blocked instead of acknowledged', async t => {
  const f = await controlFixture(t, 'enqueue_follow_up', false);
  const result = await f.service.commit(f.input);
  assert.equal(result.plan.outcome, 'blocked');
  assert.deepEqual(result.plan.validation.errorCodes, ['INTENT_CONTINUATION_NOT_ACTIVE']);
  assert.equal(f.steps().length, 0);
});

test('R7 natural-language continuation cannot bypass the structured budget card', async t => {
  for (const action of ['resume', 'enqueue_follow_up'] as const) {
    const f = await controlFixture(t, action);
    await f.persistence.mutateCollections(['logicalOperationsBySession'], draft => {
      const map = (draft.logicalOperationsBySession ??= {}) as Record<string, any[]>;
      (map.session ??= []).push({ id: 'budget-hold', sessionId: 'session', inputBudgetDecisions: [
        { id: 'decision', status: 'pending', dataEpoch: 'epoch', sessionGeneration: 1 }] });
    });
    const session = f.persistence.getCollection('sessions', []), tasks = f.persistence.getCollection('tasksBySession', {});
    const holds = f.persistence.getCollection('logicalOperationsBySession', {});
    await assert.rejects(f.service.commit(f.input), /INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED/);
    assert.deepEqual(f.persistence.getCollection('sessions', []), session);
    assert.deepEqual(f.persistence.getCollection('tasksBySession', {}), tasks);
    assert.deepEqual(f.persistence.getCollection('logicalOperationsBySession', {}), holds);
  }
});

async function fixture(t: TestContext, kind: 'answer' | 'initial' | 'related' | 'constraint' = 'answer',
  change?: (output: IntentUnderstandingOutput) => void, shadow = false,
  beforeSnapshot?: (persistence: PersistenceService, parentId?: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-plan-commit-'));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1, decisionLedgerRevision: 0,
    title: '计划', originalInput: '解释当前系统的意图路由', status: 'PAUSED', tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  const event: CollaborationEvent = { id: 'message-1', sessionId: session.id, type: 'user_message', content: session.originalInput, toAgentIds: [],
    createdAt: session.createdAt, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { text: session.originalInput } } };
  await persistence.setCollection('eventsBySession', { session: [event] });
  await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  const context = new ContextManagementService(persistence);
  const parent = ['related', 'constraint'].includes(kind) ? await context.ensureInitialWorkItem(session, 'parent-message', '原任务') : undefined;
  const old = parent ? await context.recordDecision({ session, workItemId: parent.id, sourceEventId: 'parent-constraint', kind: 'constraint', content: '已有约束' }) : undefined;
  const output = structuredClone(intentUnderstandingExample);
  const base = output.segments[0];
  if (kind !== 'answer') output.segments.splice(0, output.segments.length, { ...base, dialogueAct: kind === 'constraint' ? 'constraint' : 'command', requestedEffects: [],
    scopeRelation: kind === 'initial' ? 'initial_requirement' : kind === 'related' ? 'related_new_requirement' : 'same_requirement',
    suggestedAction: kind === 'initial' ? 'create_initial_work_item' : kind === 'related' ? 'create_related_work_item' : 'record_constraint',
    contextPolicy: kind === 'initial' ? 'clean_task_context' : kind === 'related' ? 'inherit_selected' : 'inherit_confirmed',
    target: { ...base.target, workItemId: parent?.id ?? null, decisionIds: kind === 'related' ? [old!.id] : [] } });
  change?.(output);
  const route = await context.createRoutingRecord({ session, sourceEventId: event.id, idempotencyKey: 'route', rolloutMode: shadow ? 'shadow' : 'enforce_all_current_epoch' });
  const follow: SessionFollowUpMessage = { id: 'follow', routingId: route.id, sourceEventId: event.id, content: event.content,
    status: 'queued', queuedAt: event.createdAt, mentionedAgentIds: [], handlingPlan: { intent: 'clarification', priority: 'normal',
      shouldPause: false, affectedTaskIds: [], affectedAgentIds: [], requiresBriefRevision: false, requiresUserConfirmation: false, coordinatorInstruction: '' } };
  await context.saveFollowUp(session.id, follow);
  await persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].pendingFollowUpMessages = [follow]; });
  await beforeSnapshot?.(persistence, parent?.id);
  Object.assign(session, persistence.getCollection<SessionDetail[]>('sessions', [])[0]);
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: event.id, currentMessage: event.content, latestEventSeq: 1 });
  const classifier = new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding: output }) } as never);
  const proposal = await classifier.classify({ sessionId: session.id, routingId: route.id, snapshotId: snapshot.id });
  const registry = { listAll: () => [{ type: 'generic_llm' }] };
  const service = new IntentPlanCommitService(persistence, registry as never);
  const input = { sessionId: session.id, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: proposal.routingRevision! };
  const versions = () => persistence.getCollection<Record<string, IntentRouteRevision[]>>('intentRouteRevisionsBySession', {}).session ?? [];
  const steps = () => persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session ?? [];
  const events = () => persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session ?? [];
  return { persistence, context, session, parent, old, route, snapshot, service, input, versions, steps, events, filePath, registry };
}

async function firstTestFixture(t: TestContext, granted = false) {
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  t.after(() => { if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  let output: IntentUnderstandingOutput;
  const f = await fixture(t, 'initial', value => { output = value; }, false, async persistence => {
    await persistence.mutateCollections(['sessions'], draft => {
      const session = (draft.sessions as SessionDetail[])[0];
      session.status = 'AGENT_DISCUSSING'; session.intentContractVersion = 'intent-understanding-v1';
      session.workingDirectory = { id: 'workspace', kind: 'server_local', path: tmpdir(), name: 'fixture', selectedAt: 'selected' };
      session.workspaceContext = { indexComplete: true, binding: { workspaceId: 'workspace', providerKind: 'server_local', displayName: 'fixture',
        capabilities: { read: true, write: false, command: false, test: true }, boundAt: 'bound', boundRevision: { id: 'revision', observedAt: 'observed' } } };
      const binding = testRunnerBinding(session, 'test')!;
      output.segments[0].requestedEffects.splice(0, output.segments[0].requestedEffects.length,
        { kind: 'run_tests', target: { kind: 'test_runner', refId: binding.resourceId }, evidenceRefs: ['request'] },
        { kind: 'write_artifact', target: { kind: 'artifact', refId: `test-report:${binding.bindingHash}` }, evidenceRefs: ['request'] }
      );
      if (granted) session.intentTestAuthority = issueTestAuthority(session, 'test', 'grant', 1, true);
    });
  });
  const scheduled: string[] = [];
  const registry = { listAll: () => [{ type: 'test_runner' }] };
  const executor = { schedule: (ref: { stepId: string }) => scheduled.push(ref.stepId) };
  const commit = new IntentPlanCommitService(f.persistence, registry as never, undefined, undefined, executor as never);
  const retry = new IntentAuthorizationRetryService(f.persistence, f.context, commit);
  const route = () => f.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {}).session.find(row => row.id === f.route.id)!;
  const request = () => ({ contractVersion: 'intent-authorization-retry-v1' as const, dataEpoch: 'epoch', expectedRoutingRevision: route().routingRevision!, idempotencyKey: 'retry' });
  const grant = () => f.persistence.mutateCollections(['sessions'], draft => {
    const session = (draft.sessions as SessionDetail[])[0]; session.intentTestAuthority = issueTestAuthority(session, 'test', 'grant', 1, true); session.revision!++;
  });
  return { ...f, commit, retry, scheduled, request, grant, currentRoute: route, testRegistry: registry, executor };
}

test('first test request atomically creates its task and executable step, without a Brief', async t => {
  const f = await firstTestFixture(t, true);
  const result = await f.commit.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable', result.plan.validation.errorCodes.join(','));
  assert.equal(f.context.listWorkItems('session').length, 1); assert.equal(f.steps()[0].status, 'queued');
  assert.equal(f.steps()[0].step.target.workItemId, f.context.listWorkItems('session')[0].id);
  assert.equal(f.scheduled.length, 1); assert.deepEqual(f.persistence.getCollection('briefsBySession', {}), {});
});

test('explicit authorization retry reuses the exact semantic proposal, commits once and survives reload', async t => {
  const f = await firstTestFixture(t);
  const blocked = await f.commit.commit(f.input), before = f.currentRoute();
  assert.deepEqual(blocked.plan.validation.errorCodes, ['EFFECT_NOT_AUTHORIZED']);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.scheduled.length, 0);
  assert.ok(f.events().find(row => row.metadata.payload?.authorizationRetry));
  const request = f.request();
  await assert.rejects(f.retry.retry('session', f.route.id, 'user', request), /INTENT_AUTHORIZATION_RETRY_BLOCKED/);
  await f.grant(); assert.equal(f.steps().length, 0);
  const results = await Promise.all([f.retry.retry('session', f.route.id, 'user', request), f.retry.retry('session', f.route.id, 'user', request)]);
  assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
  assert.equal(f.context.listWorkItems('session').length, 1); assert.equal(f.steps().length, 1);
  assert.deepEqual(f.versions().map(row => [row.intentRevision, row.authorizationState]), [[1, 'unknown'], [2, 'validated']]);
  assert.deepEqual(f.versions()[0].validatedPlan, blocked.plan);
  assert.deepEqual(f.currentRoute().semanticProposal?.understanding, before.semanticProposal?.understanding);
  assert.deepEqual(f.currentRoute().attemptLog, before.attemptLog); assert.equal(f.currentRoute().classificationAttempts, before.classificationAttempts);
  assert.equal(f.currentRoute().authorizationRetryReceipts?.length, 1);
  assert.equal(f.events().filter(row => row.type === 'intent_plan_committed').length, 1);
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restored.initialize(); t.after(() => restored.onModuleDestroy());
  const replay = await new IntentAuthorizationRetryService(restored, new ContextManagementService(restored),
    new IntentPlanCommitService(restored, f.testRegistry as never, undefined, undefined, f.executor as never)).retry('session', f.route.id, 'user', request);
  assert.equal(replay.idempotentReplay, true); assert.equal(replay.plan.planId, results[0].plan.planId);
  await assert.rejects(f.retry.retry('session', f.route.id, 'user', { ...request, expectedRoutingRevision: request.expectedRoutingRevision + 1 }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
});

test('authorization retry rejects client plans, stale revisions, epoch/actor mismatch and never resumes paused work', async t => {
  const f = await firstTestFixture(t); await f.commit.commit(f.input); await f.grant();
  const request = f.request();
  for (const input of [{ ...request, plan: {} }, { ...request, contractVersion: undefined }]) await assert.rejects(f.retry.retry('session', f.route.id, 'user', input), /INPUT_INVALID/);
  await assert.rejects(f.retry.retry('session', f.route.id, 'other', request), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.retry.retry('session', f.route.id, 'user', { ...request, dataEpoch: 'other' }), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.retry.retry('session', f.route.id, 'user', { ...request, expectedRoutingRevision: 999 }), /REVISION_CONFLICT/);
  await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].status = 'PAUSED'; });
  await assert.rejects(f.retry.retry('session', f.route.id, 'user', request), /AUTHORIZATION_RETRY_BLOCKED/);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.steps().length, 0);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
});

test('authorization retry cannot bypass semantic ambiguity, shadow evaluation or a correction hold', async t => {
  for (const mode of ['ambiguity', 'shadow', 'hold'] as const) {
    const f = await firstTestFixture(t); await f.commit.commit(f.input); await f.grant();
    const request = f.request();
    await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
      const route = (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>).session[0];
      if (mode === 'ambiguity') route.semanticPlan!.validation.errorCodes.push('INTENT_AMBIGUOUS');
      if (mode === 'shadow') route.rolloutMode = 'shadow';
      if (mode === 'hold') route.dispatchHold = { correctionId: 'held', reason: 'intent_correction', since: new Date().toISOString() } as never;
    });
    await assert.rejects(f.retry.retry('session', f.route.id, 'user', request), /AUTHORIZATION_RETRY_UNAVAILABLE/);
    assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.scheduled.length, 0);
  }
});

test('retry rollback preserves the blocked plan and no task, step, receipt or dispatch survives a failed commit', async t => {
  const f = await firstTestFixture(t); await f.commit.commit(f.input); await f.grant();
  const request = f.request(), before = f.currentRoute();
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => {
    if (state.intentRouteRevisionsBySession?.session?.length) throw new Error('retry commit disk failure'); return write(state);
  };
  try { await assert.rejects(f.retry.retry('session', f.route.id, 'user', request), /retry commit disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.deepEqual(f.currentRoute(), before); assert.equal(f.versions().length, 0); assert.equal(f.steps().length, 0);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.scheduled.length, 0);
  assert.equal((await f.retry.retry('session', f.route.id, 'user', request)).plan.outcome, 'applicable');
});

test('workspace rebinding and changed task relationships cannot be repaired by silently rewriting the original proposal', async t => {
  for (const mode of ['workspace', 'work', 'generation', 'authority-race'] as const) {
    const f = await firstTestFixture(t); await f.commit.commit(f.input); await f.grant(); const request = f.request();
    if (mode === 'workspace') await f.persistence.mutateCollections(['sessions'], draft => {
      const session = (draft.sessions as SessionDetail[])[0]; session.workspaceContext!.binding.boundAt = 'new-binding';
      session.intentTestAuthority = issueTestAuthority(session, 'test', 'new-grant', 2, true);
    });
    if (mode === 'work') await f.persistence.mutateCollections(['sessions', 'workItemsBySession'], draft => {
      (draft.sessions as SessionDetail[])[0].activeWorkItemId = 'another';
      draft.workItemsBySession = { session: [{ id: 'another', sessionId: 'session', title: 'another', goal: 'another', status: 'OPEN', revision: 1,
        createdFromEventId: 'another-message', inheritedDecisionIds: [], inheritedArtifactIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    });
    if (mode === 'generation') await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
      (draft.sessionLifecyclesBySession as Record<string, { generation: number }>).session.generation++;
    });
    if (mode === 'authority-race') {
      const original = f.context.buildIntentSnapshot.bind(f.context);
      f.context.buildIntentSnapshot = async input => { const result = await original(input);
        await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].intentTestAuthority!.grant.revokedAt = new Date().toISOString(); });
        return result; };
    }
    await assert.rejects(f.retry.retry('session', f.route.id, 'user', request), /AUTHORIZATION_RETRY_BLOCKED|SNAPSHOT_STALE|PROPOSAL_UNAVAILABLE/, mode);
    assert.equal(f.steps().length, 0); assert.equal(f.versions().length, 0); assert.equal(f.currentRoute().authorizationRetryReceipts, undefined);
  }
});

test('answer plan commits one immutable revision and queued step without creating a WorkItem or claiming execution success', async t => {
  const f = await fixture(t);
  const result = await f.service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable');
  assert.equal(result.routing.status, 'ROUTED');
  assert.equal(result.routing.actionStatus, 'pending');
  assert.equal(f.steps()[0].status, 'queued');
  assert.equal(f.steps()[0].step.target.workItemId, null);
  assert.deepEqual(f.steps()[0].step.effectScope.effects.map(row => row.kind), ['answer']);
  assert.equal(f.context.listWorkItems('session').length, 0);
  assert.equal(f.versions().length, 1);
  assert.deepEqual(f.versions()[0].authorityGrants, []);
  assert.equal(f.context.listFollowUps('session')[0].status, 'cancelled');
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  const event = f.events().find(row => row.type === 'intent_plan_committed')!;
  assert.ok(f.persistence.getCollection<Array<{ id: string }>>('eventOutbox', []).some(row => row.id === `outbox:${event.id}`));
});

test('answer dispatch is scheduled only after the complete plan transaction is durable', async t => {
  const f = await fixture(t);
  let scheduled = 0;
  const service = new IntentPlanCommitService(f.persistence, f.registry as never, undefined, { schedule: (reference: { stepId: string }) => {
    scheduled++;
    assert.equal(f.steps()[0].id, reference.stepId); assert.equal(f.steps()[0].status, 'queued');
    assert.equal(f.versions().length, 1);
    assert.ok(f.events().some(event => event.type === 'intent_plan_committed'));
  } } as never);
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('plan disk failure'); };
  try { await assert.rejects(service.commit(f.input), /plan disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(scheduled, 0);
  await service.commit(f.input); assert.equal(scheduled, 1);
});

test('all targeted answer steps commit atomically and none dispatches after a failed write', async t => {
  const f = await fixture(t, 'answer', output => output.segments[0].target.agentIds.push('a', 'b'), false, async persistence => {
    await persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].participatingAgentIds = ['a', 'b']; });
  });
  const scheduled: string[] = [];
  const service = new IntentPlanCommitService(f.persistence, f.registry as never, undefined, { schedule: (reference: { stepId: string }) => {
    scheduled.push(reference.stepId); assert.equal(f.steps().length, 2); assert.equal(f.versions()[0].validatedPlan?.steps.length, 2);
  } } as never);
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('targeted disk failure'); };
  try { await assert.rejects(service.commit(f.input), /targeted disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.steps().length, 0); assert.equal(f.versions().length, 0); assert.equal(scheduled.length, 0);
  await service.commit(f.input); assert.equal(scheduled.length, 2);
});

test('concurrent initial plan commits create exactly one task context with stable step, event and receipt identities', async t => {
  const f = await fixture(t, 'initial');
  const another = new IntentPlanCommitService(f.persistence, f.registry as never);
  const results = await Promise.all([f.service.commit(f.input), another.commit(f.input)]);
  assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
  assert.equal(results[0].plan.planId, results[1].plan.planId);
  const works = f.context.listWorkItems('session');
  assert.equal(works.length, 1);
  assert.equal(f.steps()[0].step.target.workItemId, works[0].id);
  assert.equal(f.steps()[0].status, 'completed');
  assert.equal(f.versions().length, 1);
  assert.equal(f.events().filter(row => row.type === 'intent_plan_committed').length, 1);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].activeWorkItemId, works[0].id);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  assert.deepEqual(f.persistence.getCollection('briefsBySession', {}), {});
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restored.initialize(); t.after(() => restored.onModuleDestroy());
  const replay = await new IntentPlanCommitService(restored, f.registry as never).commit(f.input);
  assert.equal(replay.idempotentReplay, true); assert.equal(replay.plan.planId, results[0].plan.planId);
});

test('a matching execution binding cannot turn a non-applicable plan into execution authority', async t => {
  const f = await fixture(t);
  await f.service.commit(f.input);
  const state = JSON.parse(readFileSync(f.filePath, 'utf8'));
  const binding = f.steps()[0].step.executionBinding;
  const identity = { sessionId: 'session', dataEpoch: 'epoch', sessionGeneration: binding.sessionGeneration, executionBinding: binding };
  assert.doesNotThrow(() => assertIntentExecutionCurrent(state, identity));
  assert.throws(() => assertIntentExecutionCurrent(state, { ...identity, effectScope: { ...f.steps()[0].step.effectScope,
    effects: [{ kind: 'modify_source', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['request'] }] } }), /INTENT_EXECUTION_SCOPE_STALE/);
  state.intentRouteRevisionsBySession.session[0].validatedPlan.outcome = 'blocked';
  assert.throws(() => assertIntentExecutionCurrent(state, identity), /INTENT_EXECUTION_SCOPE_STALE/);
});

test('CAS, actor, stale business facts and generation changes cannot commit a new plan', async t => {
  for (const mode of ['revision', 'actor', 'snapshot', 'generation'] as const) {
    const f = await fixture(t, 'initial');
    if (mode === 'snapshot') await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].revision!++; });
    if (mode === 'generation') await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
      (draft.sessionLifecyclesBySession as Record<string, { generation: number }>).session.generation++;
    });
    await assert.rejects(f.service.commit({ ...f.input, expectedRoutingRevision: mode === 'revision' ? 999 : f.input.expectedRoutingRevision,
      actorId: mode === 'actor' ? 'other' : 'user' }), /INTENT_PLAN_REVISION_CONFLICT|INTENT_SESSION_UNAVAILABLE|SNAPSHOT_STALE|INTENT_PROPOSAL_UNAVAILABLE/);
    assert.equal(f.context.listWorkItems('session').length, 0);
    assert.equal(f.versions().length, 0);
    assert.equal(f.context.listFollowUps('session')[0].status, 'queued');
  }
});

test('source-changing effects remain unauthorized even with high confidence and legacy requiresCodeChanges', async t => {
  const f = await fixture(t, 'initial', output => { Object.assign(output, { modelConfidence: 1 });
    output.segments[0] = { ...output.segments[0], requestedEffects: [{ kind: 'modify_source', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['request'] }] };
  });
  await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].requiresCodeChanges = true; });
  const result = await f.service.commit(f.input);
  assert.notEqual(result.plan.outcome, 'applicable');
  assert.ok(result.plan.validation.errorCodes.includes('EFFECT_NOT_AUTHORIZED'));
  assert.equal(f.versions().length, 0); assert.equal(f.steps().length, 0);
  assert.equal(f.context.listWorkItems('session').length, 0);
});

test('all multi-intent segments and dependency order survive clarification with no partial plan execution', async t => {
  const f = await fixture(t, 'answer', output => { const first = output.segments[0];
    output.segments.push({ ...first, localKey: 'second', goal: '再检查第二个问题', dependencies: [{ segmentKey: first.localKey, condition: 'execution_completed' }] });
  });
  const result = await f.service.commit(f.input);
  assert.equal(result.plan.outcome, 'needs_clarification'); assert.equal(result.plan.steps.length, 2);
  assert.equal(f.versions().length, 0); assert.equal(f.steps().length, 0);
  const event = f.events().find(row => row.type === 'intent_plan_clarification_required')!;
  assert.equal((event.metadata.payload?.segments as unknown[]).length, 2);
  const review = event.metadata.payload?.multiSegmentReview as any;
  assert.equal(review.mode, 'clarify_only'); assert.equal(review.routingId, f.route.id);
  assert.equal(review.sourceEventId, f.snapshot.sourceEventId); assert.equal(review.dataEpoch, 'epoch');
  assert.deepEqual(review.understanding, result.routing.semanticProposal!.understanding);
  assert.equal(review.understanding.segments[1].dependencies[0].segmentKey, review.understanding.segments[0].localKey);
  const outbox = f.persistence.getCollection<any[]>('eventOutbox', []).find(row => row.id === `outbox:${event.id}`);
  assert.deepEqual(outbox.payload.event.metadata.payload.multiSegmentReview, review);
  await f.service.commit(f.input);
  assert.equal(f.events().filter(row => row.metadata.payload?.multiSegmentReview).length, 1);
  assert.equal(f.context.listWorkItems('session').length, 0);
});

test('eight-segment diagnostic retains all effects and prohibitions across File reload, without creating a partial step', async t => {
  const f = await fixture(t, 'answer', output => {
    const base = structuredClone(output.segments[0]);
    output.segments.splice(0, output.segments.length, ...Array.from({ length: 8 }, (_, index): IntentUnderstandingOutput['segments'][number] => ({ ...structuredClone(base), localKey: `part-${index}`, goal: `问题 ${index + 1}`,
      prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: 'workspace' }, scope: 'message', evidenceRefs: ['request'] }],
      dependencies: index ? [{ segmentKey: `part-${index - 1}`, condition: 'execution_completed' as const }] : [] })));
  });
  const result = await f.service.commit(f.input);
  assert.notEqual(result.plan.outcome, 'applicable'); assert.equal(f.steps().length, 0);
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restored.initialize(); t.after(() => restored.onModuleDestroy());
  const event = restored.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session.find(row => row.metadata.payload?.multiSegmentReview)!;
  const review = event.metadata.payload!.multiSegmentReview as any;
  assert.deepEqual(review.understanding, result.routing.semanticProposal!.understanding);
  assert.equal(review.understanding.segments.length, 8); assert.equal(review.understanding.segments[7].prohibitions.length, 1);
  assert.deepEqual(restored.getCollection('intentPlanStepsBySession', {}), {});
});

test('related task creation inherits only the selected confirmed constraints and keeps parent unchanged', async t => {
  const f = await fixture(t, 'related');
  const parent = structuredClone(f.context.getWorkItem('session', f.parent!.id));
  const result = await f.service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable');
  const child = f.context.listWorkItems('session').find(row => row.id !== parent.id)!;
  assert.equal(child.parentWorkItemId, parent.id);
  assert.deepEqual(child.inheritedDecisionIds, [f.old!.id]);
  assert.deepEqual(f.context.getWorkItem('session', parent.id), parent);
  assert.equal(f.context.validDecisions('session', child.id)[0].content, '已有约束');
});

test('constraint commit updates requirement and ledger bindings; active target is blocked without mutating constraints', async t => {
  for (const busy of [false, true]) {
    const f = await fixture(t, 'constraint');
    if (busy) await f.persistence.setCollection('logicalOperationsBySession', { session: [{ id: 'running', workItemId: f.parent!.id, admissionClass: 'business', activeInvocationId: 'process' }] });
    const result = await f.service.commit(f.input);
    if (busy) {
      assert.equal(result.plan.outcome, 'blocked'); assert.ok(result.plan.validation.errorCodes.includes('INTENT_TARGET_REQUIRES_STOP'));
      assert.equal(f.context.validDecisions('session', f.parent!.id).length, 1); assert.equal(f.versions().length, 0);
    } else {
      assert.equal(result.plan.outcome, 'applicable');
      assert.equal(f.context.validDecisions('session', f.parent!.id).length, 2);
      assert.equal(f.steps()[0].step.executionBinding.requirementRevision, 2);
      assert.equal(f.context.getWorkItem('session', f.parent!.id).requirementRevision, 2);
      assert.equal(f.steps()[0].step.executionBinding.executionEpoch, 2);
      assert.throws(() => assertIntentExecutionCurrent(JSON.parse(readFileSync(f.filePath, 'utf8')),
        { sessionId: 'session', workItemId: f.parent!.id, dataEpoch: 'epoch' }), /INTENT_EXECUTION_BINDING_REQUIRED/);
    }
  }
});

test('shadow compilation does not create work, ledger, steps, business events or consume the old follow-up', async t => {
  const f = await fixture(t, 'initial', undefined, true);
  const previousEvents = f.events();
  const result = await f.service.commit(f.input);
  assert.equal(result.plan.outcome, 'applicable');
  assert.equal(f.context.listWorkItems('session').length, 0);
  assert.equal(f.versions().length, 0); assert.equal(f.steps().length, 0);
  assert.deepEqual(f.events(), previousEvents);
  assert.equal(f.context.listFollowUps('session')[0].status, 'queued');
  assert.equal(result.routing.effectiveIntentRevision, undefined);
  assert.equal((await f.service.commit(f.input)).idempotentReplay, true);
});

test('plan persistence failure rolls back task, plan, step, queue consumption and outbox atomically', async t => {
  const f = await fixture(t, 'initial');
  const bytes = readFileSync(f.filePath, 'utf8');
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('plan disk failure'); };
  try { await assert.rejects(f.service.commit(f.input), /plan disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(readFileSync(f.filePath, 'utf8'), bytes);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.versions().length, 0);
  assert.equal(f.context.listFollowUps('session')[0].status, 'queued');
  assert.equal((await f.service.commit(f.input)).plan.outcome, 'applicable');
});

test('invented evidence or absent answer runtime never yields an executable revision', async t => {
  for (const mode of ['source', 'quote', 'runtime', 'missing']) {
    const f = await fixture(t, 'answer', output => {
      if (mode === 'source') output.segments[0] = { ...output.segments[0], evidence: [{ ...output.segments[0].evidence[0], sourceEventId: 'foreign' }] };
      if (mode === 'quote') output.segments[0] = { ...output.segments[0], evidence: [{ ...output.segments[0].evidence[0], quote: 'invented' }] };
      if (mode === 'missing') output.segments[0] = { ...output.segments[0], requestedEffects: [], evidence: [] };
    });
    if (mode === 'runtime') f.registry.listAll = () => [];
    const result = await f.service.commit(f.input);
    assert.equal(result.plan.outcome, mode === 'runtime' ? 'blocked' : 'rejected');
    assert.equal(f.versions().length, 0); assert.equal(f.steps().length, 0);
  }
});

test('artifact inheritance requires a bounded snapshot candidate and live parent ownership in the current epoch', async t => {
  for (const mode of ['parent', 'sibling', 'late', 'deleted', 'epoch', 'foreign'] as const) {
    const f = await fixture(t, 'related', output => {
      output.segments[0] = { ...output.segments[0], target: { ...output.segments[0].target, artifactIds: ['artifact'] } };
    }, false, async (persistence, parentId) => {
      const artifact = { id: 'artifact', dataEpoch: mode === 'epoch' ? 'old-epoch' : 'epoch',
        sessionId: mode === 'foreign' ? 'other-session' : 'session', workItemId: mode === 'sibling' ? 'sibling' : parentId,
        type: 'document', title: '父任务产物', contentSummary: '仅引用已提供内容', createdAt: new Date().toISOString() };
      if (mode === 'sibling') await persistence.mutateCollections(['workItemsBySession'], draft => {
        const works = (draft.workItemsBySession as Record<string, any[]>).session;
        works.push({ ...works[0], id: 'sibling', title: '其他任务' });
      });
      await persistence.setCollection('artifacts', { artifactsById: mode === 'late' ? {} : { artifact }, artifactIdsBySession: { session: mode === 'late' ? [] : ['artifact'] } });
    });
    if (mode === 'late') await f.persistence.setCollection('artifacts', { artifactsById: { artifact: {
      id: 'artifact', dataEpoch: 'epoch', sessionId: 'session', workItemId: f.parent!.id, type: 'document', title: '后来产物', createdAt: new Date().toISOString()
    } }, artifactIdsBySession: { session: ['artifact'] } });
    if (mode === 'deleted') await f.persistence.setCollection('artifacts', { artifactsById: {}, artifactIdsBySession: { session: [] } });
    const result = await f.service.commit(f.input);
    if (mode === 'parent') {
      assert.equal(result.plan.outcome, 'applicable');
      assert.deepEqual(f.context.listWorkItems('session').find(row => row.parentWorkItemId === f.parent!.id)?.inheritedArtifactIds, ['artifact']);
    } else {
      assert.notEqual(result.plan.outcome, 'applicable', mode);
      assert.equal(f.versions().length, 0, mode);
      assert.equal(f.context.listWorkItems('session').filter(row => row.parentWorkItemId).length, 0, mode);
    }
  }
});

test('artifact candidates cap summaries and report omissions rather than exposing the entire archive', async t => {
  const f = await fixture(t, 'related', undefined, false, async (persistence, parentId) => {
    const artifacts = Array.from({ length: 20 }, (_, index) => ({ id: `artifact-${index}`, sessionId: 'session', dataEpoch: 'epoch',
      workItemId: parentId, title: 'a'.repeat(1000), contentSummary: 'b'.repeat(2000), type: 'document', createdAt: new Date().toISOString() }));
    await persistence.setCollection('artifacts', { artifactsById: Object.fromEntries(artifacts.map(row => [row.id, row])),
      artifactIdsBySession: { session: artifacts.map(row => row.id) } });
  });
  assert.equal(f.snapshot.validArtifacts?.length, 16);
  assert.equal(f.snapshot.omittedArtifacts, 4);
  assert.ok(f.snapshot.validArtifacts?.every(row => row.title.length === 200 && row.contentSummary?.length === 400));
  assert.deepEqual(f.snapshot.validArtifactIds, f.snapshot.validArtifacts?.map(row => row.id));
});
