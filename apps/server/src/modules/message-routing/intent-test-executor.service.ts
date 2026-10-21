import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable, Optional, type OnModuleDestroy, type OnApplicationBootstrap } from '@nestjs/common';
import { isIsolatedTestScope, type Artifact, type CollaborationEvent, type ContextEnvelopeV2, type IntentPlanStepRecord, type IntentRouteRevision,
  type IntentRoutingRecord, type LogicalOperation, type SessionDetail } from '@agent-cluster/shared';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { RuntimeInvocationService } from '../runtime-invocation/runtime-invocation.service.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { assertIntentExecutionCurrent, INTENT_EXECUTION_COLLECTIONS } from './intent-execution-guard.js';
import { appendCorrectionEvent as appendEvent, correctionRows as rows } from './intent-correction-state.js';
import { currentTestGrant, currentTestReportGrant } from './intent-test-authority.js';
import { appendArtifactInDraft } from '../artifacts/artifact-store.js';
import { testReportMetadata } from './intent-test-report.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'logicalOperationsBySession', 'artifacts', 'eventsBySession', 'eventOutbox', ...INTENT_EXECUTION_COLLECTIONS];
type Reference = { sessionId: string; stepId: string };
export const isTestStep = (step: IntentPlanStepRecord['step']) => ['create_initial_work_item', 'enqueue_follow_up', 'correct_route'].includes(step.action) && isIsolatedTestScope(step.effectScope);

/** One persisted plan owns one physical test invocation. Recovery never reruns an uncertain test. */
@Injectable()
export class IntentTestExecutorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly controllers = new Map<string, { sessionId: string; controller: AbortController }>();
  private destroyed = false;
  constructor(private readonly persistence: PersistenceService, private readonly invocation: RuntimeInvocationService,
    private readonly agents: AgentsService, private readonly bindings: InvocationWorkspaceBindingsService,
    @Optional() private readonly events?: EventsService) {}

  onApplicationBootstrap() {
    const groups = this.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {});
    for (const group of Object.values(groups)) for (const record of group) {
      if (isTestStep(record.step) && ['queued', 'running', 'reconciliation_required'].includes(record.status)) this.schedule({ sessionId: record.sessionId, stepId: record.id });
    }
  }
  onModuleDestroy() {
    this.destroyed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); for (const { controller } of this.controllers.values()) controller.abort();
  }
  /** Called only after authority commits. Cross-process owners also revalidate their durable lease. */
  authorityChanged(sessionId: string) {
    const steps = this.persistence.getCollection<Record<string, IntentPlanStepRecord[]>>('intentPlanStepsBySession', {})[sessionId] ?? [];
    const session = this.persistence.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === sessionId);
    const grant = session && currentTestGrant(session);
    const versions = this.persistence.getCollection<Record<string, IntentRouteRevision[]>>('intentRouteRevisionsBySession', {})[sessionId] ?? [];
    for (const record of steps) if (isTestStep(record.step) && ['queued', 'running'].includes(record.status)) {
      const valid = grant && versions.some(version => version.routingId === record.routingId && version.intentRevision === record.intentRevision &&
        version.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant)) &&
        (!record.step.effectScope.effects.some(effect => effect.kind === 'write_artifact') ||
          version.authorityGrants?.some(saved => isDeepStrictEqual(saved, session && currentTestReportGrant(session)))));
      if (!valid) { this.controllers.get(record.id)?.controller.abort(); this.schedule({ sessionId, stepId: record.id }); }
    }
  }
  schedule(reference: Reference, at = Date.now()) {
    if (this.destroyed || this.timers.has(reference.stepId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(reference.stepId);
      void this.process(reference).catch(() => this.schedule(reference, Date.now() + 30001));
    }, Math.max(1, Math.min(2147483647, at - Date.now() + 1)));
    timer.unref(); this.timers.set(reference.stepId, timer);
  }
  process(reference: Reference) {
    if (this.destroyed) return Promise.resolve();
    const existing = this.pending.get(reference.stepId); if (existing) return existing;
    const promise = this.run(reference).finally(() => this.pending.delete(reference.stepId));
    this.pending.set(reference.stepId, promise); return promise;
  }
  private async run(reference: Reference) {
    const ownerId = randomUUID();
    const claim = await this.mutate(reference, (draft, record, session, route) => {
      if (!['queued', 'running', 'reconciliation_required'].includes(record.status)) return;
      const now = Date.now(), processing = record.processing;
      if (processing && Date.parse(processing.leaseExpiresAt) > now) return { wakeAt: Date.parse(processing.leaseExpiresAt) };
      record.processing = { ...processing, ownerId, leaseExpiresAt: new Date(now + 30000).toISOString(),
        deadlineAt: processing?.deadlineAt ?? new Date(now + 120000).toISOString(), attemptsUsed: processing?.attemptsUsed ?? 0 };
      // A previous reservation is not a reason to create a new invocation, even if no result survived.
      if (record.processing.attemptsUsed) return { recover: true };
      try { assertCurrent(draft, record, session); }
      catch { return { event: finish(draft, record, route, 'invalidated', 'INTENT_EXECUTION_SUPERSEDED') }; }
      if (!(Date.parse(record.processing.deadlineAt) > now)) return { event: finish(draft, record, route, 'failed', 'INTENT_TEST_BUDGET_EXHAUSTED') };
      record.status = 'running'; record.processing.invocationId = randomUUID(); record.processing.attemptsUsed = 1;
      record.updatedAt = new Date(now).toISOString(); route.actionStatus = 'applying'; route.updatedAt = record.updatedAt;
      route.routingRevision = (route.routingRevision ?? 1) + 1;
      return { session: structuredClone(session), record: structuredClone(record) };
    });
    if (claim?.event) this.events?.acceptCommitted(claim.event);
    if (claim?.wakeAt) { this.schedule(reference, claim.wakeAt); return; }
    if (claim?.recover) { await this.publish(reference, ownerId); return; }
    if (!claim?.session || !claim.record) return;
    const controller = new AbortController(); this.controllers.set(reference.stepId, { sessionId: reference.sessionId, controller });
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return; renewing = true;
      void this.mutate(reference, (draft, record, session) => {
        if (record.processing?.ownerId !== ownerId || record.status !== 'running') { controller.abort(); return; }
        assertCurrent(draft, record, session); record.processing.leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
      }).catch(() => controller.abort()).finally(() => { renewing = false; });
    }, 10000); heartbeat.unref();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Date.parse(claim.record.processing!.deadlineAt) - Date.now()));
    let failure = 'ISOLATED_TEST_RESULT_LOST';
    try {
      this.bindings.bindSession(claim.session);
      const result = await this.invocation.invoke(this.runtimeInput(claim.session, claim.record), controller.signal);
      failure = result.error?.code ?? failure;
    } catch { failure = 'INTENT_TEST_RUNTIME_UNAVAILABLE'; }
    finally { clearInterval(heartbeat); clearTimeout(timeout); this.controllers.delete(reference.stepId); }
    if (!this.destroyed) await this.publish(reference, ownerId, failure);
  }
  private async publish(reference: Reference, ownerId: string, missingResult = 'ISOLATED_TEST_RESULT_LOST') {
    const outcome = await this.mutate(reference, (draft, record, session, route) => {
      if (!['running', 'reconciliation_required'].includes(record.status) || record.processing?.ownerId !== ownerId) return;
      if (!(Date.parse(record.processing.leaseExpiresAt) > Date.now())) return { wakeAt: Date.now() };
      const operation = rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id).find(row => row.id === `intent-test:${record.id}`);
      const attempt = operation?.isolatedTestAttempts?.find(row => row.invocationId === record.processing!.invocationId);
      if (operation?.activeInvocationId || operation?.stopState === 'unconfirmed' || operation?.stopState === 'requested' ||
        (attempt && (!['finished', 'reconciled'].includes(attempt.phase) || !attempt.stopConfirmed || attempt.cleanupRequired))) {
        record.status = 'reconciliation_required'; record.failureCode = 'ISOLATED_TEST_STOP_UNCONFIRMED';
        record.processing.leaseExpiresAt = new Date(0).toISOString(); return { wakeAt: Date.now() + 10000 };
      }
      try { assertCurrent(draft, record, session); }
      catch { return { event: finish(draft, record, route, 'invalidated', 'INTENT_EXECUTION_SUPERSEDED') }; }
      if (!attempt?.result) return { event: finish(draft, record, route, 'failed', missingResult) };
      if (!isDeepStrictEqual(attempt.authorityBinding, session.intentTestAuthority?.binding) ||
        !isDeepStrictEqual(operation?.executionBinding, record.step.executionBinding) || operation?.intentStepId !== record.id ||
        operation?.dataEpoch !== record.dataEpoch || operation?.workItemId !== record.step.target.workItemId) {
        return { event: finish(draft, record, route, 'invalidated', 'INTENT_TEST_RESULT_BINDING_MISMATCH') };
      }
      const writesReport = record.step.effectScope.effects.some(effect => effect.kind === 'write_artifact');
      const testFailed = attempt.result.error === 'ISOLATED_TEST_FAILED' && attempt.result.exitCode !== null && attempt.result.exitCode !== 0;
      if (attempt.phase !== 'finished' || Date.parse(attempt.updatedAt) > Date.parse(record.processing.deadlineAt) ||
        attempt.result.aborted || attempt.result.timedOut || attempt.result.exitCode === null || (attempt.result.error && !(writesReport && testFailed))) {
        return { event: finish(draft, record, route, 'failed', attempt.result.error ?? 'ISOLATED_TEST_FAILED') };
      }
      let artifactEvent: CollaborationEvent | undefined;
      if (writesReport) {
        if (!attempt.snapshotHash || !/^[a-f0-9]{64}$/.test(attempt.snapshotHash)) {
          return { event: finish(draft, record, route, 'failed', 'INTENT_TEST_REPORT_EVIDENCE_INCOMPLETE') };
        }
        const title = `隔离测试报告：${attempt.script}`, result = attempt.result;
        const artifact: Artifact = { id: `intent-test-report:${record.id}`, sessionId: session.id, dataEpoch: session.dataEpoch,
          workItemId: record.step.target.workItemId!, type: 'test_report', title, contentSummary: `隔离测试退出码 ${result.exitCode}；报告保存在会话产物中。`,
          runtimeProposals: [], platformProjections: [], systemEvidence: null, createdAt: new Date().toISOString(),
          metadata: { phase: 'task_execution', status: result.exitCode === 0 ? 'passed' : 'failed', intentTestReport: testReportMetadata(record, attempt) } };
        appendArtifactInDraft(draft, artifact); record.resultArtifactId = artifact.id;
        artifactEvent = { id: `intent-test-artifact:${record.id}`, sessionId: session.id, workItemId: artifact.workItemId,
          type: 'artifact_created', content: '已保存隔离测试报告。', toAgentIds: [], actor: { type: 'system', id: 'intent-test' }, createdAt: artifact.createdAt,
          metadata: { schemaVersion: '0.1', renderAs: 'artifact_card', payload: { artifactId: artifact.id, type: artifact.type,
            title: artifact.title, contentSummary: artifact.contentSummary, intentTestReport: artifact.metadata.intentTestReport,
            runtimeProposals: [], platformProjections: [], systemEvidence: null, routingId: route.id, intentRevision: record.intentRevision } } };
        appendEvent(draft, artifactEvent);
      }
      if (testFailed) return { artifactEvent, event: finish(draft, record, route, 'failed', 'ISOLATED_TEST_FAILED') };
      const event: CollaborationEvent = { id: `intent-test-result:${record.id}`, sessionId: session.id, workItemId: record.step.target.workItemId!,
        type: 'runtime_completed', toAgentIds: [], actor: { type: 'system', id: 'intent-test' }, createdAt: new Date().toISOString(),
        content: `隔离测试 ${attempt.script} 已完成，退出码 ${attempt.result.exitCode}。`,
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: route.id, stepId: record.id,
          intentRevision: record.intentRevision, invocationId: attempt.invocationId, script: attempt.script,
          exitCode: attempt.result.exitCode, snapshotHash: attempt.snapshotHash, bindingHash: attempt.authorityBinding?.bindingHash } } };
      appendEvent(draft, event); record.status = 'completed'; record.responseEventId = event.id; record.updatedAt = event.createdAt;
      route.actionStatus = 'applied'; route.updatedAt = event.createdAt; route.routingRevision = (route.routingRevision ?? 1) + 1;
      return { event, artifactEvent };
    });
    if (outcome?.event) this.events?.acceptCommitted(outcome.event);
    if (outcome && 'artifactEvent' in outcome && outcome.artifactEvent) this.events?.acceptCommitted(outcome.artifactEvent);
    if (outcome?.wakeAt) this.schedule(reference, outcome.wakeAt);
  }
  private mutate<T>(reference: Reference, fn: (draft: PersistedState, record: IntentPlanStepRecord, session: SessionDetail, route: IntentRoutingRecord) => T) {
    return this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === reference.sessionId);
      const record = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', reference.sessionId).find(row => row.id === reference.stepId);
      const route = record && rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', reference.sessionId).find(row => row.id === record.routingId);
      if (!session || !record || !route || record.dataEpoch !== session.dataEpoch || !isTestStep(record.step)) return;
      return fn(draft, record, session, route);
    }, { sessionIds: [reference.sessionId] });
  }
  private runtimeInput(session: SessionDetail, record: IntentPlanStepRecord) {
    const agent = this.agents.getByIdOrKey('test');
    if (!agent.capabilityIds.includes('cap-isolated-test')) throw new Error('INTENT_TEST_AGENT_UNAVAILABLE');
    return { sessionId: session.id, dataEpoch: session.dataEpoch, admissionClass: 'business' as const, intentStepId: record.id,
      workItemId: record.step.target.workItemId!, invocationId: record.processing!.invocationId!, operationId: `intent-test:${record.id}`,
      operationDeadlineAt: record.processing!.deadlineAt, phase: 'task_execution' as const, taskKind: 'intent_test', taskRequiresCodeChanges: false,
      agent: { ...agent, profileMarkdown: '${tool:tool.isolated_test}' }, intentTestBinding: session.intentTestAuthority!.binding,
      effectScope: record.step.effectScope, executionBinding: record.step.executionBinding,
      workspace: { workspaceId: session.workspaceId, providerKind: 'server_local' as const, capabilities: { read: false, write: false, command: false, test: true } },
      sessionPreference: session.runtimePreference, taskOverride: { runtimeType: 'test_runner' as const }, globalDefaultRuntime: 'test_runner' as const,
      expectedOutput: { kind: 'task_execution_result' as const, schemaVersion: '1.0' as const }, writeModeOverride: 'none' as const,
      budget: { maxInputTokens: 1, maxOutputTokens: 1, maxTotalTokens: 2 },
      contextEnvelopeFactory: ({ identity, toolCatalog }: { identity: { agentId: string; profileHash: string; profileRevision: number }; toolCatalog: { catalogHash: string } }): ContextEnvelopeV2 => ({
        version: 'v2', createdAt: new Date().toISOString(), sessionId: session.id, workspaceId: session.workspaceId,
        L0: { systemRules: ['Execute only the server-bound isolated test.'], agentId: identity.agentId, profileHash: identity.profileHash,
          profileRevision: identity.profileRevision, toolCatalogHash: toolCatalog.catalogHash, workspace: { workspaceId: session.workspaceId,
            rootName: session.workingDirectory?.name ?? session.workspaceId, providerKind: 'server_local',
            revision: { id: `intent:${record.intentRevision}`, observedAt: new Date().toISOString() } } },
        L1: { sessionGoal: record.step.goal, currentUserMessage: record.step.goal, phase: 'task_execution', navigation: { entries: [], truncated: false } },
        L2: { source: 'generated', modules: [] }, L3: { files: [], fileRevisions: [], totalByteLength: 0, truncated: false },
        L4: { calls: [] }, L5: { bullets: [], turnCount: 1 }, L6: { changeSetIds: [], reportIds: [] },
        budget: { inputTokens: 1, navigationTokens: 0, projectMapTokens: 0, evidenceTokens: 0 } }) };
  }
}
function assertCurrent(draft: PersistedState, record: IntentPlanStepRecord, session: SessionDetail) {
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
  if (session.archivedAt || ['PAUSED', 'CANCELLED', 'COMPLETED', 'INTERRUPTED'].includes(session.status) ||
    !lifecycle || lifecycle.admission !== 'open' || lifecycle.state !== 'active' || ['unknown', 'requested', 'stopping'].includes(lifecycle.stopStatus)) throw new Error('INTENT_TEST_ADMISSION_CLOSED');
  assertIntentExecutionCurrent(draft, { sessionId: session.id, dataEpoch: record.dataEpoch, admissionClass: 'business',
    workItemId: record.step.target.workItemId!, executionBinding: record.step.executionBinding, effectScope: record.step.effectScope });
}
function finish(draft: PersistedState, record: IntentPlanStepRecord, route: IntentRoutingRecord, status: IntentPlanStepRecord['status'], code: string) {
  record.status = status; record.failureCode = code; record.updatedAt = new Date().toISOString();
  if (route.effectiveIntentRevision === record.intentRevision && !route.dispatchHold) {
    route.actionStatus = 'failed'; route.updatedAt = record.updatedAt; route.routingRevision = (route.routingRevision ?? 1) + 1;
  }
  const event: CollaborationEvent = { id: `intent-test-failed:${record.id}`, sessionId: record.sessionId, type: 'intent_plan_blocked',
    content: record.resultArtifactId ? '隔离测试未通过，失败报告已保存。' : '本次隔离测试未发布有效结果，执行记录已保留供核对。', toAgentIds: [], actor: { type: 'system', id: 'intent-test' }, createdAt: record.updatedAt,
    metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: route.id, stepId: record.id, reasonCode: code } } };
  appendEvent(draft, event); return event;
}
