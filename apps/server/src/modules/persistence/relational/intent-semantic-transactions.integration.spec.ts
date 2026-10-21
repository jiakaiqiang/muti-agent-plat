import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { briefRevisionMessage, intentUnderstandingExample, type ReviseIntentBriefInput, type ClarifyIntentRoutingInput, type CollaborationEvent, type IntentRoutingRecord,
  type IntentUnderstandingOutput, type SessionDetail, type IntentPlanStepRecord } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence.service.js';
import { ContextManagementService } from '../../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../../runtimes/session-lifecycle-store.js';
import { IntentUnderstandingRoutingService } from '../../intent-recognition/intent-understanding-routing.service.js';
import { IntentPlanCommitService } from '../../message-routing/intent-plan-commit.service.js';
import { SemanticClarificationService } from '../../message-routing/semantic-clarification.service.js';
import { IntentCorrectionService } from '../../message-routing/intent-correction.service.js';
import { IntentCorrectionPlannerService } from '../../message-routing/intent-correction-planner.service.js';
import { ArtifactsService } from '../../artifacts/artifacts.service.js';
import { IntentTestExecutorService } from '../../message-routing/intent-test-executor.service.js';
import { issueTestAuthority } from '../../message-routing/intent-test-authority.js';
import { LogicalOperationStore } from '../../runtimes/logical-operation-store.js';
import { IsolatedTestRunStore } from '../../runtimes/isolated-test-run-store.js';
import { IntentAuthorizationRetryService } from '../../message-routing/intent-authorization-retry.service.js';
import { IntentRecognitionRetryService } from '../../message-routing/intent-recognition-retry.service.js';
import { IntentMessagePipelineService } from '../../message-routing/intent-message-pipeline.service.js';
import { IntentAnswerExecutorService } from '../../message-routing/intent-answer-executor.service.js';
import { deriveIntentBriefStep, IntentBriefStoreService } from '../../message-routing/intent-brief-store.service.js';
import { IntentBriefConfirmationService } from '../../message-routing/intent-brief-confirmation.service.js';
import { IntentBriefRetryService } from '../../message-routing/intent-brief-retry.service.js';

const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL;
const rows = <T>(persistence: PersistenceService, key: string, sessionId: string) => persistence.getCollection<Record<string, T[]>>(key, {})[sessionId] ?? [];

for (const failCommit of [false, true]) test(`PostgreSQL intent brief ${failCommit ? 'publication rolls back all projections on SQL failure' : 'publishes once across independent connections'}`, { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, false, false, true);
  await f.first.mutateCollections(['sessions'], (draft: any) => {
    const session = draft.sessions.find((row: SessionDetail) => row.id === f.sessionId);
    session.intentContractVersion = 'intent-understanding-v1'; session.status = 'AGENT_DISCUSSING';
  }, { sessionIds: [f.sessionId] });
  const session = f.first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!;
  const understanding = structuredClone(f.understanding);
  Object.assign(understanding.segments[0], { scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context' });
  const snapshot = await f.context.buildIntentSnapshot({ session, sourceEventId: f.sourceEventId, currentMessage: session.originalInput, latestEventSeq: 1 });
  const proposal = await new IntentUnderstandingRoutingService(f.first, f.context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ ...f.reference, snapshotId: snapshot.id });
  const mutate = f.first.mutateCollections.bind(f.first); let stepId = '';
  // The dispatcher is not enabled yet. Seed its derived step in the real plan
  // transaction, preserving the same immutable revision and SQL persistence path.
  f.first.mutateCollections = ((keys: any, action: any, options: any) => mutate(keys, (draft: any) => {
    const result = action(draft), version = draft.intentRouteRevisionsBySession?.[f.sessionId]?.[0];
    if (version?.validatedPlan?.outcome === 'applicable' && version.validatedPlan.steps.length === 1) {
      const step = deriveIntentBriefStep(version.validatedPlan); stepId = step.stepId; version.validatedPlan.steps.push(step);
      draft.intentRoutingRecordsBySession[f.sessionId][0].semanticPlan = structuredClone(version.validatedPlan);
      draft.intentRoutingRecordsBySession[f.sessionId][0].actionStatus = 'pending';
      const now = new Date().toISOString();
      draft.intentPlanStepsBySession[f.sessionId].push({ id: stepId, sessionId: f.sessionId, dataEpoch: session.dataEpoch,
        routingId: f.route.id, intentRevision: 1, localKey: step.segmentKey, step, status: 'running', reusedEffectIds: [], createdAt: now, updatedAt: now,
        processing: { ownerId: 'fixture-owner', invocationId: 'fixture-invocation', attemptsUsed: 1,
          leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), deadlineAt: new Date(Date.now() + 120000).toISOString() } });
    }
    return result;
  }, options)) as typeof f.first.mutateCollections;
  try { await new IntentPlanCommitService(f.first, { listAll: () => [{ type: 'generic_llm' }] } as never)
    .commit({ ...f.reference, actorId: session.ownerId, expectedRoutingRevision: proposal.routingRevision! }); }
  finally { f.first.mutateCollections = mutate; }
  assert.ok(stepId);
  const reference = { sessionId: f.sessionId, stepId, ownerId: 'fixture-owner', invocationId: 'fixture-invocation' };
  const one = new IntentBriefStoreService(f.first);
  await one.saveResult(reference, 'coordinator', { schemaVersion: '1.0', kind: 'task_brief', goal: session.originalInput,
    scope: [], outOfScope: [], constraints: [], acceptanceCriteria: [], risks: [], openQuestions: [], suggestedTasks: [
      { title: '仅保存建议', description: '不得自动执行', suggestedAgentKey: null, routingMode: 'coordinator_controlled', assignmentReason: null,
        contextRequirements: [], verificationPlan: [], riskNotes: [], requiresUserConfirmation: false, dependsOnTaskTitles: [], acceptanceCriteria: [] }
    ] });
  const second = await f.connect(), two = new IntentBriefStoreService(second); let pool: Pool | undefined;
  if (failCommit) {
    assert.match(f.sessionId, /^[a-f0-9-]{36}$/); pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_brief() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_INTENT_BRIEF_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_brief BEFORE INSERT ON agent_cluster.briefs FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_brief();`);
  }
  try {
    if (failCommit) {
      await assert.rejects(one.publish(reference), /INJECTED_INTENT_BRIEF_FAILURE/);
      const restored = await f.connect(); assert.equal(rows(restored, 'briefsBySession', f.sessionId).length, 0);
      assert.equal(restored.getCollection<any>('suggestedTasksByBriefId', {})[`intent-brief:${stepId}`], undefined);
      assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).some(row => row.type === 'brief_created' || row.type === 'user_confirmation_requested'), false);
      assert.equal(restored.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!.status, 'AGENT_DISCUSSING');
      assert.ok(rows<IntentPlanStepRecord>(restored, 'intentPlanStepsBySession', f.sessionId).find(row => row.id === stepId)!.processing!.briefResult);
    } else {
      const results = await Promise.all([one.publish(reference), two.publish(reference)]);
      assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
      assert.equal(results[0].brief.id, results[1].brief.id);
      const restored = await f.connect(); assert.equal(rows(restored, 'briefsBySession', f.sessionId).length, 1);
      const suggestions = restored.getCollection<any>('suggestedTasksByBriefId', {})[results[0].brief.id];
      assert.equal(suggestions.length, 1); assert.equal(suggestions[0].requiresUserConfirmation, true);
      const events = rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).filter(row => ['brief_created', 'user_confirmation_requested'].includes(row.type));
      assert.equal(events.length, 2); assert.equal(restored.getCollection<any[]>('eventOutbox', []).filter(row => events.some(event => row.id === `outbox:${event.id}`)).length, 2);
      assert.equal((await new IntentBriefStoreService(restored).publish(reference)).idempotentReplay, true);
      assert.equal(rows(restored, 'tasksBySession', f.sessionId).length, 0);
      const brief = results[0].brief;
      const request = { contractVersion: 'intent-brief-confirm-v1', dataEpoch: session.dataEpoch,
        confirmationId: events.find(row => row.type === 'user_confirmation_requested')!.metadata.payload!.confirmationId,
        expectedBriefVersion: brief.version, expectedIntentRevision: brief.intentBinding!.intentRevision, idempotencyKey: randomUUID() };
      const baselineDecisions = rows(restored, 'decisionRecordsBySession', f.sessionId);
      const failPool = new Pool({ connectionString: databaseUrl });
      assert.match(f.sessionId, /^[a-f0-9-]{36}$/);
      try {
        await failPool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_brief_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_BRIEF_CONFIRM_FAILURE'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER intent_fixture_brief_confirm BEFORE UPDATE ON agent_cluster.briefs FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_brief_confirm();`);
        await assert.rejects(new IntentBriefConfirmationService(restored).confirm(f.sessionId, brief.id, session.ownerId, request), /INJECTED_BRIEF_CONFIRM_FAILURE/);
        const rolledBack = await f.connect();
        assert.equal(rows<any>(rolledBack, 'briefsBySession', f.sessionId)[0].confirmedByUser, false);
        assert.deepEqual(rows(rolledBack, 'decisionRecordsBySession', f.sessionId), baselineDecisions);
        assert.equal(rows<CollaborationEvent>(rolledBack, 'eventsBySession', f.sessionId).some(row => row.type === 'brief_confirmed'), false);
        assert.equal(rolledBack.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!.status, 'WAIT_USER_CONFIRM');
      } finally {
        await failPool.query('DROP TRIGGER IF EXISTS intent_fixture_brief_confirm ON agent_cluster.briefs; DROP FUNCTION IF EXISTS agent_cluster.intent_fixture_fail_brief_confirm();');
        await failPool.end();
      }
      const approvals = await Promise.all([new IntentBriefConfirmationService(restored).confirm(f.sessionId, brief.id, session.ownerId, request),
        new IntentBriefConfirmationService(second).confirm(f.sessionId, brief.id, session.ownerId, { ...request, idempotencyKey: randomUUID() })]);
      assert.deepEqual(approvals.map(row => row.idempotentReplay).sort(), [false, true]);
      assert.equal(approvals[0].receipt.id, approvals[1].receipt.id);
      const approved = await f.connect();
      assert.equal(rows<any>(approved, 'briefsBySession', f.sessionId)[0].intentConfirmationReceipt.id, approvals[0].receipt.id);
      assert.equal(rows<CollaborationEvent>(approved, 'eventsBySession', f.sessionId).filter(row => row.type === 'brief_confirmed').length, 1);
      assert.equal(rows(approved, 'tasksBySession', f.sessionId).length, 0);
      // The confirmed draft is retained when a new correction derives a replacement draft.
      const dispatches: Array<{ sessionId: string; stepId: string }> = [];
      const context = new ContextManagementService(approved), correctionService = new IntentCorrectionService(approved);
      const planner = new IntentCorrectionPlannerService(approved, context, { understand: async (input: any) => {
        const semantic = structuredClone(f.understanding), request = input.correction;
        Object.assign(semantic.segments[0], { dialogueAct: 'constraint', goal: input.snapshot.currentMessage, scopeRelation: 'same_requirement',
          suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed', correction: null, requestedEffects: [],
          target: { workItemId: request.targetWorkItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: request.routingId },
          evidence: [{ refId: 'revision', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
        return { status: 'valid', understanding: semantic };
      } } as never, undefined, undefined, undefined, { schedule: (ref: { sessionId: string; stepId: string }) => dispatches.push(ref) } as never);
      t.after(() => planner.onModuleDestroy());
      const corrected = await correctionService.accept(f.sessionId, f.route.id, session.ownerId, { contractVersion: 'intent-correction-v1',
        expectedRoutingRevision: context.listRoutingRecords(f.sessionId).find(row => row.id === f.route.id)!.routingRevision!, idempotencyKey: randomUUID(),
        instruction: '超时为 30 分钟', targetWorkItemId: brief.workItemId!, supersedesDecisionId: null, expectedDecisionRevision: null });
      await correctionService.reconcileStop(corrected.correction); await planner.process(corrected.correction);
      assert.equal(dispatches.length, 1);
      const fresh = await f.connect(), replacementId = dispatches[0].stepId;
      assert.equal(rows<IntentPlanStepRecord>(fresh, 'intentPlanStepsBySession', f.sessionId).find(row => row.id === replacementId)!.step.replacesBrief!.briefId, brief.id);
      await fresh.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
        const step = draft.intentPlanStepsBySession[f.sessionId].find((row: IntentPlanStepRecord) => row.id === replacementId);
        step.status = 'running'; step.processing = { ownerId: 'revision-owner', invocationId: 'revision-call', attemptsUsed: 1,
          leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), deadlineAt: new Date(Date.now() + 120000).toISOString() };
      }, { sessionIds: [f.sessionId] });
      const replacement = { sessionId: f.sessionId, stepId: replacementId, ownerId: 'revision-owner', invocationId: 'revision-call' };
      await new IntentBriefStoreService(fresh).saveResult(replacement, 'coordinator', { schemaVersion: '1.0', kind: 'task_brief', goal: brief.goal,
        scope: [], outOfScope: [], constraints: [], acceptanceCriteria: [], risks: [], openQuestions: ['部署区域？'], suggestedTasks: [] });
      const other = await f.connect();
      const published = await Promise.all([new IntentBriefStoreService(fresh).publish(replacement), new IntentBriefStoreService(other).publish(replacement)]);
      assert.deepEqual(published.map(row => row.idempotentReplay).sort(), [false, true]);
      assert.equal(published[0].brief.supersedesBriefId, brief.id); assert.deepEqual(published[0].brief.constraints, ['超时为 30 分钟']);
      const historical = rows<any>(await f.connect(), 'briefsBySession', f.sessionId).find(row => row.id === brief.id);
      assert.deepEqual(historical.intentConfirmationReceipt, approvals[0].receipt);
      const backend = await f.connect(), revisionSession = backend.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!;
      const revisionRequest: ReviseIntentBriefInput = { contractVersion: 'intent-brief-revise-v1', dataEpoch: session.dataEpoch!,
        confirmationId: `intent-brief-confirm:${replacementId}`, expectedBriefVersion: published[0].brief.version,
        expectedIntentRevision: published[0].brief.intentBinding!.intentRevision, idempotencyKey: randomUUID(),
        userMessage: '补充部署要求', questionAnswers: [{ question: '部署区域？', answer: '华东' }] };
      const makePipeline = (persistence: PersistenceService) => {
        const context = new ContextManagementService(persistence);
        const classifier = new IntentUnderstandingRoutingService(persistence, context, { understand: async (input: any) => {
          const understanding = structuredClone(f.understanding);
          Object.assign(understanding.segments[0], { dialogueAct: 'knowledge_input', goal: input.snapshot.currentMessage, scopeRelation: 'same_requirement',
            suggestedAction: 'record_information', contextPolicy: 'inherit_confirmed', correction: null, requestedEffects: [],
            target: { workItemId: brief.workItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
            evidence: [{ refId: 'revision', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
          return { status: 'valid', understanding };
        } } as never);
        const plans = new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never, undefined, undefined, undefined, { schedule() {} } as never);
        const pipeline = new IntentMessagePipelineService(persistence, context, classifier, plans); pipeline.schedule = () => {};
        t.after(() => pipeline.onModuleDestroy()); return pipeline;
      };
      const pipeline = makePipeline(backend), secondPipeline = makePipeline(await f.connect());
      const input = { session: revisionSession, content: briefRevisionMessage(revisionRequest), idempotencyKey: revisionRequest.idempotencyKey,
        replyToEventId: f.sourceEventId, rolloutMode: 'enforce_all_current_epoch' as const, briefRevision: { briefId: published[0].brief.id, request: revisionRequest } };
      const accepted = await Promise.all([pipeline.accept(input), secondPipeline.accept(input)]);
      assert.deepEqual(accepted.map(row => row.idempotentReplay).sort(), [false, true]); assert.equal(accepted[0].routing.id, accepted[1].routing.id);
      await pipeline.process({ sessionId: f.sessionId, routingId: accepted[0].routing.id });
      const revised = await f.connect();
      assert.equal(rows<any>(revised, 'decisionRecordsBySession', f.sessionId).find(row => row.question === '部署区域？')?.answer, '华东');
      assert.ok(rows<IntentPlanStepRecord>(revised, 'intentPlanStepsBySession', f.sessionId).some(row => row.routingId === accepted[0].routing.id && row.step.action === 'prepare_brief' && row.status === 'queued'));
      assert.equal((await secondPipeline.accept(input)).routing.id, accepted[0].routing.id);
      const retryStep = rows<IntentPlanStepRecord>(revised, 'intentPlanStepsBySession', f.sessionId)
        .find(row => row.routingId === accepted[0].routing.id && row.step.action === 'prepare_brief')!;
      await revised.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
        const row = draft.intentPlanStepsBySession[f.sessionId].find((item: any) => item.id === retryStep.id);
        row.status = 'failed'; row.failureCode = 'INTENT_BRIEF_OUTPUT_INVALID';
        row.processing = { ownerId: 'failed-worker', attemptsUsed: 2, invocationId: 'failed-call',
          deadlineAt: new Date(0).toISOString(), leaseExpiresAt: new Date(0).toISOString() };
      }, { sessionIds: [f.sessionId] });
      const retryRoute = rows<IntentRoutingRecord>(revised, 'intentRoutingRecordsBySession', f.sessionId).find(row => row.id === retryStep.routingId)!;
      const retryRequest = { contractVersion: 'intent-brief-retry-v1', dataEpoch: session.dataEpoch,
        expectedRoutingRevision: retryRoute.routingRevision, expectedIntentRevision: retryStep.intentRevision,
        expectedOperationId: `brief:${retryStep.id}`, idempotencyKey: randomUUID() };
      const firstRetry = new IntentBriefRetryService(revised, { schedule: () => {} } as never);
      const secondRetry = new IntentBriefRetryService(await f.connect(), { schedule: () => {} } as never);
      const retried = await Promise.all([firstRetry.retry(f.sessionId, retryStep.id, session.ownerId, retryRequest),
        secondRetry.retry(f.sessionId, retryStep.id, session.ownerId, retryRequest)]);
      assert.deepEqual(retried.map(row => row.idempotentReplay).sort(), [false, true]);
      assert.equal(retried[0].receipt.operationId, retried[1].receipt.operationId);
      const recovered = await f.connect(), recoveredStep = rows<IntentPlanStepRecord>(recovered, 'intentPlanStepsBySession', f.sessionId).find(row => row.id === retryStep.id)!;
      assert.equal(recoveredStep.status, 'queued'); assert.equal(recoveredStep.processing, undefined);
      assert.equal(recoveredStep.briefRetryReceipts?.[0].previous.processing?.attemptsUsed, 2);
      await assert.rejects(recovered.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
        draft.intentPlanStepsBySession[f.sessionId].find((item: any) => item.id === retryStep.id).briefRetryReceipts[0].previous.processing.attemptsUsed = 0;
      }, { sessionIds: [f.sessionId] }), /INTENT_BRIEF_RETRY_RECEIPT_CONFLICT/);
    }
  } finally { if (pool) { await pool.query('DROP TRIGGER intent_fixture_brief ON agent_cluster.briefs; DROP FUNCTION agent_cluster.intent_fixture_fail_brief();'); await pool.end(); } }
});

for (const failCommit of [false, true]) test(`PostgreSQL targeted answers ${failCommit ? 'roll back every target on insert failure' : 'deduplicate independent connections and aggregate partial failure'}`, { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, false, false, true), targets = ['architect', 'reviewer'];
  await f.first.mutateCollections(['sessions'], draft => {
    (draft.sessions as SessionDetail[]).find(row => row.id === f.sessionId)!.participatingAgentIds = targets;
  }, { sessionIds: [f.sessionId] });
  const session = f.first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!;
  const snapshot = await f.context.buildIntentSnapshot({ session, sourceEventId: f.sourceEventId, currentMessage: session.originalInput,
    latestEventSeq: 1, mentionedAgentIds: targets });
  const understanding = structuredClone(f.understanding);
  Object.assign(understanding.segments[0], { dialogueAct: 'question', scopeRelation: 'session_context', suggestedAction: 'answer_in_chat', contextPolicy: 'clean_task_context',
    requestedEffects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }] });
  understanding.segments[0].target.agentIds.push(...targets);
  const proposed = await new IntentUnderstandingRoutingService(f.first, f.context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ ...f.reference, snapshotId: snapshot.id });
  const second = await f.connect(), scheduled: string[] = [], calls: string[] = [];
  const makeCommit = (backend: PersistenceService) => new IntentPlanCommitService(backend, { listAll: () => [{ type: 'generic_llm' }] } as never,
    undefined, { schedule: (reference: { stepId: string }) => scheduled.push(reference.stepId) } as never);
  const input = { ...f.reference, actorId: session.ownerId, expectedRoutingRevision: proposed.routingRevision! };
  let pool: Pool | undefined;
  if (failCommit) {
    assert.match(f.sessionId, /^[a-f0-9-]{36}$/); pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_answer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_TARGET_ANSWER_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_answer BEFORE INSERT ON agent_cluster.intent_plan_steps FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_answer();`);
  }
  try {
    if (failCommit) {
      await assert.rejects(makeCommit(f.first).commit(input), /INJECTED_TARGET_ANSWER_FAILURE/);
      const restored = await f.connect();
      for (const key of ['intentPlanStepsBySession', 'intentRouteRevisionsBySession']) assert.equal(rows(restored, key, f.sessionId).length, 0);
      assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).some(row => row.type === 'intent_plan_committed'), false);
      assert.deepEqual(scheduled, []);
      assert.equal(rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0].routingRevision, proposed.routingRevision);
    } else {
      const results = await Promise.all([makeCommit(f.first).commit(input), makeCommit(second).commit(input)]);
      assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
      assert.equal(new Set(scheduled).size, 2);
      const references = results[0].plan.steps.map(step => ({ sessionId: f.sessionId, stepId: step.stepId }));
      assert.equal(references.length, 2);
      const makeExecutor = (backend: PersistenceService) => {
        const executor = new IntentAnswerExecutorService(backend, { invoke: async (request: any) => {
          calls.push(request.agent.id);
          return request.agent.id === targets[0] ? { status: 'failed', error: { code: 'MODEL_ERROR', retryable: false, details: { httpStatus: 401 } } }
            : { status: 'completed', output: { schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer', content: '指定回答',
              targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] } };
        } } as never, { getForSurface: (id: string) => ({ id, key: id, capabilityIds: [], profileMarkdown: id }) } as never, { get: () => ({}) } as never);
        f.services.push(executor); return executor;
      };
      const one = makeExecutor(f.first), two = makeExecutor(second);
      for (const reference of references) await Promise.all([one.process(reference), two.process(reference)]);
      const restored = await f.connect();
      assert.deepEqual(calls.sort(), targets.slice().sort());
      assert.deepEqual(rows<IntentPlanStepRecord>(restored, 'intentPlanStepsBySession', f.sessionId).map(row => row.status).sort(), ['completed', 'failed']);
      assert.equal(rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0].actionStatus, 'failed');
      const events = rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId);
      const answers = events.filter(row => row.type === 'agent_message');
      assert.equal(answers.length, 1); assert.equal(answers[0].fromAgentId, targets[1]);
      assert.equal(restored.getCollection<any[]>('eventOutbox', []).filter(row => row.id === `outbox:${answers[0].id}`).length, 1);
      const recovered = makeExecutor(restored); for (const reference of references) await recovered.process(reference);
      assert.equal(calls.length, 2); assert.equal(rows(restored, 'workItemsBySession', f.sessionId).length, 0);
    }
  } finally { if (pool) { await pool.query('DROP TRIGGER intent_fixture_answer ON agent_cluster.intent_plan_steps; DROP FUNCTION agent_cluster.intent_fixture_fail_answer();'); await pool.end(); } }
});

for (const failCommit of [false, true]) test(`PostgreSQL recognition retry ${failCommit ? 'rolls back budget archive and receipt' : 'deduplicates stale connections and recovers accepted operation'}`, { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, false, false, true);
  await f.first.mutateCollections(['sessions', 'intentRoutingRecordsBySession'], draft => {
    (draft.sessions as SessionDetail[]).find(row => row.id === f.sessionId)!.intentContractVersion = 'intent-understanding-v1';
    const route = (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>)[f.sessionId][0];
    route.semanticContractVersion = 'intent-understanding-v1'; route.semanticIngress = { dataEpoch: f.session.dataEpoch, sessionGeneration: 1, entryPoint: 'first_message' };
  }, { sessionIds: [f.sessionId] });
  let fail = true, calls = 0;
  const makePipeline = (backend: PersistenceService) => {
    const context = new ContextManagementService(backend);
    const semantic = { understand: async (input: any) => {
      calls++;
      if (fail) return { status: 'failed', failureClass: 'auth', code: 'INTENT_AUTH_FAILED', retryable: false, retryAfterMs: 0 };
      const understanding = structuredClone(f.understanding);
      Object.assign(understanding.segments[0], { dialogueAct: 'question', scopeRelation: 'session_context', suggestedAction: 'answer_in_chat', contextPolicy: 'clean_task_context',
        requestedEffects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }] });
      return { status: 'valid', understanding };
    } };
    const pipeline = new IntentMessagePipelineService(backend, context, new IntentUnderstandingRoutingService(backend, context, semantic as never),
      new IntentPlanCommitService(backend, { listAll: () => [{ type: 'generic_llm' }] } as never));
    pipeline.schedule = () => {}; f.services.push(pipeline); return pipeline;
  };
  const pipeline = makePipeline(f.first); await pipeline.process(f.reference);
  const blocked = rows<IntentRoutingRecord>(f.first, 'intentRoutingRecordsBySession', f.sessionId)[0]; assert.equal(blocked.status, 'BLOCKED');
  const second = await f.connect(), request = { contractVersion: 'intent-recognition-retry-v1' as const, dataEpoch: f.session.dataEpoch,
    expectedRoutingRevision: blocked.routingRevision!, idempotencyKey: randomUUID() };
  const one = new IntentRecognitionRetryService(f.first, pipeline), two = new IntentRecognitionRetryService(second, makePipeline(second));
  let pool: Pool | undefined;
  if (failCommit) {
    assert.match(f.sessionId, /^[a-f0-9-]{36}$/); pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_retry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') AND OLD.status = 'BLOCKED' AND NEW.status = 'RECEIVED' THEN RAISE EXCEPTION 'INJECTED_RECOGNITION_RETRY_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_retry BEFORE UPDATE ON agent_cluster.intent_routing_records FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_retry();`);
  }
  try {
    if (failCommit) {
      await assert.rejects(one.retry(f.sessionId, f.route.id, f.session.ownerId, request), /INJECTED_RECOGNITION_RETRY_FAILURE/);
      const restored = await f.connect(), route = rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0];
      assert.deepEqual(route, blocked); assert.equal(route.recognitionRetryReceipts, undefined);
      assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).filter(row => row.type === 'intent_recognition_retry_requested').length, 0);
    } else {
      const results = await Promise.all([one.retry(f.sessionId, f.route.id, f.session.ownerId, request), two.retry(f.sessionId, f.route.id, f.session.ownerId, request)]);
      assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]); assert.equal(calls, 1);
      const restored = await f.connect(); fail = false;
      await makePipeline(restored).process(f.reference);
      const route = rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0];
      assert.equal(route.status, 'ROUTED', JSON.stringify({ reasons: route.reasonCodes, blockedReason: route.blockedReason })); assert.equal(calls, 2); assert.equal(route.recognitionRetryReceipts?.length, 1);
      assert.deepEqual(route.recognitionRetryReceipts![0].previous.attemptLog, blocked.attemptLog);
      assert.equal(rows(restored, 'workItemsBySession', f.sessionId).length, 0);
      assert.equal((await two.retry(f.sessionId, f.route.id, f.session.ownerId, request)).idempotentReplay, true);
    }
  } finally { if (pool) { await pool.query('DROP TRIGGER intent_fixture_retry ON agent_cluster.intent_routing_records; DROP FUNCTION agent_cluster.intent_fixture_fail_retry();'); await pool.end(); } }
});

for (const failCommit of [false, true]) test(`PostgreSQL authorization retry ${failCommit ? 'rolls back task and receipt on SQL failure' : 'deduplicates independent connections and reload'}`, { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, false, false, true), previousImage = process.env.INTENT_ISOLATED_TEST_IMAGE;
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  t.after(() => { if (previousImage === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previousImage; });
  let authority: ReturnType<typeof issueTestAuthority>;
  await f.first.mutateCollections(['sessions'], draft => {
    const session = (draft.sessions as SessionDetail[]).find(row => row.id === f.sessionId)!;
    Object.assign(session, { status: 'AGENT_DISCUSSING', intentContractVersion: 'intent-understanding-v1',
      workingDirectory: { id: session.workspaceId, kind: 'server_local', path: process.cwd(), name: 'fixture', selectedAt: session.createdAt },
      workspaceContext: { indexComplete: true, binding: { workspaceId: session.workspaceId, providerKind: 'server_local', displayName: 'fixture',
        boundAt: session.createdAt, boundRevision: { id: 'revision', observedAt: session.createdAt }, capabilities: { read: true, write: false, command: false, test: true } } } });
    authority = issueTestAuthority(session, 'test:unit', 'grant', 1, true);
  }, { sessionIds: [f.sessionId] });
  const session = f.first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!;
  const understanding = structuredClone(f.understanding);
  Object.assign(understanding.segments[0], { scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context',
    requestedEffects: [authority!.grant, authority!.reportGrant!].map(grant => ({ kind: grant.effect, target: grant.resource, evidenceRefs: ['request'] })) });
  const snapshot = await f.context.buildIntentSnapshot({ session, sourceEventId: f.sourceEventId, currentMessage: session.originalInput, latestEventSeq: 1 });
  let modelCalls = 0;
  const proposal = await new IntentUnderstandingRoutingService(f.first, f.context, { understand: async () => { modelCalls++; return { status: 'valid', understanding }; } } as never)
    .classify({ sessionId: f.sessionId, routingId: f.route.id, snapshotId: snapshot.id });
  const commits = (backend: PersistenceService) => new IntentPlanCommitService(backend, { listAll: () => [{ type: 'test_runner' }] } as never,
    undefined, undefined, { schedule() {} } as never);
  const original = await commits(f.first).commit({ ...f.reference, actorId: session.ownerId, expectedRoutingRevision: proposal.routingRevision! });
  assert.deepEqual(original.plan.validation.errorCodes, ['EFFECT_NOT_AUTHORIZED']);
  const second = await f.connect(); // Deliberately cache the pre-grant state on a separate connection.
  await f.first.mutateCollections(['sessions'], draft => {
    (draft.sessions as SessionDetail[]).find(row => row.id === f.sessionId)!.intentTestAuthority = authority;
  }, { sessionIds: [f.sessionId] });
  const make = (backend: PersistenceService) => new IntentAuthorizationRetryService(backend, new ContextManagementService(backend), commits(backend));
  const request = { contractVersion: 'intent-authorization-retry-v1' as const, dataEpoch: session.dataEpoch,
    expectedRoutingRevision: original.routing.routingRevision!, idempotencyKey: randomUUID() };
  let pool: Pool | undefined;
  if (failCommit) {
    assert.match(f.sessionId, /^[a-f0-9-]{36}$/); pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_RETRY_VERSION_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_version BEFORE INSERT ON agent_cluster.intent_route_revisions FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_version();`);
  }
  try {
    if (failCommit) {
      await assert.rejects(make(f.first).retry(f.sessionId, f.route.id, session.ownerId, request), /INJECTED_RETRY_VERSION_FAILURE/);
      const restored = await f.connect();
      for (const key of ['workItemsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession']) assert.equal(rows(restored, key, f.sessionId).length, 0);
      const current = rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0];
      assert.equal(current.authorizationRetryReceipts, undefined); assert.deepEqual(current.semanticPlan, original.plan);
    } else {
      const results = await Promise.all([make(f.first).retry(f.sessionId, f.route.id, session.ownerId, request), make(second).retry(f.sessionId, f.route.id, session.ownerId, request)]);
      assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
      const restored = await f.connect(), replay = await make(restored).retry(f.sessionId, f.route.id, session.ownerId, request);
      assert.equal(replay.idempotentReplay, true); assert.equal(rows(restored, 'workItemsBySession', f.sessionId).length, 1);
      assert.equal(rows(restored, 'intentPlanStepsBySession', f.sessionId).length, 1); assert.equal(rows(restored, 'intentRouteRevisionsBySession', f.sessionId).length, 2);
      assert.equal(rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0].authorizationRetryReceipts?.length, 1);
    }
    assert.equal(modelCalls, 1);
  } finally { if (pool) { await pool.query('DROP TRIGGER intent_fixture_version ON agent_cluster.intent_route_revisions; DROP FUNCTION agent_cluster.intent_fixture_fail_version();'); await pool.end(); } }
});

for (const injectFailure of [false, true]) test(`PostgreSQL test report ${injectFailure ? 'SQL rollback recovers journal without rerunning' : 'independent executors publish once'}`, { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, false), previousImage = process.env.INTENT_ISOLATED_TEST_IMAGE;
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  t.after(() => { if (previousImage === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previousImage; });
  await f.first.mutateCollections(['sessions'], draft => {
    const session = (draft.sessions as SessionDetail[]).find(row => row.id === f.sessionId)!;
    Object.assign(session, { status: 'AGENT_DISCUSSING', intentContractVersion: 'intent-understanding-v1', activeWorkItemId: f.work!.id,
      workingDirectory: { id: session.workspaceId, kind: 'server_local', path: process.cwd(), name: 'transaction-fixture', selectedAt: session.createdAt },
      workspaceContext: { indexComplete: true, binding: { workspaceId: session.workspaceId, providerKind: 'server_local', displayName: 'fixture',
        boundAt: session.createdAt, boundRevision: { id: 'revision', observedAt: session.createdAt }, capabilities: { read: true, write: false, command: false, test: true } } } });
    session.intentTestAuthority = issueTestAuthority(session, 'test:unit', 'fixture-grant', 1, true);
  });
  const session = f.first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!;
  // This base fixture leaves an unrelated legacy route RECEIVED. Close that fixture input before enqueuing a new one.
  await f.first.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>)[f.sessionId].find(row => row.id === f.route.id)!.status = 'REJECTED';
  }, { sessionIds: [f.sessionId] });
  const sourceEventId = randomUUID(), content = '只运行 test:unit 并保存报告，不修改源码';
  await f.first.mutateCollections(['eventsBySession'], draft => {
    (draft.eventsBySession as Record<string, CollaborationEvent[]>)[f.sessionId].push({ id: sourceEventId, sessionId: f.sessionId,
      type: 'user_message', content, toAgentIds: [], createdAt: new Date().toISOString(), metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } });
  }, { sessionIds: [f.sessionId] });
  const route = await f.context.createRoutingRecord({ session, sourceEventId, idempotencyKey: sourceEventId, rolloutMode: 'enforce_all_current_epoch' });
  const snapshot = await f.context.buildIntentSnapshot({ session, sourceEventId, currentMessage: content, latestEventSeq: 1 });
  const understanding = structuredClone(f.understanding);
  Object.assign(understanding.segments[0], { dialogueAct: 'command', goal: content, scopeRelation: 'same_requirement', suggestedAction: 'enqueue_follow_up',
    contextPolicy: 'inherit_confirmed', target: { workItemId: f.work!.id, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
    requestedEffects: [session.intentTestAuthority!.grant, session.intentTestAuthority!.reportGrant!].map(grant => ({ kind: grant.effect, target: grant.resource, evidenceRefs: ['request'] })),
    evidence: [{ refId: 'request', sourceEventId, start: 0, end: content.length, quote: content }] });
  const proposal = await new IntentUnderstandingRoutingService(f.first, f.context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ sessionId: f.sessionId, routingId: route.id, snapshotId: snapshot.id });
  assert.ok(proposal.semanticProposal?.understanding, JSON.stringify({ status: proposal.status, reasons: proposal.reasonCodes, snapshotId: proposal.snapshotId }));
  const committed = await new IntentPlanCommitService(f.first, { listAll: () => [{ type: 'test_runner' }] } as never,
    undefined, undefined, { schedule() {} } as never)
    .commit({ sessionId: f.sessionId, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: proposal.routingRevision! });
  assert.equal(committed.plan.outcome, 'applicable', JSON.stringify(committed.plan.validation));
  const reference = { sessionId: f.sessionId, stepId: committed.plan.steps[0].stepId };
  let calls = 0;
  const make = (backend: PersistenceService) => {
    const operations = new LogicalOperationStore(backend), journal = new IsolatedTestRunStore(backend);
    const service = new IntentTestExecutorService(backend, { invoke: async (input: any) => {
      calls++;
      await operations.begin({ id: input.operationId, sessionId: input.sessionId, dataEpoch: input.dataEpoch, phase: input.phase,
        admissionClass: input.admissionClass, intentStepId: input.intentStepId, workItemId: input.workItemId, executionBinding: input.executionBinding });
      await operations.reserve(input.sessionId, input.operationId, input.invocationId);
      const identity = { sessionId: input.sessionId, dataEpoch: input.dataEpoch, operationId: input.operationId, invocationId: input.invocationId };
      await journal.reserve(identity, { imageId: input.intentTestBinding.imageId, script: input.intentTestBinding.script, workingDirectory: process.cwd(),
        ownerId: 'fixture-runner', deadlineAt: input.operationDeadlineAt });
      await journal.update(identity, 'fixture-runner', { phase: 'finished', snapshotHash: 'b'.repeat(64), result: {
        stdout: 'database fixture evidence', stderr: '', exitCode: 0, timedOut: false, aborted: false, outputTruncated: false } });
      await operations.settle(input.sessionId, input.operationId, input.invocationId); return { status: 'completed' };
    } } as never, { getByIdOrKey: () => ({ id: 'tester', capabilityIds: ['cap-isolated-test'] }) } as never, { bindSession() {} } as never);
    f.services.push(service); return service;
  };
  const second = await f.connect(), one = make(f.first), two = make(second);
  if (injectFailure) {
    assert.match(f.sessionId, /^[a-f0-9-]{36}$/);
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_INTENT_REPORT_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_report BEFORE INSERT ON agent_cluster.artifacts FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_report();`);
    try {
      await assert.rejects(one.process(reference), /INJECTED_INTENT_REPORT_FAILURE/);
      const failed = await f.connect(), step = rows<IntentPlanStepRecord>(failed, 'intentPlanStepsBySession', f.sessionId)[0];
      assert.equal(step.status, 'running'); assert.equal(step.resultArtifactId, undefined);
      assert.equal(new ArtifactsService(failed).listBySession(f.sessionId).length, 0);
      assert.equal(rows<CollaborationEvent>(failed, 'eventsBySession', f.sessionId).some(row => row.id === `intent-test-result:${reference.stepId}` || row.id === `intent-test-artifact:${reference.stepId}`), false);
      assert.equal(failed.getCollection<any[]>('eventOutbox', []).some(row => [`outbox:intent-test-result:${reference.stepId}`, `outbox:intent-test-artifact:${reference.stepId}`].includes(row.id)), false);
    } finally { await pool.query('DROP TRIGGER intent_fixture_report ON agent_cluster.artifacts; DROP FUNCTION agent_cluster.intent_fixture_fail_report();'); await pool.end(); }
    await second.mutateCollections(['intentPlanStepsBySession'], draft => {
      (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>)[f.sessionId][0].processing!.leaseExpiresAt = new Date(0).toISOString();
    }, { sessionIds: [f.sessionId] });
    await two.process(reference);
  } else await Promise.all([one.process(reference), two.process(reference)]);
  const restored = await f.connect(), step = rows<IntentPlanStepRecord>(restored, 'intentPlanStepsBySession', f.sessionId)[0];
  assert.equal(step.status, 'completed'); assert.equal(calls, 1);
  const artifacts = new ArtifactsService(restored).listBySession(f.sessionId);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].id, step.resultArtifactId);
  assert.equal(artifacts[0].metadata.intentTestReport?.snapshotHash, 'b'.repeat(64));
  for (const id of [`intent-test-result:${reference.stepId}`, `intent-test-artifact:${reference.stepId}`]) {
    assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).filter(row => row.id === id).length, 1);
    assert.equal(restored.getCollection<any[]>('eventOutbox', []).filter(row => row.id === `outbox:${id}`).length, 1);
  }
  await make(restored).process(reference); assert.equal(calls, 1);
  const oldReport = structuredClone(artifacts[0]);
  const acceptance = new IntentCorrectionService(restored); f.services.push(acceptance);
  const latestRoute = rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId).find(row => row.id === route.id)!;
  const accepted = await acceptance.accept(f.sessionId, route.id, session.ownerId, { contractVersion: 'intent-correction-v1',
    expectedRoutingRevision: latestRoute.routingRevision!, idempotencyKey: randomUUID(), instruction: '重新运行 test:unit 并保存修订报告，不修改源码',
    targetWorkItemId: f.work!.id, supersedesDecisionId: null, expectedDecisionRevision: null });
  await acceptance.reconcileStop(accepted.correction);
  assert.equal(acceptance.list(f.sessionId, route.id)[0].effectReconciliation?.executions[0].disposition, 'published_report_retained');
  let classifications = 0;
  const semantic = { understand: async (input: any) => {
    classifications++; const output = structuredClone(understanding);
    Object.assign(output.segments[0], { dialogueAct: 'correction', goal: input.snapshot.currentMessage, suggestedAction: 'correct_route',
      target: { ...output.segments[0].target, correctionOfRoutingId: route.id },
      evidence: [{ refId: 'request', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
    return { status: 'valid', understanding: output };
  } };
  const other = await f.connect();
  const planner = (backend: PersistenceService) => {
    const service = new IntentCorrectionPlannerService(backend, new ContextManagementService(backend), semantic as never,
      undefined, { schedule() {} } as never, { listAll: () => [{ type: 'test_runner' }] } as never); f.services.push(service); return service;
  };
  const pool = injectFailure ? new Pool({ connectionString: databaseUrl }) : undefined;
  if (pool) {
    assert.match(route.id, /^[a-f0-9-]{36}$/);
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.external_id = 'intent-revision:${route.id}:2' THEN RAISE EXCEPTION 'INJECTED_REPORT_CORRECTION_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_version BEFORE INSERT ON agent_cluster.intent_route_revisions FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_version();`);
  }
  try { await Promise.all([planner(restored).process(accepted.correction), planner(other).process(accepted.correction)]); }
  finally { if (pool) { await pool.query('DROP TRIGGER intent_fixture_version ON agent_cluster.intent_route_revisions; DROP FUNCTION agent_cluster.intent_fixture_fail_version();'); await pool.end(); } }
  const after = await f.connect(); assert.equal(classifications, 1);
  assert.deepEqual(new ArtifactsService(after).get(oldReport.id), oldReport);
  const correction = new IntentCorrectionService(after).list(f.sessionId, route.id)[0];
  const replacement = rows<IntentPlanStepRecord>(after, 'intentPlanStepsBySession', f.sessionId).find(row => row.routingId === route.id && row.intentRevision === 2);
  if (injectFailure) {
    assert.equal(correction.status, 'rejected'); assert.equal(replacement, undefined); assert.equal(calls, 1);
    assert.ok(rows<IntentRoutingRecord>(after, 'intentRoutingRecordsBySession', f.sessionId).find(row => row.id === route.id)!.dispatchHold);
    assert.equal(new ArtifactsService(after).listBySession(f.sessionId).length, 1);
  } else {
    assert.equal(correction.status, 'applied'); assert.deepEqual(replacement?.supersedesArtifactIds, [oldReport.id]);
    await make(after).process({ sessionId: f.sessionId, stepId: replacement!.id });
    const reloaded = await f.connect(), reports = new ArtifactsService(reloaded).listBySession(f.sessionId);
    assert.equal(reports.length, 2); assert.equal(calls, 2);
    assert.deepEqual(reports.find(row => row.id === `intent-test-report:${replacement!.id}`)!.metadata.intentTestReport?.supersedesArtifactIds, [oldReport.id]);
    assert.deepEqual(reports.find(row => row.id === oldReport.id), oldReport);
  }
});

test('PostgreSQL independent artifact creators merge durable records and refuse creation after deletion', { skip: !databaseUrl, timeout: 20000 }, async t => {
  const f = await fixture(t, false), second = await f.connect();
  const one = new ArtifactsService(f.first), two = new ArtifactsService(second);
  const input = { sessionId: f.sessionId, workItemId: f.work!.id, type: 'test_report' as const, title: '并发报告', metadata: { phase: 'task_execution' as const } };
  const [firstArtifact, secondArtifact] = await Promise.all([one.create(input), two.create(input)]);
  const restored = await f.connect(), reader = new ArtifactsService(restored);
  assert.deepEqual(reader.listBySession(f.sessionId).map(row => row.id).sort(), [firstArtifact.id, secondArtifact.id].sort());
  await f.first.deleteSessionData(f.sessionId);
  await assert.rejects(two.create(input), /ARTIFACT_SESSION_UNAVAILABLE/);
  const deleted = await f.connect(); assert.deepEqual(new ArtifactsService(deleted).listBySession(f.sessionId), []);
});

async function fixture(t: TestContext, clarification: boolean, existingWork = false, noWork = false) {
  const instances: PersistenceService[] = [], services: Array<{ onModuleDestroy(): void }> = [];
  const connect = async () => { const instance = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
    instances.push(instance); await instance.initialize(); return instance; };
  const first = await connect(), sessionId = randomUUID(), sourceEventId = randomUUID();
  t.after(async () => { services.forEach(service => service.onModuleDestroy());
    await first.deleteSessionData(sessionId); for (const instance of instances) await instance.onModuleDestroy(); });
  const now = new Date().toISOString();
  let session: SessionDetail = { id: sessionId, dataEpoch: first.currentDataEpoch(), ownerId: 'intent-test-user', workspaceId: `workspace-${sessionId}`,
    title: '事务验证', originalInput: '处理新的天气查询需求', status: 'PAUSED', tokenUsed: 0, participatingAgentIds: [], createdAt: now, updatedAt: now };
  await first.mutateCollections(['sessions'], draft => { ((draft.sessions ??= []) as SessionDetail[]).push(session); });
  await new SessionLifecycleStore(first).initialize(sessionId, session.dataEpoch);
  const context = new ContextManagementService(first);
  const work = noWork || (clarification && !existingWork) ? undefined : await context.ensureInitialWorkItem(session, randomUUID());
  const old = work ? await context.recordDecision({ session, workItemId: work.id, sourceEventId: randomUUID(), kind: 'constraint', content: '超时为 10 分钟' }) : undefined;
  session = first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === sessionId)!;
  const source: CollaborationEvent = { id: sourceEventId, sessionId, type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: now, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } };
  await first.mutateCollections(['eventsBySession'], draft => {
    const all = (draft.eventsBySession ??= {}) as Record<string, CollaborationEvent[]>; (all[sessionId] ??= []).push(source);
  }, { sessionIds: [sessionId] });
  const route = await context.createRoutingRecord({ session, sourceEventId, idempotencyKey: randomUUID(), rolloutMode: 'enforce_all_current_epoch' });
  let request: ClarifyIntentRoutingInput | undefined;
  const understanding = structuredClone(intentUnderstandingExample);
  Object.assign(understanding.segments[0], { dialogueAct: 'command', goal: source.content, scopeRelation: 'ambiguous', suggestedAction: 'clarify', contextPolicy: 'ask_user',
    target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
    requestedEffects: [], prohibitions: [], dependencies: [], correction: null,
    evidence: [{ refId: 'request', sourceEventId, start: 0, end: source.content.length, quote: source.content }] });
  if (clarification) {
    await first.mutateCollections(['sessions', 'intentRoutingRecordsBySession'], draft => {
      (draft.sessions as SessionDetail[]).find(row => row.id === sessionId)!.intentContractVersion = 'intent-understanding-v1';
      (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>)[sessionId][0].semanticContractVersion = 'intent-understanding-v1';
    }, { sessionIds: [sessionId] });
    session = first.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === sessionId)!;
    const snapshot = await context.buildIntentSnapshot({ session, sourceEventId, currentMessage: source.content, latestEventSeq: 1 });
    const proposed = await new IntentUnderstandingRoutingService(first, context, { understand: async () => ({ status: 'valid', understanding }) } as never)
      .classify({ sessionId, routingId: route.id, snapshotId: snapshot.id });
    await new IntentPlanCommitService(first, { listAll: () => [{ type: 'generic_llm' }] } as never)
      .commit({ sessionId, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: proposed.routingRevision! });
    const card = rows<CollaborationEvent>(first, 'eventsBySession', sessionId).find(row => row.type === 'intent_clarification_required')!;
    assert.ok(card);
    request = { contractVersion: 'intent-clarify-v1', confirmationId: String(card.metadata.payload!.confirmationId),
      expectedRoutingRevision: Number(card.metadata.payload!.routingRevision), choice: 'independent_new', idempotencyKey: randomUUID() };
  }
  return { first, connect, services, session, sessionId, sourceEventId, work, old, route, context, request, understanding,
    reference: { sessionId, routingId: route.id } };
}

test('PostgreSQL clarification leases and receipts deduplicate independent connections and survive reload', { skip: !databaseUrl, timeout: 20000 }, async t => {
  const f = await fixture(t, true, true), second = await f.connect(); let calls = 0;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const semantic = { understand: async () => { calls++; entered(); await gate;
    const output = structuredClone(f.understanding);
    Object.assign(output.segments[0], { scopeRelation: 'independent_new_requirement', suggestedAction: 'create_independent_work_item', contextPolicy: 'clean_task_context' });
    return { status: 'valid', understanding: output }; } };
  const make = (p: PersistenceService) => { const service = new SemanticClarificationService(p, new ContextManagementService(p), semantic as never,
    new IntentPlanCommitService(p, { listAll: () => [{ type: 'generic_llm' }] } as never)); f.services.push(service); return service; };
  const one = make(f.first), two = make(second), first = one.resolve(f.reference, f.session.ownerId, f.request!);
  await started;
  await assert.rejects(two.resolve(f.reference, f.session.ownerId, f.request!), /CLARIFICATION_IN_PROGRESS/);
  await assert.rejects(two.resolve(f.reference, f.session.ownerId, { ...f.request!, choice: 'related_new', idempotencyKey: randomUUID() }), /CLARIFICATION_CHOICE_CONFLICT/);
  release(); await first;
  const replay = await two.resolve(f.reference, f.session.ownerId, f.request!); assert.equal(replay.idempotentReplay, true); assert.equal(calls, 1);
  const restored = await f.connect();
  assert.equal(rows(restored, 'workItemsBySession', f.sessionId).length, 2);
  assert.equal(rows(restored, 'intentResolutionReceiptsBySession', f.sessionId).length, 1);
  assert.equal(rows(restored, 'intentRouteRevisionsBySession', f.sessionId).length, 2);
  const resolved = rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).filter(row => row.type === 'user_confirmation_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(restored.getCollection<any[]>('eventOutbox', []).filter(row => row.id === `outbox:${resolved[0].id}`).length, 1);
});

test('PostgreSQL receipt insert failure rolls back the whole clarification activation transaction', { skip: !databaseUrl, timeout: 20000 }, async t => {
  const f = await fixture(t, true), pool = new Pool({ connectionString: databaseUrl });
  // Session ID is a generated UUID, used only in a test-local trigger on the disposable test database.
  assert.match(f.sessionId, /^[a-f0-9-]{36}$/);
  await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.session_id = (SELECT id FROM agent_cluster.sessions WHERE external_id = '${f.sessionId}') THEN RAISE EXCEPTION 'INJECTED_INTENT_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER intent_fixture_receipt BEFORE INSERT ON agent_cluster.intent_resolution_receipts
    FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_receipt();`);
  try {
    const output = structuredClone(f.understanding);
    Object.assign(output.segments[0], { scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context' });
    const service = new SemanticClarificationService(f.first, f.context, { understand: async () => ({ status: 'valid', understanding: output }) } as never,
      new IntentPlanCommitService(f.first, { listAll: () => [{ type: 'generic_llm' }] } as never)); f.services.push(service);
    await assert.rejects(service.resolve(f.reference, f.session.ownerId, f.request!), /CLARIFICATION_PROCESSING_FAILED/);
    const restored = await f.connect();
    for (const key of ['workItemsBySession', 'intentResolutionReceiptsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession']) assert.equal(rows(restored, key, f.sessionId).length, 0, key);
    const route = rows<IntentRoutingRecord>(restored, 'intentRoutingRecordsBySession', f.sessionId)[0];
    assert.equal(route.resolution, undefined); assert.equal(route.semanticClarification!.status, 'blocked');
    assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).some(row => row.type === 'user_confirmation_resolved'), false);
    assert.equal(restored.getCollection<any[]>('eventOutbox', []).some(row => row.payload?.event?.sessionId === f.sessionId && row.payload.event.type === 'user_confirmation_resolved'), false);
  } finally { await pool.query('DROP TRIGGER intent_fixture_receipt ON agent_cluster.intent_resolution_receipts; DROP FUNCTION agent_cluster.intent_fixture_fail_receipt();'); await pool.end(); }
});

for (const failCommit of [false, true]) test(`PostgreSQL concurrent correction activation ${failCommit ? 'rolls back on SQL failure without releasing the hold' : 'replaces one Decision and preserves pause'}`, { skip: !databaseUrl, timeout: 20000 }, async t => {
  const f = await fixture(t, false), acceptance = new IntentCorrectionService(f.first);
  const accepted = await acceptance.accept(f.sessionId, f.route.id, f.session.ownerId, { contractVersion: 'intent-correction-v1',
    expectedRoutingRevision: f.route.routingRevision ?? 1, idempotencyKey: randomUUID(), instruction: '超时改为 30 分钟',
    targetWorkItemId: f.work!.id, supersedesDecisionId: f.old!.id, expectedDecisionRevision: f.old!.revision });
  await acceptance.reconcileStop(accepted.correction);
  if (failCommit) {
    assert.match(f.route.id, /^[a-f0-9-]{36}$/);
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE OR REPLACE FUNCTION agent_cluster.intent_fixture_fail_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.external_id = 'intent-revision:${f.route.id}:2' THEN RAISE EXCEPTION 'INJECTED_INTENT_VERSION_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER intent_fixture_version BEFORE INSERT ON agent_cluster.intent_route_revisions
      FOR EACH ROW EXECUTE FUNCTION agent_cluster.intent_fixture_fail_version();`);
    t.after(async () => { await pool.query('DROP TRIGGER intent_fixture_version ON agent_cluster.intent_route_revisions; DROP FUNCTION agent_cluster.intent_fixture_fail_version();'); await pool.end(); });
  }
  const second = await f.connect(); let calls = 0;
  const semantic = { understand: async (input: any) => { calls++;
    const output: IntentUnderstandingOutput = structuredClone(f.understanding);
    Object.assign(output.segments[0], { dialogueAct: 'correction', scopeRelation: 'same_requirement', suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
      goal: input.snapshot.currentMessage, target: { workItemId: f.work!.id, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: f.route.id },
      correction: { supersedesDecisionId: f.old!.id, expectedDecisionRevision: f.old!.revision, replacementText: input.snapshot.currentMessage },
      evidence: [{ refId: 'request', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
    return { status: 'valid', understanding: output }; } };
  const one = new IntentCorrectionPlannerService(f.first, f.context, semantic as never),
    two = new IntentCorrectionPlannerService(second, new ContextManagementService(second), semantic as never); f.services.push(one, two);
  await Promise.all([one.process(accepted.correction), two.process(accepted.correction)]);
  const restored = await f.connect(), context = new ContextManagementService(restored);
  assert.equal(calls, 1);
  if (failCommit) {
    assert.equal(new IntentCorrectionService(restored).list(f.sessionId, f.route.id)[0].status, 'rejected');
    assert.deepEqual(context.validDecisions(f.sessionId, f.work!.id).map(row => row.content), ['超时为 10 分钟']);
    assert.ok(context.getWorkItem(f.sessionId, f.work!.id).dispatchHold);
    assert.equal(context.getWorkItem(f.sessionId, f.work!.id).requirementRevision ?? 1, 1);
    assert.equal(rows(restored, 'intentRouteRevisionsBySession', f.sessionId).length, 1);
    assert.equal(rows(restored, 'intentPlanStepsBySession', f.sessionId).length, 0);
    assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).some(row => row.type === 'intent_correction_applied'), false);
    assert.equal(restored.getCollection<any[]>('eventOutbox', []).some(row => row.payload?.event?.sessionId === f.sessionId && row.payload.event.type === 'intent_correction_applied'), false);
    return;
  }
  assert.equal(new IntentCorrectionService(restored).list(f.sessionId, f.route.id)[0].status, 'applied');
  assert.deepEqual(context.validDecisions(f.sessionId, f.work!.id).map(row => row.content), ['超时改为 30 分钟']);
  assert.equal(context.getWorkItem(f.sessionId, f.work!.id).dispatchHold, undefined);
  assert.equal(context.getWorkItem(f.sessionId, f.work!.id).requirementRevision, 2);
  assert.equal(restored.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === f.sessionId)!.status, 'PAUSED');
  assert.equal(rows(restored, 'intentRouteRevisionsBySession', f.sessionId).length, 2);
  assert.equal(rows<CollaborationEvent>(restored, 'eventsBySession', f.sessionId).filter(row => row.type === 'intent_correction_applied').length, 1);
});
