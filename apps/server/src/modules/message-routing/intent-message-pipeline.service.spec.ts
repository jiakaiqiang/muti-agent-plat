import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { intentUnderstandingExample, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { IntentMessagePipelineService } from './intent-message-pipeline.service.js';
import { IntentCorrectionService } from './intent-correction.service.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import { IntentWorkspaceAuthorityService } from './intent-workspace-authority.service.js';
import { IntentRecognitionRetryService } from './intent-recognition-retry.service.js';
import { InputBudgetStore } from '../runtimes/input-budget-store.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';

async function fixture(t: TestContext, mode = 'answer') {
  const directory = mkdtempSync(join(tmpdir(), 'intent-ingress-')); const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  const services: IntentMessagePipelineService[] = [];
  t.after(async () => { services.forEach(service => service.onModuleDestroy()); await persistence.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1,
    intentContractVersion: 'intent-understanding-v1', title: '首轮', originalInput: '解释当前系统的意图路由', status: 'AGENT_DISCUSSING',
    tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const context = new ContextManagementService(persistence); let calls = 0; const inputs: any[] = [];
  const semantic = { understand: async (input: any) => {
    calls++;
    inputs.push(input);
    if (mode === 'input_budget') {
      const operation = await new LogicalOperationStore(persistence).begin({ id: input.operationId, sessionId: 'session',
        phase: 'user_message_routing', admissionClass: 'routing', dataEpoch: 'epoch' });
      const plan = makeInvocationPlan({ operation, sessionId: 'session', phase: 'user_message_routing',
        inputBudgetPolicy: { actorId: 'user', dataEpoch: 'epoch', sessionGeneration: operation.sessionGeneration!,
          kind: 'intent_understanding', routingId: input.routingId, routingRevision: input.routingRevision,
          slot: `routing:${input.routingId}:${input.snapshot.id}` } });
      try { await new InputBudgetStore(persistence).assert(plan, { estimatedInputTokens: 8404, outputReservationTokens: 1500,
        maxInputTokens: 6000, effectiveMaxInputTokens: 5400, safetyMarginTokens: 600 }, true); }
      catch (error: any) { return { status: 'failed', code: 'INTENT_INPUT_BUDGET_EXCEEDED', failureClass: 'budget',
        retryable: false, retryAfterMs: 0, inputBudgetDecision: error.inputBudgetDecision }; }
    }
    if (mode === 'auth') return { status: 'failed', code: 'HTTP_401', failureClass: 'auth', retryable: true, retryAfterMs: 0 };
    if (mode === 'schema') return { status: 'invalid', previousOutput: '{}', validationErrors: ['segments required'] };
    if (mode === 'stale' && calls === 1) await persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].revision!++; });
    const output = structuredClone(intentUnderstandingExample);
    output.segments[0] = { ...output.segments[0], goal: input.snapshot.currentMessage,
      evidence: [{ refId: 'request', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] };
    if (mode === 'read') output.segments[0] = { ...output.segments[0], requestedEffects: [...output.segments[0].requestedEffects,
      { kind: 'read_workspace', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['request'] }] };
    if (mode === 'initial') output.segments[0] = { ...output.segments[0], dialogueAct: 'command', scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', requestedEffects: [] };
    if (mode === 'ambiguous') output.ambiguityReasons.push('需要明确目标');
    if (mode === 'constraint') output.segments[0] = { ...output.segments[0], dialogueAct: 'constraint', scopeRelation: 'same_requirement',
      suggestedAction: 'record_constraint', contextPolicy: 'inherit_confirmed', requestedEffects: [],
      target: { ...output.segments[0].target, workItemId: input.snapshot.activeWorkItemId } };
    if (mode.startsWith('correction')) {
      const old = input.snapshot.validDecisions[0];
      const candidate = input.snapshot.correctionCandidates.find((row: any) => row.decisionIds.includes(old.id));
      output.segments[0] = { ...output.segments[0], dialogueAct: 'correction', scopeRelation: 'same_requirement',
        suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed', requestedEffects: [],
        target: { ...output.segments[0].target, workItemId: input.snapshot.activeWorkItemId,
          correctionOfRoutingId: input.correction?.routingId ?? candidate?.routingId },
        correction: { supersedesDecisionId: old.id, expectedDecisionRevision: old.revision, replacementText: input.snapshot.currentMessage } };
      if (mode === 'correction-foreign') output.segments[0] = { ...output.segments[0], target: { ...output.segments[0].target, correctionOfRoutingId: 'invented' } };
    }
    return { status: 'valid', understanding: output };
  } };
  const classifier = new IntentUnderstandingRoutingService(persistence, context, semantic as never);
  const planner = new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never);
  const correctionPlanner = new IntentCorrectionPlannerService(persistence, context, semantic as never);
  t.after(() => correctionPlanner.onModuleDestroy());
  const corrections = new IntentCorrectionService(persistence, undefined, undefined, correctionPlanner);
  corrections.schedule = () => {};
  const make = () => { const service = new IntentMessagePipelineService(persistence, context, classifier, planner, undefined, corrections); service.schedule = () => {}; services.push(service); return service; };
  const service = make();
  const input = { session, first: true, content: session.originalInput, idempotencyKey: 'first', rolloutMode: 'enforce_all_current_epoch' as const };
  const state = () => JSON.parse(readFileSync(filePath, 'utf8'));
  return { service, make, input, persistence, filePath, context, state, corrections, inputs, setMode: (value: string) => { mode = value; }, calls: () => calls };
}

async function blockedRecognition(t: TestContext, mode = 'auth') {
  const f = await fixture(t, mode), accepted = await f.service.accept(f.input);
  const reference = { sessionId: 'session', routingId: accepted.routing.id };
  await f.service.process(reference);
  const current = () => f.context.listRoutingRecords('session').find(row => row.id === reference.routingId)!;
  assert.equal(current().status, 'BLOCKED');
  const request = () => ({ contractVersion: 'intent-recognition-retry-v1' as const, dataEpoch: 'epoch',
    expectedRoutingRevision: current().routingRevision!, idempotencyKey: 'recognize-again' });
  const retry = new IntentRecognitionRetryService(f.persistence, f.service);
  return { ...f, reference, current, request, retry };
}

test('input-budget continue retains snapshot, operation and attempt history; end rejects only original message', async t => {
  for (const decision of ['continue', 'end'] as const) {
    const f = await blockedRecognition(t, 'input_budget'), original = f.current();
    const beforeSession = f.state().sessions[0];
    assert.equal(original.blockedReason, 'INTENT_INPUT_BUDGET_EXCEEDED');
    assert.equal(original.leaseOwner, undefined);
    const request = { ...f.request(), inputBudget: { decisionId: original.inputBudgetDecision!.id, decision } };
    await assert.rejects(f.retry.retry('session', original.id, 'user', f.request()), /INPUT_BUDGET_DECISION_REQUIRED/);
    const result = await f.retry.retry('session', original.id, 'user', request);
    assert.equal(result.routing.status, decision === 'end' ? 'REJECTED' : 'SNAPSHOT_READY');
    assert.equal(result.routing.snapshotId, original.snapshotId);
    assert.equal(result.routing.classificationAttempts, original.classificationAttempts);
    assert.deepEqual(result.routing.attemptLog, original.attemptLog);
    assert.equal(result.receipt.operationId, original.id);
    assert.equal(f.state().sessions[0].status, beforeSession.status);
    assert.equal((await f.retry.retry('session', original.id, 'user', request)).idempotentReplay, true);
    if (decision === 'continue') {
      f.setMode('answer'); await f.service.process(f.reference);
      assert.equal(f.current().status, 'ROUTED');
      assert.equal(f.inputs[1].snapshot.id, f.inputs[0].snapshot.id);
    } else {
      await f.service.process(f.reference); assert.equal(f.calls(), 1);
    }
  }
});

test('explicit recognition retry preserves the failed operation, original input and budget history without granting execution', async t => {
  const f = await blockedRecognition(t), old = f.current(), request = f.request();
  assert.equal(f.calls(), 1, '401 never retries automatically');
  const requested = await f.retry.retry('session', f.reference.routingId, 'user', request);
  assert.equal(requested.routing.status, 'RECEIVED'); assert.equal(f.calls(), 1, 'acceptance is not recognition success');
  assert.equal(requested.receipt.previous.classificationAttempts, 1);
  assert.deepEqual(requested.receipt.previous.attemptLog, old.attemptLog);
  assert.equal(requested.receipt.previousOperationId, old.id); assert.notEqual(requested.receipt.operationId, old.id);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'user_message').length, 1);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'intent_recognition_retry_requested').length, 1);
  f.setMode('answer'); await f.service.process(f.reference);
  assert.equal(f.current().status, 'ROUTED'); assert.equal(f.calls(), 2); assert.equal(f.current().classificationAttempts, 1);
  assert.equal(f.inputs[1].operationId, requested.receipt.operationId);
  assert.equal(f.inputs[1].snapshot.currentMessage, f.inputs[0].snapshot.currentMessage);
  assert.equal(f.inputs[1].snapshot.sourceEventId, f.inputs[0].snapshot.sourceEventId);
  assert.equal(f.context.listWorkItems('session').length, 0); assert.deepEqual(f.state().briefsBySession ?? {}, {});
  assert.ok(f.state().eventOutbox.some((row: any) => row.eventType === 'intent_recognition_retry_requested'));
  const replay = await f.retry.retry('session', f.reference.routingId, 'user', request);
  assert.equal(replay.idempotentReplay, true); assert.equal(f.calls(), 2); assert.equal(replay.receipt.id, requested.receipt.id);
});

test('concurrent explicit retries commit one new operation and conflicting requests or owners cannot reuse a receipt', async t => {
  const f = await blockedRecognition(t), request = f.request();
  const results = await Promise.all([f.retry.retry('session', f.reference.routingId, 'user', request),
    new IntentRecognitionRetryService(f.persistence, f.make()).retry('session', f.reference.routingId, 'user', request)]);
  assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
  assert.equal(f.current().recognitionRetryReceipts?.length, 1);
  await assert.rejects(f.retry.retry('session', f.reference.routingId, 'user', { ...request, expectedRoutingRevision: request.expectedRoutingRevision + 1 }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  await assert.rejects(f.retry.retry('session', f.reference.routingId, 'other', request), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.retry.retry('session', f.reference.routingId, 'user', { ...request, modelDecision: {} }), /INPUT_INVALID/);
  await assert.rejects(f.retry.retry('session', f.reference.routingId, 'user', { ...request, idempotencyKey: 'new' }), /REVISION_CONFLICT/);
});

test('schema repair allowance is per explicit logical operation and repeated failures remain blocked with separate notices', async t => {
  const f = await blockedRecognition(t, 'schema'); assert.equal(f.calls(), 2);
  const first = await f.retry.retry('session', f.reference.routingId, 'user', f.request());
  await f.service.process(f.reference); assert.equal(f.calls(), 4); assert.equal(f.current().classificationAttempts, 2);
  assert.equal(f.current().status, 'BLOCKED'); assert.equal(first.receipt.previous.classificationAttempts, 2);
  assert.equal(f.current().attemptLog?.filter(row => row.reason === 'schema_repair').length, 1);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'intent_plan_blocked').length, 2);
  assert.equal(f.inputs[0].operationId, f.inputs[1].operationId); assert.equal(f.inputs[2].operationId, f.inputs[3].operationId);
  assert.notEqual(f.inputs[0].operationId, f.inputs[2].operationId);
  const second = await f.retry.retry('session', f.reference.routingId, 'user', { ...f.request(), idempotencyKey: 'second' });
  const replayOld = await f.retry.retry('session', f.reference.routingId, 'user', first.receipt.request);
  assert.equal(replayOld.receipt.operationId, first.receipt.operationId);
  assert.equal(f.current().recognitionOperationId, second.receipt.operationId, 'old receipt cannot restore old operation');
});

test('stale worker timers cannot block or consume the budget of a new recognition operation', async t => {
  const f = await blockedRecognition(t); const oldOperationId = f.reference.routingId;
  await f.retry.retry('session', f.reference.routingId, 'user', f.request());
  const before = f.current(); await f.make().process({ ...f.reference, recognitionOperationId: oldOperationId });
  assert.deepEqual(f.current(), before); assert.equal(f.calls(), 1);
  f.setMode('answer'); await f.service.process(f.reference); assert.equal(f.calls(), 2);
});

test('old runtime preparation cannot begin, reserve or launch after explicit retry, while its settled audit remains intact', async t => {
  const f = await blockedRecognition(t), operations = new LogicalOperationStore(f.persistence);
  const old = { id: f.reference.routingId, sessionId: 'session', dataEpoch: 'epoch', phase: 'user_message_routing' as const, admissionClass: 'routing' as const };
  await operations.begin(old);
  const before = operations.list('session');
  const accepted = await f.retry.retry('session', f.reference.routingId, 'user', f.request());
  await assert.rejects(operations.begin(old), /INTENT_RECOGNITION_SUPERSEDED/);
  await assert.rejects(operations.reserve('session', old.id, 'old-invocation', { admissionClass: 'routing' }), /INTENT_RECOGNITION_SUPERSEDED/);
  await assert.rejects(operations.assertCurrentIntent({ sessionId: 'session', operationId: old.id, admissionClass: 'routing' }), /INTENT_RECOGNITION_SUPERSEDED/);
  await assert.rejects(operations.assertCurrentIntent({ sessionId: 'session', operation: { id: old.id }, admissionClass: 'routing' }), /INTENT_RECOGNITION_SUPERSEDED/);
  assert.deepEqual(operations.list('session'), before);
  const next = await operations.begin({ ...old, id: accepted.receipt.operationId });
  assert.equal(next.attemptsUsed, 0); assert.equal(next.maxAttempts, 2);
});

test('stale snapshot rebuild reservations cannot consume a newly accepted recognition budget', async t => {
  const f = await blockedRecognition(t);
  const accepted = await f.retry.retry('session', f.reference.routingId, 'user', f.request());
  const before = structuredClone(f.current());
  assert.equal(await f.context.reserveRoutingRebuild('session', f.reference.routingId, f.reference.routingId), false);
  assert.equal(await f.context.reserveRoutingRebuild('session', f.reference.routingId), false);
  assert.deepEqual(f.current(), before);
  assert.equal(await f.context.reserveRoutingRebuild('session', f.reference.routingId, accepted.receipt.operationId), true);
  assert.equal(await f.context.reserveRoutingRebuild('session', f.reference.routingId, accepted.receipt.operationId), false);
});

test('recognition retry rollback is atomic and stopped/unknown/deleted/stale states cannot get a new operation', async t => {
  const f = await blockedRecognition(t), before = f.state(), write = (f.persistence as any).writeFileState;
  (f.persistence as any).writeFileState = () => { throw new Error('retry write failure'); };
  try { await assert.rejects(f.retry.retry('session', f.reference.routingId, 'user', f.request()), /retry write failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.deepEqual(f.state(), before);
  for (const mode of ['unknown', 'active-old', 'deleting', 'generation', 'epoch', 'hold'] as const) {
    const g = await blockedRecognition(t);
    await g.persistence.mutateCollections(['sessionLifecyclesBySession', 'intentRoutingRecordsBySession', 'logicalOperationsBySession'], draft => {
      const life = (draft.sessionLifecyclesBySession as any).session;
      if (mode === 'unknown') life.stopStatus = 'unknown';
      if (mode === 'deleting') life.state = 'deleting';
      if (mode === 'generation') life.generation++;
      if (mode === 'active-old') draft.logicalOperationsBySession = { session: [{ id: g.reference.routingId, activeInvocationId: 'old', stopState: 'none' }] };
      if (mode === 'hold') (draft.intentRoutingRecordsBySession as any).session[0].dispatchHold = { correctionId: 'hold' };
    });
    await assert.rejects(g.retry.retry('session', g.reference.routingId, 'user', { ...g.request(), dataEpoch: mode === 'epoch' ? 'old' : 'epoch' }),
      /SESSION_UNAVAILABLE|STOP_UNCONFIRMED|RETRY_UNAVAILABLE/, mode);
    assert.equal(g.current().recognitionRetryReceipts, undefined); assert.equal(g.calls(), 1);
  }
});

test('recovery resumes the accepted operation after a reload without a new receipt or implicit resume', async t => {
  const f = await blockedRecognition(t); await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], draft => {
    (draft.sessions as SessionDetail[])[0].status = 'PAUSED'; const life = (draft.sessionLifecyclesBySession as any).session;
    life.admission = 'closed'; life.stopStatus = 'confirmed';
  });
  const accepted = await f.retry.retry('session', f.reference.routingId, 'user', f.request());
  const backend = new PersistenceService({ backend: 'file', filePath: f.filePath });
  // Use the persisted state file returned by the fixture, not an in-memory pipeline.
  await backend.initialize(); t.after(() => backend.onModuleDestroy());
  const context = new ContextManagementService(backend), inputs: any[] = [];
  const semantic = { understand: async (input: any) => { inputs.push(input); const output = structuredClone(intentUnderstandingExample);
    output.segments[0] = { ...output.segments[0], evidence: [{ refId: 'request', sourceEventId: input.snapshot.sourceEventId,
      start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] }; return { status: 'valid', understanding: output }; } };
  const pipeline = new IntentMessagePipelineService(backend, context, new IntentUnderstandingRoutingService(backend, context, semantic as never),
    new IntentPlanCommitService(backend, { listAll: () => [{ type: 'generic_llm' }] } as never));
  pipeline.schedule = () => {}; t.after(() => pipeline.onModuleDestroy()); await pipeline.process(f.reference);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].operationId, accepted.receipt.operationId);
  assert.equal(context.listRoutingRecords('session')[0].status, 'ROUTED'); assert.equal(backend.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  assert.equal(context.listRoutingRecords('session')[0].recognitionRetryReceipts?.length, 1);
});

function selectWorkspace(session: SessionDetail) {
  session.workingDirectory = { kind: 'server_local', id: 'workspace', name: 'selected', path: 'D:/selected', selectedAt: '2026-10-19T00:00:00Z' };
  session.workspaceContext = { binding: { workspaceId: 'workspace', providerKind: 'server_local', displayName: 'selected',
    capabilities: { read: true, write: true, command: true, test: true }, boundAt: '2026-10-19T00:00:00Z',
    boundRevision: { id: 'first', observedAt: '2026-10-19T00:00:00Z' } }, indexComplete: false };
}

test('authority CAS persists revoke/regrant, rejects replay conflicts and never revives an old plan', async t => {
  const f = await fixture(t, 'read'); selectWorkspace(f.input.session);
  const accepted = await f.service.accept(f.input);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
    const step = (draft.intentPlanStepsBySession as any).session[0]; step.status = 'running';
    step.processing = { ownerId: 'executor', attemptsUsed: 1, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString() };
  });
  const step = f.state().intentPlanStepsBySession.session[0];
  const identity = { sessionId: 'session', dataEpoch: 'epoch', admissionClass: 'response' as const,
    intentStepId: step.id, executionBinding: step.step.executionBinding, effectScope: step.step.effectScope };
  const operations = new LogicalOperationStore(f.persistence);
  await operations.assertCurrentIntent(identity);
  const authority = new IntentWorkspaceAuthorityService(f.persistence);
  const request = { action: 'revoke', dataEpoch: 'epoch', expectedBindingHash: accepted.session.intentWorkspaceReadAuthority!.bindingHash,
    expectedGrantRevision: 1, idempotencyKey: 'revoke-1' };
  const outcomes = await Promise.all([authority.change('session', 'user', request), authority.change('session', 'user', request)]);
  assert.equal(outcomes.filter(result => result.idempotentReplay).length, 1);
  assert.equal(outcomes[0].authority?.grant.revision, 2);
  await assert.rejects(operations.assertCurrentIntent(identity), /INTENT_WORKSPACE_READ_AUTHORITY_STALE/);
  await assert.rejects(authority.change('session', 'user', { ...request, action: 'grant' }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(authority.change('session', 'user', { ...request, idempotencyKey: 'stale' }), /REVISION_CONFLICT/);
  const granted = await authority.change('session', 'user', { ...request, action: 'grant', expectedGrantRevision: 2, idempotencyKey: 'grant-2' });
  assert.equal(granted.authority?.grant.revision, 3); assert.equal(granted.enabled, true);
  await assert.rejects(operations.assertCurrentIntent(identity), /INTENT_WORKSPACE_READ_AUTHORITY_STALE/);
  const replay = await authority.change('session', 'user', request);
  assert.equal(replay.authority?.grant.revision, 3, 'replay returns current state without replaying revocation');
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'intent_workspace_authority_changed').length, 2);
  assert.equal(f.state().eventOutbox.filter((row: any) => row.eventType === 'intent_workspace_authority_changed').length, 2);
});

test('authority rejects injected grants, wrong owner/epoch and rolls back on persistence failure', async t => {
  const f = await fixture(t); selectWorkspace(f.input.session); const accepted = await f.service.accept(f.input);
  const authority = new IntentWorkspaceAuthorityService(f.persistence);
  const input = { action: 'revoke', dataEpoch: 'epoch', expectedBindingHash: accepted.session.intentWorkspaceReadAuthority!.bindingHash,
    expectedGrantRevision: 1, idempotencyKey: 'revoke' };
  await assert.rejects(authority.change('session', 'user', { ...input, grant: {} }), /INPUT_INVALID/);
  await assert.rejects(authority.change('session', 'user', { ...input, action: ['grant'] }), /INPUT_INVALID/);
  await assert.rejects(authority.change('session', 'another', input), /SESSION_UNAVAILABLE/);
  await assert.rejects(authority.change('session', 'user', { ...input, dataEpoch: 'old' }), /SESSION_UNAVAILABLE/);
  const before = f.state(), persist = (f.persistence as any).writeFileState;
  (f.persistence as any).writeFileState = () => { throw new Error('authority write failure'); };
  try { await assert.rejects(authority.change('session', 'user', input), /authority write failure/); }
  finally { (f.persistence as any).writeFileState = persist; }
  assert.deepEqual(f.state(), before);
  assert.equal(authority.view(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0]).authority?.grant.revision, 1);
});

test('source readiness defers classification and atomically binds a workspace before scheduling the original message', async t => {
  const f = await fixture(t, 'read');
  f.input.session.status = 'WAIT_SOURCE_PREPARATION';
  f.input.session.sourceBinding = { state: 'awaiting_base_branch', version: 3, executionLocation: 'server',
    repositoryUrl: 'https://github.com/example/project', workspaceId: 'workspace', cacheKey: 'cache', authorizationRef: 'auth', updatedAt: new Date().toISOString() } as any;
  const accepted = await f.service.accept(f.input);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.calls(), 0); assert.equal(f.context.listRoutingRecords('session')[0].classificationAttempts, undefined);
  const prepared = structuredClone(accepted.session); selectWorkspace(prepared);
  prepared.sourceBinding = { ...prepared.sourceBinding!, state: 'ready', version: 4, baseBranch: 'main', baseSha: 'a'.repeat(40) };
  const scheduled: string[] = []; f.service.schedule = reference => { scheduled.push(reference.routingId); };
  const completed = await f.service.sourceReady(prepared, 3);
  assert.deepEqual(scheduled, [accepted.routing.id]); assert.equal(completed.status, 'AGENT_DISCUSSING');
  assert.equal(completed.intentWorkspaceReadAuthority?.grant.revision, 1);
  const sourceId = completed.intentWorkspaceReadAuthority!.grant.sourceEventId;
  assert.ok(f.state().eventsBySession.session.some((event: any) => event.id === sourceId && event.metadata.payload.sourceReady));
  await assert.rejects(f.service.sourceReady(prepared, 3), /VERSION_CONFLICT/);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.calls(), 1); assert.equal(f.context.listRoutingRecords('session')[0].status, 'ROUTED');
  assert.equal(f.state().intentRouteRevisionsBySession.session[0].authorityGrants[0].sourceEventId, sourceId);
  assert.equal(f.context.listWorkItems('session').length, 0);
});

test('source callback cannot resurrect a deleted session or reset a revoked workspace authority', async t => {
  for (const mode of ['deleted', 'revoked']) {
    const f = await fixture(t); selectWorkspace(f.input.session);
    const accepted = await f.service.accept(f.input);
    const prepared = structuredClone(accepted.session);
    const source = { state: 'awaiting_base_branch', version: 3, executionLocation: 'server', workspaceId: 'workspace',
      repositoryUrl: 'https://github.com/example/project', cacheKey: 'cache', updatedAt: new Date().toISOString() } as any;
    await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], draft => {
      const session = (draft.sessions as SessionDetail[])[0]; session.sourceBinding = source;
      session.intentWorkspaceReadAuthority!.grant.revokedAt = new Date().toISOString();
      if (mode === 'deleted') (draft.sessionLifecyclesBySession as any).session.state = 'deleted';
    });
    prepared.sourceBinding = { ...source, state: 'ready', version: 4 };
    if (mode === 'deleted') await assert.rejects(f.service.sourceReady(prepared, 3), /VERSION_CONFLICT/);
    else assert.ok((await f.service.sourceReady(prepared, 3)).intentWorkspaceReadAuthority?.grant.revokedAt);
  }
});

test('first message, shell, lifecycle and routing are atomic without creating a WorkItem or Brief', async t => {
  const f = await fixture(t);
  const accepted = await f.service.accept(f.input);
  assert.equal(accepted.routing.status, 'RECEIVED'); assert.equal(accepted.routing.semanticContractVersion, 'intent-understanding-v1');
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.calls(), 0);
  assert.equal(f.state().sessions.length, 1); assert.equal(f.state().sessionLifecyclesBySession.session.generation, 1);
  assert.equal(f.state().eventsBySession.session.length, 1); assert.equal(f.state().eventOutbox.length, 1);
  assert.equal((f.state().followUpMessagesBySession?.session ?? []).length, 0);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.context.listRoutingRecords('session')[0].status, 'ROUTED');
  assert.equal(f.state().intentPlanStepsBySession.session[0].status, 'queued');
  assert.equal(f.context.listWorkItems('session').length, 0); assert.ok(!f.state().briefsBySession?.session);
});

test('initial task creation occurs only after compilation and one concurrent idempotent ingress is saved', async t => {
  const f = await fixture(t, 'initial');
  const accepted = await Promise.all([f.service.accept(f.input), f.make().accept(f.input)]);
  assert.equal(accepted.filter(row => row.idempotentReplay).length, 1);
  assert.equal(f.context.listWorkItems('session').length, 0);
  await f.service.process({ sessionId: 'session', routingId: accepted[0].routing.id });
  assert.equal(f.context.listWorkItems('session').length, 1);
  await f.make().process({ sessionId: 'session', routingId: accepted[0].routing.id });
  assert.equal(f.calls(), 1); assert.equal(f.state().intentRouteRevisionsBySession.session.length, 1);
  assert.ok(!f.state().briefsBySession?.session);
  await assert.rejects(f.service.accept({ ...f.input, content: '改变同一键的内容' }), /IDEMPOTENCY_CONFLICT/);
});

test('ingress disk failure rolls back the Session shell and all message projections', async t => {
  const f = await fixture(t); const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('ingress disk failure'); };
  try { await assert.rejects(f.service.accept(f.input), /ingress disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.deepEqual(f.persistence.getCollection('sessions', []), []);
  assert.equal(f.context.listRoutingRecords('session').length, 0); assert.equal(f.calls(), 0);
});

test('authentication failures and semantic ambiguity do not create tasks or invoke the old queue', async t => {
  for (const mode of ['auth', 'ambiguous']) {
    const f = await fixture(t, mode); const accepted = await f.service.accept(f.input);
    await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
    assert.equal(f.context.listRoutingRecords('session')[0].status, mode === 'auth' ? 'BLOCKED' : 'CLARIFICATION_REQUIRED');
    assert.equal(f.calls(), 1); assert.equal(f.context.listWorkItems('session').length, 0);
    assert.equal((f.state().followUpMessagesBySession?.session ?? []).length, 0);
    assert.ok(!f.state().briefsBySession?.session);
  }
});

test('one business snapshot rebuild shares the original two-call budget', async t => {
  const f = await fixture(t, 'stale'); const accepted = await f.service.accept(f.input);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  const route = f.context.listRoutingRecords('session')[0];
  assert.equal(route.status, 'ROUTED'); assert.equal(route.classificationAttempts, 2); assert.equal(route.snapshotRebuildCount, 1);
  assert.equal(f.calls(), 2);
});

test('the ingress contract marker blocks old workers before any semantic proposal exists', async t => {
  const f = await fixture(t); const accepted = await f.service.accept(f.input);
  const snapshot = await f.context.buildIntentSnapshot({ session: accepted.session, sourceEventId: accepted.event.id, currentMessage: accepted.event.content, latestEventSeq: 1 });
  await assert.rejects(f.context.claimIntentRouting('session', accepted.routing.id, snapshot.id, 'legacy'), /WORKER_UNSUPPORTED/);
  await assert.rejects(new LogicalOperationStore(f.persistence).begin({ id: 'legacy', sessionId: 'session', phase: 'brief_generation' }), /INTENT_EXECUTION_BINDING_REQUIRED/);
  assert.equal(f.calls(), 0);
});

test('a lifecycle generation change before first classification invalidates the accepted message without calling a model', async t => {
  const f = await fixture(t); const accepted = await f.service.accept(f.input);
  await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => { (draft.sessionLifecyclesBySession as any).session.generation++; });
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.calls(), 0); assert.equal(f.context.listWorkItems('session').length, 0);
  assert.equal(f.context.listRoutingRecords('session')[0].status, 'REJECTED');
});

test('late blocking cannot overwrite a committed plan and repeated blocking preserves the original receipt', async t => {
  const f = await fixture(t); const accepted = await f.service.accept(f.input);
  const reference = { sessionId: 'session', routingId: accepted.routing.id };
  await f.service.process(reference);
  const committed = structuredClone(f.context.listRoutingRecords('session')[0]);
  await (f.service as any).block(reference, 'LATE_WORKER_ERROR');
  assert.deepEqual(f.context.listRoutingRecords('session')[0], committed);
  const failed = await fixture(t, 'auth'); const rejected = await failed.service.accept(failed.input);
  const failedReference = { sessionId: 'session', routingId: rejected.routing.id };
  await failed.service.process(failedReference);
  const receipt = structuredClone(failed.state().eventsBySession.session);
  const blocked = structuredClone(failed.context.listRoutingRecords('session')[0]);
  await (failed.service as any).block(failedReference, 'LATE_WORKER_ERROR');
  assert.deepEqual(failed.context.listRoutingRecords('session')[0], blocked);
  assert.deepEqual(failed.state().eventsBySession.session, receipt);
});

async function semanticCorrectionFixture(t: TestContext) {
  const f = await fixture(t, 'initial');
  const initial = await f.service.accept(f.input);
  await f.service.process({ sessionId: 'session', routingId: initial.routing.id });
  f.setMode('constraint');
  const constraint = await f.service.accept({ ...f.input, first: false, content: '超时为 10 分钟', idempotencyKey: 'constraint' });
  await f.service.process({ sessionId: 'session', routingId: constraint.routing.id });
  const old = f.context.validDecisions('session', f.state().sessions[0].activeWorkItemId)[0];
  f.setMode('correction');
  const input = { ...f.input, first: false, content: '超时改为 30 分钟', idempotencyKey: 'correction', replyToEventId: constraint.event.id };
  return { ...f, constraint, old, correctionInput: input };
}

test('new-contract chat correction installs the shared hold and activates once without a legacy follow-up', async t => {
  const f = await semanticCorrectionFixture(t);
  const accepted = await f.service.accept(f.correctionInput);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  const correction = f.state().intentCorrectionsBySession.session[0];
  assert.equal(correction.status, 'accepted'); assert.equal(correction.originRoutingId, accepted.routing.id);
  assert.equal(correction.originFollowUpId, undefined); assert.equal(correction.sourceEventId, accepted.event.id);
  assert.equal(correction.processing.attemptsUsed, 1); assert.equal(f.calls(), 3);
  assert.equal(f.state().workItemsBySession.session[0].dispatchHold.correctionId, correction.id);
  await f.corrections.reconcileStop(correction);
  const applied = f.state().intentCorrectionsBySession.session[0];
  assert.equal(applied.status, 'applied'); assert.equal(applied.processing.attemptsUsed, 2); assert.equal(f.calls(), 4);
  const work = f.state().workItemsBySession.session[0];
  assert.equal(work.dispatchHold, undefined);
  const decisions = f.context.validDecisions('session', work.id);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].content, '超时改为 30 分钟');
  assert.notEqual(decisions[0].id, f.old.id);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'user_message').length, 3);
  assert.equal((f.state().followUpMessagesBySession?.session ?? []).length, 0);
  assert.ok(!f.state().briefsBySession?.session);
  const replay = await f.service.accept(f.correctionInput);
  await f.make().process({ sessionId: 'session', routingId: replay.routing.id });
  assert.equal(f.calls(), 4); assert.equal(f.state().intentCorrectionsBySession.session.length, 1);
  f.setMode('correction');
  const next = await f.service.accept({ ...f.correctionInput, content: '超时改为 45 分钟', idempotencyKey: 'correction-next', replyToEventId: accepted.event.id });
  await f.service.process({ sessionId: 'session', routingId: next.routing.id });
  const nextCorrection = f.state().intentCorrectionsBySession.session[1];
  assert.equal(nextCorrection.routingId, f.constraint.routing.id); assert.equal(nextCorrection.pendingIntentRevision, 3);
  await f.corrections.reconcileStop(nextCorrection);
  assert.equal(f.state().intentCorrectionsBySession.session[1].status, 'applied');
  assert.equal(f.context.validDecisions('session', work.id)[0].content, '超时改为 45 分钟');
});

test('an invented semantic correction target clarifies without holding or replacing a Decision', async t => {
  const f = await semanticCorrectionFixture(t); f.setMode('correction-foreign');
  const accepted = await f.service.accept(f.correctionInput);
  await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.context.listRoutingRecords('session').find(row => row.id === accepted.routing.id)?.status, 'CLARIFICATION_REQUIRED');
  assert.equal((f.state().intentCorrectionsBySession?.session ?? []).length, 0);
  assert.equal(f.state().workItemsBySession.session[0].dispatchHold, undefined);
  assert.equal(f.context.validDecisions('session', f.state().sessions[0].activeWorkItemId)[0].id, f.old.id);
  assert.equal(f.calls(), 3);
});

test('semantic correction revalidates the target inside acceptance and rolls back a failed receipt write', async t => {
  for (const mode of ['revision', 'disk']) {
    const f = await semanticCorrectionFixture(t);
    const accept = f.corrections.acceptMessage.bind(f.corrections);
    const write = (f.persistence as any).writeFileState.bind(f.persistence);
    f.corrections.acceptMessage = async (...args) => {
      if (mode === 'revision') await f.persistence.mutateCollections(['decisionRecordsBySession'], draft => {
        (draft.decisionRecordsBySession as any).session[0].revision++;
      });
      else (f.persistence as any).writeFileState = () => { throw new Error('semantic correction disk failure'); };
      try { return await accept(...args); }
      finally { (f.persistence as any).writeFileState = write; }
    };
    const source = await f.service.accept(f.correctionInput);
    const operation = f.service.process({ sessionId: 'session', routingId: source.routing.id });
    if (mode === 'disk') await assert.rejects(operation, /semantic correction disk failure/); else await operation;
    assert.equal((f.state().intentCorrectionsBySession?.session ?? []).length, 0);
    assert.equal(f.state().workItemsBySession.session[0].dispatchHold, undefined);
    assert.equal(f.context.validDecisions('session', f.state().sessions[0].activeWorkItemId)[0].id, f.old.id);
    if (mode === 'disk') {
      f.corrections.acceptMessage = accept;
      await f.service.process({ sessionId: 'session', routingId: source.routing.id });
      assert.equal(f.calls(), 3, 'persisted proposal is reused after failed receipt transaction');
      assert.equal(f.state().intentCorrectionsBySession.session.length, 1);
    }
  }
});

test('read authority comes from explicit validated workspace selection and expires on binding change or revocation', async t => {
  for (const mode of ['selected', 'absent', 'revoked', 'changed']) {
    const f = await fixture(t, 'read');
    if (mode !== 'absent') {
      f.input.session.workingDirectory = { kind: 'server_local', id: 'workspace', name: 'selected', path: 'D:/selected', selectedAt: '2026-10-19T00:00:00Z' };
      f.input.session.workspaceContext = { binding: { workspaceId: 'workspace', providerKind: 'server_local', displayName: 'selected',
        capabilities: { read: true, write: true, command: true, test: true }, boundAt: '2026-10-19T00:00:00Z', boundRevision: { id: 'first', observedAt: '2026-10-19T00:00:00Z' } }, indexComplete: false };
    }
    const accepted = await f.service.accept(f.input);
    if (mode === 'revoked' || mode === 'changed') await f.persistence.mutateCollections(['sessions'], draft => {
      const session = (draft.sessions as SessionDetail[])[0];
      if (mode === 'revoked') session.intentWorkspaceReadAuthority!.grant.revokedAt = new Date().toISOString();
      else session.workingDirectory!.path = 'D:/another';
    });
    await f.service.process({ sessionId: 'session', routingId: accepted.routing.id });
    const route = f.context.listRoutingRecords('session')[0];
    if (mode === 'selected') {
      assert.equal(route.status, 'ROUTED');
      assert.deepEqual(route.semanticPlan?.steps[0].effectScope.effects.map(row => row.kind), ['answer', 'read_workspace']);
      assert.equal(f.state().intentRouteRevisionsBySession.session[0].authorityGrants[0].sourceEventId, accepted.event.id);
      await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
        const step = (draft.intentPlanStepsBySession as any).session[0];
        step.status = 'running'; step.processing = { ownerId: 'executor', attemptsUsed: 1,
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString() };
      });
      const step = f.state().intentPlanStepsBySession.session[0];
      const identity = { sessionId: 'session', dataEpoch: 'epoch', admissionClass: 'response' as const,
        intentStepId: step.id, executionBinding: step.step.executionBinding, effectScope: step.step.effectScope };
      const operations = new LogicalOperationStore(f.persistence);
      await operations.assertCurrentIntent(identity);
      await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].intentWorkspaceReadAuthority!.grant.revokedAt = new Date().toISOString(); });
      await assert.rejects(operations.assertCurrentIntent(identity), /INTENT_WORKSPACE_READ_AUTHORITY_STALE/);
    } else {
      assert.notEqual(route.status, 'ROUTED');
      assert.ok(route.reasonCodes.includes('EFFECT_NOT_AUTHORIZED'));
      assert.equal((f.state().intentPlanStepsBySession?.session ?? []).length, 0);
    }
    assert.equal(f.context.listWorkItems('session').length, 0);
  }
});
