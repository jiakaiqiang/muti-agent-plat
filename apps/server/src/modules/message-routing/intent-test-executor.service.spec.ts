import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { intentUnderstandingExample, type IntentCorrection, type IntentPlanStepRecord, type LogicalOperation, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';
import { IsolatedTestRunStore } from '../runtimes/isolated-test-run-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { IntentTestExecutorService } from './intent-test-executor.service.js';
import { issueTestAuthority } from './intent-test-authority.js';
import { IntentCorrectionService } from './intent-correction.service.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import { reconcileCorrectionEffects } from './intent-correction-effects.js';

async function fixture(t: TestContext, paused = false, writeReport = false) {
  const root = await mkdtemp(join(tmpdir(), 'intent-test-executor-')), filePath = join(root, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  const prior = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  const services: IntentTestExecutorService[] = [], backends = [persistence];
  t.after(async () => { services.forEach(service => service.onModuleDestroy()); for (const backend of backends) await backend.onModuleDestroy();
    if (prior === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = prior;
    const child = relative(resolve(tmpdir()), resolve(root)); assert.ok(child.startsWith('intent-test-executor-') && !child.includes('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true }); });
  let session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1,
    title: 'test', originalInput: '只运行 test:unit，不修改源码', status: paused ? 'PAUSED' : 'AGENT_DISCUSSING', intentContractVersion: 'intent-understanding-v1',
    tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    workingDirectory: { id: 'workspace', kind: 'server_local', path: root, name: 'fixture', selectedAt: 'selected' },
    workspaceContext: { indexComplete: true, binding: { workspaceId: 'workspace', providerKind: 'server_local', displayName: 'fixture',
      boundAt: 'bound', boundRevision: { id: 'revision', observedAt: new Date().toISOString() }, capabilities: { read: true, write: false, command: false, test: true } } }
  };
  session.intentTestAuthority = issueTestAuthority(session, 'test:unit', 'grant', 1, writeReport);
  if (writeReport) session.originalInput = '只运行 test:unit 并保存测试报告，不修改源码';
  await persistence.setCollection('sessions', [session]); await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  // Existing task fixture; creation through the new ingress is exercised by the HTTP suite.
  const context = new ContextManagementService(persistence), work = { id: 'work', sessionId: session.id, title: '原任务', goal: '原任务',
    status: 'OPEN', revision: 1, requirementRevision: 1, executionEpoch: 1, inheritedDecisionIds: [], inheritedArtifactIds: [],
    createdFromEventId: 'initial', createdAt: session.createdAt, updatedAt: session.updatedAt };
  await persistence.setCollection('workItemsBySession', { session: [work] });
  session.activeWorkItemId = work.id; await persistence.setCollection('sessions', [session]);
  const message = { id: 'message', sessionId: session.id, type: 'user_message', content: session.originalInput, toAgentIds: [],
    createdAt: session.createdAt, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } };
  await persistence.setCollection('eventsBySession', { session: [message] });
  const route = await context.createRoutingRecord({ session, sourceEventId: message.id, idempotencyKey: 'route', rolloutMode: 'enforce_all_current_epoch' });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: message.id, currentMessage: message.content, latestEventSeq: 1 });
  const understanding = structuredClone(intentUnderstandingExample), segment = understanding.segments[0];
  Object.assign(segment, { dialogueAct: 'command', goal: message.content, scopeRelation: 'same_requirement', suggestedAction: 'enqueue_follow_up', contextPolicy: 'inherit_confirmed',
    target: { workItemId: work.id, agentIds: [], decisionIds: [], artifactIds: [], confirmationId: null, correctionOfRoutingId: null },
    requestedEffects: [{ kind: 'run_tests', target: session.intentTestAuthority!.grant.resource, evidenceRefs: ['request'] }],
    prohibitions: [], evidence: [{ refId: 'request', sourceEventId: message.id, start: 0, end: message.content.length, quote: message.content }] });
  if (writeReport) segment.requestedEffects.push({ kind: 'write_artifact', target: session.intentTestAuthority!.reportGrant!.resource, evidenceRefs: ['request'] });
  const proposal = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ sessionId: session.id, routingId: route.id, snapshotId: snapshot.id });
  const scheduled: unknown[] = [];
  const commit = new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'test_runner' }] } as never,
    undefined, undefined, { schedule: (ref: unknown) => scheduled.push(ref) } as never);
  const committed = await commit.commit({ sessionId: session.id, routingId: route.id, actorId: session.ownerId!, expectedRoutingRevision: proposal.routingRevision! });
  const reference = { sessionId: session.id, stepId: committed.plan.steps[0]?.stepId };
  const calls: any[] = []; let hook: (input: any) => Promise<void> = async () => {};
  let activeHook: (input: any) => Promise<void> = async () => {};
  let invokeOverride: ((input: any) => Promise<any>) | undefined;
  const make = (backend = persistence) => {
    const operations = new LogicalOperationStore(backend), journal = new IsolatedTestRunStore(backend);
    const service = new IntentTestExecutorService(backend, { invoke: async (input: any) => {
      calls.push(input); if (invokeOverride) return invokeOverride(input);
      await operations.begin({ id: input.operationId, sessionId: input.sessionId, dataEpoch: input.dataEpoch, phase: input.phase,
        admissionClass: input.admissionClass, intentStepId: input.intentStepId, workItemId: input.workItemId, executionBinding: input.executionBinding });
      await operations.reserve(input.sessionId, input.operationId, input.invocationId);
      const identity = { sessionId: input.sessionId, dataEpoch: input.dataEpoch, operationId: input.operationId, invocationId: input.invocationId };
      await journal.reserve(identity, { imageId: input.intentTestBinding.imageId, script: input.intentTestBinding.script, workingDirectory: root,
        ownerId: 'runner', deadlineAt: input.operationDeadlineAt });
      await activeHook(input);
      await journal.update(identity, 'runner', { phase: 'finished', ...(writeReport ? { snapshotHash: 'b'.repeat(64) } : {}), result: { stdout: 'audit', stderr: '', exitCode: 0, timedOut: false, aborted: false, outputTruncated: false } });
      await operations.settle(input.sessionId, input.operationId, input.invocationId);
      await hook(input); return { status: 'completed' };
    } } as never, { getByIdOrKey: () => ({ id: 'tester', capabilityIds: ['cap-isolated-test'] }) } as never, { bindSession() {} } as never);
    services.push(service); return service;
  };
  const step = () => persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session?.[0];
  const expire = () => persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
    (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>).session[0].processing!.leaseExpiresAt = new Date(0).toISOString(); });
  const repeat = async (sourceEventId: string, correctionRoutingId?: string) => {
    const current = persistence.getCollection<SessionDetail[]>('sessions', [])[0];
    const nextEvent = { ...message, id: sourceEventId };
    await persistence.mutateCollections(['eventsBySession'], draft => {
      (draft.eventsBySession as Record<string, any[]>).session.push(nextEvent);
    });
    const nextRoute = await context.createRoutingRecord({ session: current, sourceEventId, idempotencyKey: sourceEventId, rolloutMode: 'enforce_all_current_epoch' });
    const nextSnapshot = await context.buildIntentSnapshot({ session: current, sourceEventId, currentMessage: message.content, latestEventSeq: 1 });
    const nextUnderstanding = structuredClone(understanding);
    Object.assign(nextUnderstanding.segments[0], { evidence: nextUnderstanding.segments[0].evidence.map(row => ({ ...row, sourceEventId })) });
    if (correctionRoutingId) Object.assign(nextUnderstanding.segments[0], { dialogueAct: 'correction', suggestedAction: 'correct_route',
      target: { ...nextUnderstanding.segments[0].target, correctionOfRoutingId: correctionRoutingId } });
    const proposal = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding: nextUnderstanding }) } as never)
      .classify({ sessionId: session.id, routingId: nextRoute.id, snapshotId: nextSnapshot.id });
    return commit.commit({ sessionId: session.id, routingId: nextRoute.id, actorId: session.ownerId!, expectedRoutingRevision: proposal.routingRevision! });
  };
  return { persistence, filePath, backends, session, committed, scheduled, reference, calls, step, make, expire,
    repeat, setHook: (value: typeof hook) => { hook = value; }, setActiveHook: (value: typeof activeHook) => { activeHook = value; },
    setInvoke: (value: typeof invokeOverride) => { invokeOverride = value; } };
}

test('new test requests after regrant ignore old historical grant revisions before checking conflicts', async t => {
  const f = await fixture(t); await f.make().process(f.reference);
  await f.persistence.mutateCollections(['sessions'], draft => {
    const current = (draft.sessions as SessionDetail[])[0]; current.intentTestAuthority = issueTestAuthority(current, 'test:unit', 'regrant', 3);
  });
  const second = await f.repeat('second-request'); assert.equal(second.plan.outcome, 'applicable');
  await f.make().process({ sessionId: 'session', stepId: second.plan.steps[0].stepId });
  const third = await f.repeat('third-request'); assert.equal(third.plan.outcome, 'applicable');
  await f.make().process({ sessionId: 'session', stepId: third.plan.steps[0].stepId });
  assert.equal(f.calls.length, 3);
  assert.ok(f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session.every(row => row.status === 'completed'));
});

test('authorized test report, completion and Outbox commit once without source projections or a second invocation', async t => {
  const f = await fixture(t, false, true);
  assert.equal(f.committed.plan.outcome, 'applicable');
  await f.make().process(f.reference); await f.make().process(f.reference);
  const record = f.step(); assert.equal(record.status, 'completed'); assert.ok(record.resultArtifactId);
  const state = f.persistence.getCollection<any>('artifacts', {}), artifact = state.artifactsById[record.resultArtifactId!];
  assert.deepEqual(artifact.platformProjections, []); assert.deepEqual(artifact.runtimeProposals, []);
  assert.match(artifact.metadata.intentTestReport.content, /audit/);
  assert.equal(artifact.metadata.intentTestReport.snapshotHash, 'b'.repeat(64));
  assert.equal(artifact.metadata.intentTestReport.exitCode, 0);
  assert.equal(state.artifactIdsBySession.session.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].workspace.capabilities.write, false); assert.equal(f.calls[0].writeModeOverride, 'none');
  const event = f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.filter(row => row.type === 'artifact_created');
  assert.equal(event.length, 1);
  assert.equal(f.persistence.getCollection<any[]>('eventOutbox', []).filter(row => row.id === `outbox:${event[0].id}`).length, 1);
  const draft = f.persistence.snapshotState();
  const proof = reconcileCorrectionEffects(draft, { sessionId: 'session', dataEpoch: 'epoch', affectedWorkItemIds: ['work'],
    affectedExecutionIds: [f.calls[0].invocationId] } as IntentCorrection);
  assert.equal(proof.state, 'ready'); assert.equal(proof.receipts[0].disposition, 'published_report_retained');
  assert.equal(proof.receipts[0].artifactId, artifact.id); assert.match(proof.receipts[0].artifactContentHash!, /^[a-f0-9]{64}$/);
});

test('revoking only report authority before publication suppresses the report and completion', async t => {
  const f = await fixture(t, false, true);
  f.setHook(async () => { await f.persistence.mutateCollections(['sessions'], draft => {
    delete (draft.sessions as SessionDetail[])[0].intentTestAuthority!.reportGrant;
  }); });
  await f.make().process(f.reference);
  assert.equal(f.step().status, 'invalidated'); assert.equal(f.step().resultArtifactId, undefined);
  assert.equal(f.persistence.getCollection<any>('artifacts', {}).artifactIdsBySession?.session?.length ?? 0, 0);
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.some(row => row.type === 'artifact_created'), false);
});

test('report transaction failure preserves its journal result and recovery publishes without rerunning the test', async t => {
  const f = await fixture(t, false, true), write = (f.persistence as any).writeFileState;
  f.setHook(async () => { (f.persistence as any).writeFileState = (state: any) => {
    if (state.artifacts?.artifactIdsBySession?.session?.length) throw new Error('injected report transaction failure'); return write.call(f.persistence, state);
  }; });
  await assert.rejects(f.make().process(f.reference), /injected report transaction failure/);
  (f.persistence as any).writeFileState = write;
  assert.equal(f.step().resultArtifactId, undefined); assert.equal(f.step().status, 'running');
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.some(row => row.type === 'artifact_created'), false);
  await f.expire(); await f.make().process(f.reference);
  assert.equal(f.step().status, 'completed'); assert.ok(f.step().resultArtifactId); assert.equal(f.calls.length, 1);
});

test('a test report cannot be published without the actual snapshot hash', async t => {
  const f = await fixture(t, false, true);
  f.setHook(async () => { await f.persistence.mutateCollections(['logicalOperationsBySession'], draft => {
    delete (draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0].isolatedTestAttempts![0].snapshotHash;
  }); });
  await f.make().process(f.reference);
  assert.equal(f.step().failureCode, 'INTENT_TEST_REPORT_EVIDENCE_INCOMPLETE'); assert.equal(f.step().resultArtifactId, undefined);
});

test('failed assertions save failure evidence while timeout and infrastructure errors never publish a report', async t => {
  for (const error of ['ISOLATED_TEST_FAILED', 'ISOLATED_TEST_TIMEOUT', 'ISOLATED_TEST_MEMORY_LIMIT']) {
    const f = await fixture(t, false, true);
    f.setHook(async () => { await f.persistence.mutateCollections(['logicalOperationsBySession'], draft => {
      const result = (draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0].isolatedTestAttempts![0].result!;
      Object.assign(result, { exitCode: 3, error, stderr: 'assertion failed', timedOut: error === 'ISOLATED_TEST_TIMEOUT' });
    }); });
    await f.make().process(f.reference); await f.make().process(f.reference);
    assert.equal(f.step().status, 'failed'); assert.equal(f.step().failureCode, error); assert.equal(f.calls.length, 1);
    if (error === 'ISOLATED_TEST_FAILED') {
      const report = f.persistence.getCollection<any>('artifacts', {}).artifactsById[f.step().resultArtifactId!];
      assert.equal(report.metadata.status, 'failed'); assert.equal(report.metadata.intentTestReport.exitCode, 3);
      assert.match(report.metadata.intentTestReport.content, /assertion failed/);
    } else assert.equal(f.step().resultArtifactId, undefined);
    assert.equal(f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.some(row => row.id === `intent-test-result:${f.reference.stepId}`), false);
  }
});

test('ordinary plan commit cannot use the test dispatcher to bypass versioned correction acceptance', async t => {
  const f = await fixture(t); await f.make().process(f.reference);
  const routeId = f.step().routingId;
  const result = await f.repeat('bypass-correction', routeId);
  assert.equal(result.plan.outcome, 'blocked');
  assert.ok(result.plan.validation.errorCodes.includes('INTENT_CORRECTION_REQUIRES_VERSIONED_ENDPOINT'));
  assert.equal(f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.scheduled.length, 1);
});

async function executionCorrectionFixture(t: TestContext, options: { paused?: boolean; revoke?: boolean; wrongResource?: boolean;
  extraEffect?: boolean; dispatchLost?: boolean; transactionFailure?: boolean; report?: boolean; noExecution?: boolean; corruptReport?: boolean; revokeReport?: boolean; oldTestFails?: boolean } = {}) {
  const f = await fixture(t, false, options.report), scheduled: Array<{ sessionId: string; stepId: string }> = [];
  if (options.oldTestFails) f.setHook(async () => { await f.persistence.mutateCollections(['logicalOperationsBySession'], draft => {
    Object.assign((draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0].isolatedTestAttempts![0].result!, { exitCode: 3, error: 'ISOLATED_TEST_FAILED' });
  }); });
  if (options.report) await f.make().process(f.reference);
  f.setHook(async () => {});
  if (options.paused) await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].status = 'PAUSED'; });
  const originalWrite = (f.persistence as any).writeFileState;
  const planner = new IntentCorrectionPlannerService(f.persistence, new ContextManagementService(f.persistence), { understand: async (input: any) => {
    if (options.corruptReport) await f.persistence.mutateCollections(['artifacts'], draft => {
      (draft.artifacts as any).artifactsById[f.step().resultArtifactId!].metadata.intentTestReport.content = 'corrupted evidence';
    });
    if (options.revokeReport) await f.persistence.mutateCollections(['sessions'], draft => { delete (draft.sessions as SessionDetail[])[0].intentTestAuthority!.reportGrant; });
    if (options.revoke) await f.persistence.mutateCollections(['sessions'], draft => {
      (draft.sessions as SessionDetail[])[0].intentTestAuthority!.grant.revokedAt = new Date().toISOString();
    });
    const understanding = structuredClone(intentUnderstandingExample), segment = understanding.segments[0];
    Object.assign(segment, { dialogueAct: 'correction', goal: input.snapshot.currentMessage, scopeRelation: 'same_requirement', suggestedAction: 'correct_route',
      contextPolicy: 'inherit_confirmed', target: { workItemId: 'work', correctionOfRoutingId: input.correction.routingId,
        decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null }, correction: null,
      requestedEffects: options.noExecution ? [] : [{ kind: 'run_tests', target: { kind: 'test_runner', refId: options.wrongResource ? 'ungranted-runner' : f.session.intentTestAuthority!.binding.resourceId }, evidenceRefs: ['change'] },
        ...(options.report ? [{ kind: 'write_artifact', target: f.session.intentTestAuthority!.reportGrant!.resource, evidenceRefs: ['change'] }] : []),
        ...(options.extraEffect ? [{ kind: 'modify_source', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['change'] }] : [])],
      prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: 'workspace' }, scope: 'message', evidenceRefs: ['change'] }], dependencies: [],
      evidence: [{ refId: 'change', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
    if (options.transactionFailure) (f.persistence as any).writeFileState = (state: any) => {
      if (state.intentCorrectionsBySession?.session?.some((row: any) => row.status === 'applied')) throw new Error('injected correction activation failure');
      return originalWrite.call(f.persistence, state);
    };
    return { status: 'valid', understanding };
  } } as never, undefined, { schedule: (ref: { sessionId: string; stepId: string }) => {
    if (options.dispatchLost) throw new Error('lost postcommit notification'); scheduled.push(ref);
  } } as never, { listAll: () => [{ type: 'test_runner' }] } as never);
  const service = new IntentCorrectionService(f.persistence, undefined, undefined, planner);
  t.after(() => { (f.persistence as any).writeFileState = originalWrite; service.onModuleDestroy(); planner.onModuleDestroy(); });
  const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
  const request = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision,
    idempotencyKey: 'test-correction', instruction: options.noExecution ? '纠正前面的要求：暂不执行' : options.report ? '纠正前面的测试请求：重新运行 test:unit 并保存报告，不修改源码' : '纠正前面的测试请求：运行 test:unit，不修改源码', targetWorkItemId: 'work', supersedesDecisionId: null, expectedDecisionRevision: null };
  const accepted = await service.accept('session', route.id, 'user', request);
  await service.reconcileStop(accepted.correction);
  return { ...f, scheduled, planner, service, request, route, correction: () => service.list('session', route.id)[0] };
}

test('completed report corrections retain verified history and publish a linked replacement once', async t => {
  const f = await executionCorrectionFixture(t, { report: true });
  assert.equal(f.correction().status, 'applied'); assert.deepEqual(f.correction().affectedExecutionIds, [f.calls[0].invocationId]);
  assert.equal(f.correction().effectReconciliation?.executions[0].disposition, 'published_report_retained');
  const oldId = f.step().resultArtifactId!, before = f.persistence.getCollection<any>('artifacts', {}).artifactsById[oldId];
  const queued = f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1];
  assert.deepEqual(queued.supersedesArtifactIds, [oldId]); assert.equal(queued.status, 'queued');
  await f.make().process({ sessionId: 'session', stepId: queued.id });
  await f.service.accept('session', f.route.id, 'user', f.request); await f.service.reconcileStop(f.correction());
  const restarted = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restarted.initialize(); f.backends.push(restarted);
  await f.make(restarted).process({ sessionId: 'session', stepId: queued.id });
  const artifacts = restarted.getCollection<any>('artifacts', {});
  assert.deepEqual(artifacts.artifactsById[oldId], before); assert.equal(artifacts.artifactIdsBySession.session.length, 2); assert.equal(f.calls.length, 2);
  const replacement = artifacts.artifactsById[`intent-test-report:${queued.id}`];
  assert.deepEqual(replacement.metadata.intentTestReport.supersedesArtifactIds, [oldId]);
  const event = restarted.getCollection<Record<string, any[]>>('eventsBySession', {}).session.find(row => row.type === 'intent_correction_applied');
  assert.deepEqual(event.metadata.payload.retainedArtifactIds, [oldId]); assert.equal(f.step().status, 'completed');
});

test('record-only correction retains a finished report without issuing another test or claiming rollback', async t => {
  for (const oldTestFails of [false, true]) {
  const f = await executionCorrectionFixture(t, { report: true, noExecution: true, oldTestFails });
  assert.equal(f.correction().status, 'applied'); assert.equal(f.scheduled.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.correction().effectReconciliation?.executions[0].disposition, 'published_report_retained');
  assert.equal(f.persistence.getCollection<any>('artifacts', {}).artifactIdsBySession.session.length, 1);
  assert.equal(f.step().status, oldTestFails ? 'failed' : 'completed');
  }
});

test('missing saved report or result marker cannot bypass the correction hold as an empty effect set', async t => {
  for (const missing of ['artifact', 'marker']) {
    const f = await fixture(t, false, true); await f.make().process(f.reference);
    await f.persistence.mutateCollections(['artifacts', 'intentPlanStepsBySession'], draft => {
      if (missing === 'artifact') delete (draft.artifacts as any).artifactsById[f.step().resultArtifactId!];
      else delete (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>).session[0].resultArtifactId;
    });
    const service = new IntentCorrectionService(f.persistence); t.after(() => service.onModuleDestroy());
    const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
    const accepted = await service.accept('session', route.id, 'user', { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision,
      idempotencyKey: 'missing-report', instruction: '纠正测试要求', targetWorkItemId: 'work', supersedesDecisionId: null, expectedDecisionRevision: null });
    assert.deepEqual(accepted.correction.affectedExecutionIds, [f.calls[0].invocationId]);
    await service.reconcileStop(accepted.correction); assert.equal(service.list('session', route.id)[0].status, 'reconciliation_required');
    assert.equal(f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0].currentIntentRevision, 1);
  }
});

test('replacement report write failure preserves the old report and recovery publishes its lineage without rerunning', async t => {
  const f = await executionCorrectionFixture(t, { report: true }), write = (f.persistence as any).writeFileState;
  const before = f.persistence.getCollection<any>('artifacts', {}), newStep = f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1];
  const reference = { sessionId: 'session', stepId: newStep.id };
  f.setHook(async () => { (f.persistence as any).writeFileState = (state: any) => {
    if (state.artifacts?.artifactIdsBySession?.session?.length > 1) throw new Error('replacement report write failed'); return write.call(f.persistence, state);
  }; });
  await assert.rejects(f.make().process(reference), /replacement report write failed/); (f.persistence as any).writeFileState = write;
  assert.deepEqual(f.persistence.getCollection('artifacts', {}), before);
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
    (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>).session[1].processing!.leaseExpiresAt = new Date(0).toISOString();
  });
  const reloaded = new PersistenceService({ backend: 'file', filePath: f.filePath }); await reloaded.initialize(); f.backends.push(reloaded);
  await f.make(reloaded).process(reference);
  const artifacts = reloaded.getCollection<any>('artifacts', {});
  assert.equal(f.calls.length, 2); assert.equal(artifacts.artifactIdsBySession.session.length, 2);
  assert.deepEqual(artifacts.artifactsById[before.artifactIdsBySession.session[0]], before.artifactsById[before.artifactIdsBySession.session[0]]);
  assert.deepEqual(artifacts.artifactsById[`intent-test-report:${newStep.id}`].metadata.intentTestReport.supersedesArtifactIds, before.artifactIdsBySession.session);
});

test('report corruption, revocation or correction commit failure keeps the hold and publishes no replacement', async t => {
  for (const options of [{ corruptReport: true }, { revokeReport: true }, { transactionFailure: true }]) {
    const f = await executionCorrectionFixture(t, { report: true, ...options });
    assert.notEqual(f.correction().status, 'applied'); assert.equal(f.scheduled.length, 0); assert.equal(f.calls.length, 1);
    assert.equal(f.persistence.getCollection<any>('artifacts', {}).artifactIdsBySession.session.length, 1);
    const current = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
    assert.equal(current.currentIntentRevision, 1); assert.equal(current.dispatchHold.correctionId, f.correction().id);
    if (options.corruptReport) assert.equal(f.correction().status, 'reconciliation_required');
  }
});

test('report retention requires intact ownership, historical grants, body, invocation and result evidence', async t => {
  const f = await fixture(t, false, true); await f.make().process(f.reference);
  const state = f.persistence.snapshotState(), id = f.step().resultArtifactId!;
  const correction = { sessionId: 'session', dataEpoch: 'epoch', affectedWorkItemIds: ['work'], affectedExecutionIds: [f.calls[0].invocationId] } as IntentCorrection;
  const changes = [
    (d: any) => { delete d.intentPlanStepsBySession.session[0].resultArtifactId; },
    (d: any) => { d.artifacts.artifactsById[id].metadata.status = 'failed'; },
    (d: any) => { delete d.artifacts.artifactsById[id]; },
    (d: any) => { d.artifacts.artifactsById[id].sessionId = 'foreign'; },
    (d: any) => { d.artifacts.artifactsById[id].metadata.intentTestReport.content = 'fake'; },
    (d: any) => { d.artifacts.artifactsById[id].metadata.intentTestReport.invocationId = 'foreign'; },
    (d: any) => { d.artifacts.artifactIdsBySession.session = []; },
    (d: any) => { d.intentRouteRevisionsBySession.session[0].authorityGrants = d.intentRouteRevisionsBySession.session[0].authorityGrants.filter((row: any) => row.effect !== 'write_artifact'); },
    (d: any) => { d.logicalOperationsBySession.session[0].isolatedTestAttempts[0].result.timedOut = true; },
    (d: any) => { d.workspaceWritebacks = [{ sessionId: 'session', invocationId: f.calls[0].invocationId }]; }
  ];
  for (const change of changes) { const draft = structuredClone(state); change(draft); assert.equal(reconcileCorrectionEffects(draft, correction).state, 'unsupported'); }
});

test('correction activates a queued replacement test with new binding; duplicate acceptance cannot dispatch twice', async t => {
  const f = await executionCorrectionFixture(t);
  assert.equal(f.correction().status, 'applied'); assert.equal(f.scheduled.length, 1);
  const queued = f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1];
  assert.equal(queued.status, 'queued'); assert.equal(queued.step.action, 'correct_route');
  assert.equal(queued.step.executionBinding.intentRevision, 2); assert.equal(queued.step.executionBinding.requirementRevision, 2);
  assert.equal(queued.step.executionBinding.executionEpoch, 2); assert.equal(f.step().status, 'invalidated');
  const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
  assert.equal(route.actionStatus, 'pending'); assert.equal(route.dispatchHold, undefined);
  await f.make().process(f.scheduled[0]); await f.make().process(f.scheduled[0]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].executionBinding.intentRevision, 2);
  assert.equal(f.calls[0].intentTestBinding.script, 'test:unit');
  const replay = await f.service.accept('session', f.route.id, 'user', f.request);
  assert.equal(replay.idempotentReplay, true); await f.planner.process(replay.correction); assert.equal(f.scheduled.length, 1);
  assert.equal(f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1].status, 'completed');
});

test('paused, revoked, wrong-resource and excessive-effect corrections never release holds or dispatch', async t => {
  for (const options of [{ paused: true }, { revoke: true }, { wrongResource: true }, { extraEffect: true }]) {
    const f = await executionCorrectionFixture(t, options);
    assert.notEqual(f.correction().status, 'applied', JSON.stringify(options)); assert.equal(f.scheduled.length, 0);
    const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
    assert.equal(route.currentIntentRevision, 1); assert.equal(route.dispatchHold.correctionId, f.correction().id);
    assert.equal(f.service.history('session', f.route.id).length, 1); assert.equal(f.calls.length, 0);
    if (options.paused) assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  }
});

test('correction activation write failure cannot publish a queued replacement or release its hold', async t => {
  const f = await executionCorrectionFixture(t, { transactionFailure: true });
  assert.equal(f.scheduled.length, 0); assert.notEqual(f.correction().status, 'applied');
  assert.equal(f.service.history('session', f.route.id).length, 1);
  assert.equal(f.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session.length, 1);
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0].dispatchHold.correctionId, f.correction().id);
});

test('lost correction postcommit notification recovers the persisted queued test once', async t => {
  const f = await executionCorrectionFixture(t, { dispatchLost: true }); assert.equal(f.correction().status, 'applied');
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restored.initialize(); f.backends.push(restored);
  const executor = f.make(restored); executor.onApplicationBootstrap();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && restored.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1].status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(restored.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[1].status, 'completed');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].executionBinding.intentRevision, 2);
});

test('running test correction waits for disposal then activates once; the old result cannot publish', async t => {
  for (const changeDuringClassification of [false, true]) {
  const f = await fixture(t);
  let classifications = 0;
  const planner = new IntentCorrectionPlannerService(f.persistence, new ContextManagementService(f.persistence), { understand: async (input: any) => {
    classifications++;
    if (changeDuringClassification) await f.persistence.mutateCollections(['logicalOperationsBySession'], draft => {
      (draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0].isolatedTestAttempts![0].cleanupRequired = true;
    });
    const understanding = structuredClone(intentUnderstandingExample), segment = understanding.segments[0];
    Object.assign(segment, { dialogueAct: 'correction', goal: input.snapshot.currentMessage, scopeRelation: 'same_requirement', suggestedAction: 'correct_route',
      contextPolicy: 'inherit_confirmed', target: { workItemId: 'work', correctionOfRoutingId: input.correction.routingId,
        decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null }, correction: null, requestedEffects: [], prohibitions: [], dependencies: [],
      evidence: [{ refId: 'change', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] });
    return { status: 'valid', understanding };
  } } as never);
  // A positive runtime response deliberately precedes actual journal disposal.
  const service = new IntentCorrectionService(f.persistence, undefined, { cancelIntentExecutionsAndWait: async () => ({ stopConfirmed: true }) } as never, planner);
  t.after(() => { service.onModuleDestroy(); planner.onModuleDestroy(); });
  let correction!: IntentCorrection;
  f.setActiveHook(async input => {
    const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
    correction = (await service.accept('session', route.id, 'user', { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision,
      idempotencyKey: 'running-correction', instruction: '改为只记录测试要求，暂不运行', targetWorkItemId: 'work', supersedesDecisionId: null, expectedDecisionRevision: null })).correction;
    assert.deepEqual(correction.affectedExecutionIds, [input.invocationId]);
    await service.reconcileStop(correction);
    assert.equal(service.list('session', route.id)[0].status, 'reconciliation_required');
    assert.equal(classifications, 0);
  });
  await f.make().process(f.reference);
  await service.reconcileStop(correction);
  const applied = service.list('session', correction.routingId)[0];
  if (changeDuringClassification) {
    assert.equal(applied.status, 'reconciliation_required'); assert.equal(classifications, 1);
    assert.equal(applied.effectReconciliation, undefined);
    const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
    assert.equal(route.currentIntentRevision, 1); assert.equal(route.dispatchHold.correctionId, correction.id);
    assert.equal(service.history('session', correction.routingId).length, 1);
    assert.equal(f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.some(row => row.type === 'intent_correction_applied'), false);
    continue;
  }
  assert.equal(applied.status, 'applied'); assert.equal(classifications, 1);
  assert.equal(applied.effectReconciliation?.executions[0].disposition, 'isolated_scratch_discarded');
  assert.equal(applied.effectReconciliation?.executions[0].resultKnown, true);
  const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
  assert.equal(route.currentIntentRevision, 2); assert.equal(route.executionEpoch, 2); assert.equal(route.dispatchHold, undefined);
  assert.equal(route.semanticPlan.intentRevision, 2);
  const events = f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session;
  assert.equal(events.filter(row => row.type === 'intent_correction_applied').length, 1);
  assert.equal(events.some(row => row.id === `intent-test-result:${f.reference.stepId}`), false);
  await service.reconcileStop(correction); assert.equal(classifications, 1); assert.equal(f.calls.length, 1);
  }
});

test('disposal reconciliation requires the historical plan, exact runner identity and absence of writeback', async t => {
  const f = await fixture(t); await f.make().process(f.reference);
  const state = f.persistence.snapshotState(), input = f.calls[0];
  const correction = { sessionId: 'session', dataEpoch: 'epoch', affectedWorkItemIds: ['work'], affectedExecutionIds: [input.invocationId] } as IntentCorrection;
  assert.equal(reconcileCorrectionEffects(state, correction).state, 'ready');
  const op = (draft: any) => draft.logicalOperationsBySession.session[0];
  const cases: Array<[string, 'pending' | 'unsupported', (draft: any) => void]> = [
    ['active execution', 'pending', d => { op(d).activeInvocationId = input.invocationId; }],
    ['unconfirmed stop', 'pending', d => { op(d).stopState = 'unconfirmed'; }],
    ['pending cleanup', 'pending', d => { op(d).isolatedTestAttempts[0].cleanupRequired = true; }],
    ['unconfirmed container', 'pending', d => { op(d).isolatedTestAttempts[0].stopConfirmed = false; }],
    ['missing proof', 'unsupported', d => { delete op(d).isolatedTestAttempts[0].authorityBinding; }],
    ['different identity', 'unsupported', d => { op(d).isolatedTestAttempts[0].identityHash = 'foreign'; }],
    ['different container', 'unsupported', d => { op(d).isolatedTestAttempts[0].containerName = 'foreign'; }],
    ['different script', 'unsupported', d => { op(d).isolatedTestAttempts[0].script = 'test'; }],
    ['different image', 'unsupported', d => { op(d).isolatedTestAttempts[0].imageId = 'foreign'; }],
    ['missing historical version', 'unsupported', d => { d.intentRouteRevisionsBySession.session = []; }],
    ['missing authority', 'unsupported', d => { d.intentRouteRevisionsBySession.session[0].authorityGrants = []; }],
    ['different scope', 'unsupported', d => { d.intentPlanStepsBySession.session[0].step.effectScope.effects[0].kind = 'modify_source'; }],
    ['writeback record', 'unsupported', d => { d.workspaceWritebacks = [{ sessionId: 'session', invocationId: input.invocationId }]; }],
    ['duplicate operation', 'unsupported', d => { d.logicalOperationsBySession.session.push(structuredClone(op(d))); }],
  ];
  for (const [label, expected, change] of cases) { const draft = structuredClone(state); change(draft); assert.equal(reconcileCorrectionEffects(draft, correction).state, expected, label); }
  const lost = structuredClone(state); (op(lost).isolatedTestAttempts[0]).result = { error: 'ISOLATED_TEST_RESULT_LOST' };
  const proof = reconcileCorrectionEffects(lost, correction); assert.equal(proof.state, 'ready'); assert.equal(proof.receipts[0].resultKnown, false);
});

test('committed test dispatch publishes once and exposes only the authorized script, never shell/source/artifact authority', async t => {
  const f = await fixture(t); assert.equal(f.committed.plan.outcome, 'applicable'); assert.equal(f.scheduled.length, 1); assert.equal(f.step().status, 'queued');
  await f.make().process(f.reference); await f.make().process(f.reference);
  assert.equal(f.calls.length, 1); assert.equal(f.step().status, 'completed'); assert.equal(f.step().processing?.attemptsUsed, 1);
  assert.equal(f.calls[0].intentTestBinding.script, 'test:unit'); assert.deepEqual(f.calls[0].workspace.capabilities, { read: false, write: false, command: false, test: true });
  const events = f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.filter(row => row.id === `intent-test-result:${f.reference.stepId}`);
  assert.equal(events.length, 1); assert.equal(f.persistence.getCollection<any[]>('eventOutbox', []).filter(row => row.id === `outbox:${events[0].id}`).length, 1);
  assert.equal(f.persistence.getCollection<Record<string, unknown[]>>('tasksBySession', {}).session?.length ?? 0, 0);
  assert.deepEqual(f.persistence.getCollection('artifacts', {}), {});
});

test('two executor instances cannot reserve a second test while the first owns the lease', async t => {
  const f = await fixture(t); let release!: () => void, started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  f.setHook(async () => { started(); await new Promise<void>(done => { release = done; }); });
  const pending = f.make().process(f.reference); await ready; await f.make().process(f.reference);
  assert.equal(f.calls.length, 1); release(); await pending; assert.equal(f.step().status, 'completed');
});

test('revocation after runtime completion fences publication while retaining the result journal', async t => {
  const f = await fixture(t);
  f.setHook(async () => { await f.persistence.mutateCollections(['sessions'], draft => {
    (draft.sessions as SessionDetail[])[0].intentTestAuthority!.grant.revokedAt = new Date().toISOString(); }); });
  await f.make().process(f.reference); assert.equal(f.step().status, 'invalidated');
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('eventsBySession', {}).session.some(row => row.id === `intent-test-result:${f.reference.stepId}`), false);
  assert.equal(f.persistence.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {}).session[0].isolatedTestAttempts![0].result?.stdout, 'audit');
});

test('failed publish transaction restores the running lease and disk recovery publishes without rerunning tests', async t => {
  const f = await fixture(t), write = (f.persistence as any).writeFileState;
  f.setHook(async () => { (f.persistence as any).writeFileState = () => { throw new Error('injected publish write failure'); }; });
  await assert.rejects(f.make().process(f.reference), /injected publish/); (f.persistence as any).writeFileState = write;
  assert.equal(f.step().status, 'running'); await f.expire();
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath }); await restored.initialize(); f.backends.push(restored);
  await f.make(restored).process(f.reference); assert.equal(f.calls.length, 1);
  assert.equal(restored.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {}).session[0].status, 'completed');
});

test('recovery after a reserved dispatch with no journal fails explicitly and never creates a replacement invocation', async t => {
  const f = await fixture(t), service = f.make();
  f.setInvoke(async () => { service.onModuleDestroy(); return { status: 'failed' }; });
  await service.process(f.reference); assert.equal(f.step().status, 'running'); await f.expire();
  await f.make().process(f.reference); assert.equal(f.calls.length, 1); assert.equal(f.step().status, 'failed');
  assert.equal(f.step().failureCode, 'ISOLATED_TEST_RESULT_LOST');
});

test('paused sessions do not implicitly resume or enqueue an authorized test', async t => {
  const f = await fixture(t, true); assert.equal(f.committed.plan.outcome, 'blocked'); assert.equal(f.scheduled.length, 0);
  assert.equal(f.step(), undefined); assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
});

test('late test completion never changes the action state of a newer intent revision', async t => {
  const f = await fixture(t);
  f.setHook(async () => { await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    const route = (draft.intentRoutingRecordsBySession as Record<string, any[]>).session[0];
    route.effectiveIntentRevision = 2; route.actionStatus = 'applying'; route.routingRevision = 20;
  }); });
  await f.make().process(f.reference); assert.equal(f.step().status, 'invalidated');
  const route = f.persistence.getCollection<Record<string, any[]>>('intentRoutingRecordsBySession', {}).session[0];
  assert.equal(route.actionStatus, 'applying'); assert.equal(route.routingRevision, 20);
});

test('restart reconciliation waits for the old container and fails a lost result without resetting the attempt', async t => {
  const f = await fixture(t), service = f.make(); let identity!: { sessionId: string; dataEpoch: string; operationId: string; invocationId: string };
  f.setInvoke(async input => {
    const operations = new LogicalOperationStore(f.persistence), journal = new IsolatedTestRunStore(f.persistence);
    await operations.begin({ id: input.operationId, sessionId: input.sessionId, dataEpoch: input.dataEpoch, phase: input.phase,
      admissionClass: input.admissionClass, intentStepId: input.intentStepId, workItemId: input.workItemId, executionBinding: input.executionBinding });
    await operations.reserve(input.sessionId, input.operationId, input.invocationId);
    identity = { sessionId: input.sessionId, dataEpoch: input.dataEpoch, operationId: input.operationId, invocationId: input.invocationId };
    await journal.reserve(identity, { imageId: input.intentTestBinding.imageId, script: input.intentTestBinding.script,
      workingDirectory: f.session.workingDirectory!.path!, ownerId: 'old-worker', deadlineAt: input.operationDeadlineAt });
    await journal.update(identity, 'old-worker', { phase: 'running', stopConfirmed: false, cleanupRequired: true });
    service.onModuleDestroy(); return { status: 'failed' };
  });
  await service.process(f.reference); await f.expire();
  await f.make().process(f.reference); assert.equal(f.step().status, 'reconciliation_required'); assert.equal(f.calls.length, 1);
  const journal = new IsolatedTestRunStore(f.persistence, () => Date.now() + 31000);
  assert.ok(await journal.claimRecovery(identity, 'recovery'));
  await journal.finishRecovery(identity, 'recovery', true);
  await f.make().process(f.reference); assert.equal(f.step().status, 'failed'); assert.equal(f.step().failureCode, 'ISOLATED_TEST_RESULT_LOST');
  assert.equal(f.calls.length, 1); assert.equal(f.step().processing?.attemptsUsed, 1);
});
