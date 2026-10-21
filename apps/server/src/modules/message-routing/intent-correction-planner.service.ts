import { randomUUID } from 'node:crypto';
import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { AgentTask, CollaborationEvent, DecisionRecord, IntentContextSnapshot, IntentCorrection, IntentEffectGrant,
  IntentPlanStepRecord, IntentRouteRevision, IntentRoutingRecord, IntentUnderstandingOutput, LogicalOperation,
  SessionDetail, SessionFollowUpMessage, TaskBrief, WorkItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { ContextManagementService, appendDecisionInDraft, routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { SemanticIntentRouterService } from '../intent-recognition/semantic-intent-router.service.js';
import { EventsService } from '../events/events.service.js';
import { operationPolicy } from '../runtimes/logical-operation-store.js';
import { RuntimeRegistryService } from '../runtimes/runtime-registry.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { compileIntentRoutePlan } from './route-plan-compiler.service.js';
import { currentTestGrant, currentTestReportGrant, intentEffectAuthoritySnapshot } from './intent-test-authority.js';
import { IntentTestExecutorService, isTestStep } from './intent-test-executor.service.js';
import { reconcileCorrectionEffects } from './intent-correction-effects.js';
import { correctionCollections, correctionRows as rows, correctionEvent, appendCorrectionEvent } from './intent-correction-state.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { deriveCorrectedBriefStep } from './intent-brief-store.service.js';
import { applyBriefRevisionAnswers, assertBriefRevisionPlan } from './intent-brief-revision.js';

type Repair = { previousOutput: string; validationErrors: string[] };

/** Durable classification budget plus a commit-time compiler; no caller-provided plan is trusted. */
@Injectable()
export class IntentCorrectionPlannerService implements OnModuleDestroy {
  private readonly processing = new Map<string, Promise<void>>();
  private readonly wakeups = new Map<string, NodeJS.Timeout>();
  private readonly controllers = new Set<AbortController>();
  private destroyed = false;
  constructor(private readonly persistence: PersistenceService, private readonly context: ContextManagementService,
    private readonly semantic: SemanticIntentRouterService, @Optional() private readonly events?: EventsService,
    @Optional() private readonly tests?: IntentTestExecutorService, @Optional() private readonly runtimes?: RuntimeRegistryService,
    @Optional() private readonly briefs?: IntentBriefExecutorService) {}

  process(correction: IntentCorrection): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const running = this.processing.get(correction.id);
    if (running) return running;
    const operation = this.processOnce(correction).finally(() => this.processing.delete(correction.id));
    this.processing.set(correction.id, operation);
    return operation;
  }

  onModuleDestroy() {
    this.destroyed = true;
    for (const timer of this.wakeups.values()) clearTimeout(timer);
    this.wakeups.clear();
    for (const controller of this.controllers) controller.abort();
  }

  private wake(reference: IntentCorrection, at: number) {
    if (this.destroyed || this.wakeups.has(reference.id)) return;
    const timer = setTimeout(() => { this.wakeups.delete(reference.id); void this.process(reference).catch(() => undefined); },
      Math.max(1, at - Date.now() + 1));
    timer.unref(); this.wakeups.set(reference.id, timer);
  }

  private async processOnce(reference: IntentCorrection) {
    const ownerId = randomUUID();
    const claim = await this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference);
      if (!bound || bound.correction.status !== 'validating') return;
      const current = bound.correction;
      const now = Date.now();
      if (current.processing && Date.parse(current.processing.leaseExpiresAt) > now) return { wakeAt: Date.parse(current.processing.leaseExpiresAt) };
      const deadlineAt = current.processing?.deadlineAt ?? new Date(now + operationPolicy('user_message_routing').timeoutMs).toISOString();
      if ((current.processing?.attemptsUsed ?? 0) >= 2 || Date.parse(deadlineAt) <= now) {
        const active = rows<LogicalOperation>(draft, 'logicalOperationsBySession', reference.sessionId).some(item =>
          item.id === `${reference.routingId}:${reference.pendingIntentRevision}:classification` && item.activeInvocationId);
        current.failureClass = active ? 'unknown_effect' : 'budget';
        return { event: finish(draft, current, bound.route, active ? 'reconciliation_required' : 'rejected',
          [active ? 'OPERATION_STOP_UNCONFIRMED' : 'INTENT_BUDGET_EXHAUSTED']) };
      }
      current.processing = { ...current.processing, ownerId, deadlineAt,
        leaseExpiresAt: new Date(Math.min(now + 30_000, Date.parse(deadlineAt))).toISOString(),
        attemptsUsed: current.processing?.attemptsUsed ?? 0, repairsUsed: current.processing?.repairsUsed ?? 0,
        snapshotRebuildsUsed: current.processing?.snapshotRebuildsUsed ?? 0, invocationIds: current.processing?.invocationIds ?? [] };
      return { correction: structuredClone(current) };
    }, { sessionIds: [reference.sessionId] });
    if (!claim) return;
    if ('event' in claim && claim.event) { this.events?.acceptCommitted(claim.event); return; }
    if ('wakeAt' in claim && claim.wakeAt !== undefined) {
      this.wake(reference, claim.wakeAt);
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const heartbeat = setInterval(() => {
      void this.renew(reference, ownerId).then(renewed => { if (!renewed) controller.abort(); }).catch(() => controller.abort());
    }, 10_000);
    heartbeat.unref();
    let repair: Repair | undefined;
    let snapshot: IntentContextSnapshot | undefined;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const fresh = await this.readCurrent(reference, ownerId);
        if (!fresh) return;
        repair = fresh.correction.processing?.repairFeedback;
        if (fresh.correction.processing!.attemptsUsed >= 2 || Date.parse(fresh.correction.processing!.deadlineAt) <= Date.now()) {
          await this.fail(reference, ownerId, 'INTENT_BUDGET_EXHAUSTED', 'budget'); return;
        }
        if (!snapshot) {
          snapshot = await this.context.buildIntentSnapshot({ session: fresh.session, sourceEventId: reference.sourceEventId,
            currentMessage: reference.request.instruction, latestEventSeq: this.events?.list(reference.sessionId).length ?? 0,
            explicitWorkItemIds: reference.affectedWorkItemIds, decisionWorkItemIds: reference.affectedWorkItemIds });
        }
        const invocationId = randomUUID();
        const reserved = await this.reserve(reference, ownerId, snapshot, invocationId, Boolean(repair));
        if (!reserved) { await this.fail(reference, ownerId, 'INTENT_BUDGET_EXHAUSTED', 'budget'); return; }
        const outcome = await this.semantic.understand({ session: fresh.session, snapshot,
          operationId: `${reference.routingId}:${reference.pendingIntentRevision}:classification`, invocationId,
          parentOperationId: reference.originRoutingId,
          operationDeadlineAt: fresh.correction.processing!.deadlineAt,
          correction: { ...reference.request, routingId: reference.routingId }, repairFeedback: repair, signal: controller.signal });
        if (outcome.status === 'invalid') {
          if (repair) { await this.fail(reference, ownerId, 'INTENT_OUTPUT_INVALID', 'schema', outcome.validationErrors); return; }
          await this.persistence.mutateCollections(correctionCollections, draft => {
            const bound = bind(draft, reference, ownerId);
            if (!bound?.correction.processing) return;
            bound.correction.processing.repairFeedback = { previousOutput: outcome.previousOutput.slice(0, 8000),
              validationErrors: outcome.validationErrors.slice(0, 20).map(error => error.slice(0, 500)) };
          }, { sessionIds: [reference.sessionId] });
          continue;
        }
        if (outcome.status === 'failed') {
          if (outcome.retryable && outcome.failureClass === 'transient') {
            const delay = Math.max(100, Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs : 0);
            if (Date.now() + delay >= Date.parse(fresh.correction.processing!.deadlineAt)) {
              await this.fail(reference, ownerId, 'INTENT_BUDGET_EXHAUSTED', 'budget'); return;
            }
            await new Promise<void>(resolve => setTimeout(resolve, delay));
            repair = undefined; continue;
          }
          await this.fail(reference, ownerId, outcome.code, outcome.failureClass); return;
        }
        const result = await this.activate(reference, ownerId, snapshot.id, outcome.understanding);
        if (result === 'stale') { snapshot = undefined; repair = undefined; continue; }
        return;
      }
    } catch (error) {
      if (!controller.signal.aborted) await this.fail(reference, ownerId, 'CORRECTION_PROCESSING_FAILED', 'config');
    } finally {
      clearInterval(heartbeat); this.controllers.delete(controller);
      const current = this.persistence.getCollection<Record<string, IntentCorrection[]>>('intentCorrectionsBySession', {})[reference.sessionId]?.find(item => item.id === reference.id);
      if (current?.status === 'validating' && current.processing?.ownerId === ownerId) this.wake(reference, Date.parse(current.processing.leaseExpiresAt));
    }
  }

  private readCurrent(reference: IntentCorrection, ownerId: string) {
    return this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference, ownerId);
      return bound ? { session: structuredClone(bound.session), correction: structuredClone(bound.correction) } : undefined;
    }, { sessionIds: [reference.sessionId] });
  }

  private renew(reference: IntentCorrection, ownerId: string) {
    return this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference, ownerId);
      if (!bound || Date.parse(bound.correction.processing!.deadlineAt) <= Date.now()) return false;
      bound.correction.processing!.leaseExpiresAt = new Date(Math.min(Date.now() + 30_000, Date.parse(bound.correction.processing!.deadlineAt))).toISOString();
      return true;
    }, { sessionIds: [reference.sessionId] });
  }

  private reserve(reference: IntentCorrection, ownerId: string, snapshot: IntentContextSnapshot, invocationId: string, repair: boolean) {
    return this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference, ownerId);
      if (!bound) return false;
      const processing = bound.correction.processing!;
      if (processing.attemptsUsed >= 2 || Date.parse(processing.deadlineAt) <= Date.now() || (repair && processing.repairsUsed >= 1)) return false;
      if (processing.snapshotId && processing.snapshotId !== snapshot.id) {
        if (processing.snapshotRebuildsUsed >= 1) return false;
        processing.snapshotRebuildsUsed += 1;
      }
      processing.snapshotId = snapshot.id; processing.attemptsUsed += 1;
      processing.repairsUsed += repair ? 1 : 0; processing.invocationIds.push(invocationId);
      return true;
    }, { sessionIds: [reference.sessionId] });
  }

  private async fail(reference: IntentCorrection, ownerId: string, code: string,
    failureClass: NonNullable<IntentCorrection['failureClass']>, validationErrors: string[] = []) {
    const event = await this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference, ownerId);
      if (!bound) return;
      bound.correction.failureClass = failureClass;
      bound.correction.validationErrors = validationErrors.slice(0, 20);
      return finish(draft, bound.correction, bound.route,
        failureClass === 'unknown_effect' ? 'reconciliation_required' : 'rejected', [code]);
    }, { sessionIds: [reference.sessionId] });
    if (event) this.events?.acceptCommitted(event);
  }

  private async activate(reference: IntentCorrection, ownerId: string, snapshotId: string, understanding: IntentUnderstandingOutput) {
    const result = await this.persistence.mutateCollections(correctionCollections, draft => {
      const bound = bind(draft, reference, ownerId);
      if (!bound) return { outcome: 'obsolete' as const };
      const { session, correction, route } = bound;
      const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(item => item.id === snapshotId);
      if (!snapshot || snapshot.sourceEventId !== correction.sourceEventId || snapshot.currentMessage !== correction.request.instruction) throw new Error('CORRECTION_SNAPSHOT_MISMATCH');
      const works = rows<WorkItem>(draft, 'workItemsBySession', session.id);
      const fingerprint = routingBusinessFingerprint(session, works,
        rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id));
      if (snapshot.businessFingerprint !== fingerprint) return { outcome: 'stale' as const };
      const targetId = correction.request.targetWorkItemId ?? (correction.affectedWorkItemIds.length === 1 ? correction.affectedWorkItemIds[0] : undefined);
      const target = works.find(item => item.id === targetId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
      const revisions = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id);
      const previous = revisions.find(item => item.routingId === route.id && item.intentRevision === correction.previousIntentRevision);
      const authority = intentEffectAuthoritySnapshot(session);
      const reconciliation = reconcileCorrectionEffects(draft, correction);
      if (reconciliation.state !== 'ready') {
        delete correction.effectReconciliation;
        return { outcome: 'finished' as const,
          event: finish(draft, correction, route, 'reconciliation_required', ['CORRECTION_EFFECT_RECONCILIATION_REQUIRED']) };
      }
      const grants: IntentEffectGrant[] = [...(previous?.authorizationState === 'validated' ? previous.authorityGrants ?? [] : [])
        .filter(grant => !['read_workspace', 'run_tests', 'write_artifact'].includes(grant.effect)), ...authority.grants];
      const availableTests = Boolean(this.tests && this.runtimes?.listAll().some(runtime => runtime.type === 'test_runner') &&
        (!session.runtimePreference?.allowedRuntimeTypes || session.runtimePreference.allowedRuntimeTypes.includes('test_runner')));
      const allowedEffects: Array<'answer' | 'run_tests' | 'write_artifact'> = ['answer', ...(currentTestGrant(session) ? ['run_tests' as const] : []), ...(currentTestReportGrant(session) ? ['write_artifact' as const] : [])];
      const operations = rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id);
      const stopConfirmed = !operations.some(row => ['requested', 'unconfirmed'].includes(row.stopState)) &&
        !['unknown', 'requested', 'stopping'].includes(lifecycle?.stopStatus ?? '');
      const plan = compileIntentRoutePlan({ session, routing: { ...route, sourceEventId: correction.sourceEventId }, snapshot, understanding,
        snapshotCurrent: true, intentRevision: correction.pendingIntentRevision,
        requirementRevision: (target?.requirementRevision ?? 1) + 1, executionEpoch: target?.executionEpoch ?? route.executionEpoch ?? 1,
        sessionGeneration: lifecycle?.generation ?? 1, validArtifactIds: target?.inheritedArtifactIds ?? [], correctionRoutingIds: [route.id],
        stopConfirmed,
        scopePolicy: { grants, resources: authority.resources,
          phaseAllowed: [...allowedEffects], toolAllowed: [...allowedEffects], workspaceAllowed: [...allowedEffects],
          runtimeAllowed: allowedEffects.filter(effect => !['run_tests', 'write_artifact'].includes(effect) || availableTests),
          enforceableProhibitions: understanding.segments.flatMap(segment => segment.prohibitions.filter(item =>
            item.scope === 'message' && item.effectKind !== 'answer' && item.object.kind === 'workspace' && item.object.refId === session.workspaceId)) } });
      if (plan.outcome !== 'applicable') {
        return { outcome: 'finished' as const, event: finish(draft, correction, route,
          plan.outcome === 'needs_clarification' ? 'clarification_required' : 'rejected', plan.validation.errorCodes) };
      }
      const step = plan.steps[0];
      const testExecution = step.action === 'correct_route' && isTestStep(step);
      const segment = understanding.segments[0];
      const errors: string[] = [];
      if (!target || step.target.workItemId !== target.id) errors.push('CORRECTION_TARGET_MISMATCH');
      if (step.target.correctionOfRoutingId !== route.id) errors.push('CORRECTION_ROUTE_MISMATCH');
      if (step.correction?.supersedesDecisionId !== (correction.request.supersedesDecisionId ?? undefined) ||
        step.correction?.expectedDecisionRevision !== (correction.request.expectedDecisionRevision ?? undefined)) errors.push('CORRECTION_DECISION_NOT_AUTHORIZED');
      if (!step.evidence.length) errors.push('CORRECTION_SOURCE_EVIDENCE_REQUIRED');
      if (step.correction && !step.evidence.some(evidence => evidence.quote.includes(step.correction!.replacementText))) errors.push('CORRECTION_REPLACEMENT_EVIDENCE_REQUIRED');
      // Only a versioned correction may enqueue a replacement execution, after the old effects reconcile.
      if (!['correct_route', 'record_constraint', 'record_information'].includes(step.action) || (step.effectScope.effects.length && !testExecution)) errors.push('CORRECTION_ACTION_EXECUTOR_UNAVAILABLE');
      if (testExecution && (!availableTests || step.target.agentIds.length || session.workingDirectory?.kind !== 'server_local' ||
        ['PAUSED', 'COMPLETED', 'CANCELLED', 'INTERRUPTED'].includes(session.status) || lifecycle?.admission !== 'open' || !stopConfirmed)) {
        errors.push('CORRECTION_TEST_ADMISSION_CLOSED');
      }
      if (testExecution && (operations.some(row => row.admissionClass !== 'routing' && row.activeInvocationId &&
        (!row.workItemId || row.workItemId === targetId)) || rows<AgentTask>(draft, 'tasksBySession', session.id).some(row =>
          row.workItemId === targetId && ['running', 'claimed'].includes(row.status)))) errors.push('CORRECTION_TARGET_REQUIRES_STOP');
      if (errors.length) return { outcome: 'finished' as const, event: finish(draft, correction, route,
        errors.includes('CORRECTION_ACTION_EXECUTOR_UNAVAILABLE') ? 'rejected' : 'clarification_required', errors) };
      const content = step.correction?.replacementText ?? snapshot.currentMessage;
      const origin = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(item => item.id === correction.originRoutingId);
      if (origin?.briefRevision) {
        assertBriefRevisionPlan(draft, session, origin, plan);
        if (!this.briefs) throw new Error('INTENT_BRIEF_EXECUTOR_UNAVAILABLE');
      }
      appendDecisionInDraft(draft, { session, workItemId: target!.id, sourceEventId: correction.sourceEventId,
        kind: step.correction ? 'correction' : segment.dialogueAct === 'constraint' || step.action === 'record_constraint' ? 'constraint' : 'requirement',
        content, supersedesDecisionId: correction.request.supersedesDecisionId ?? undefined,
        expectedDecisionRevision: correction.request.expectedDecisionRevision ?? undefined });
      if (origin?.briefRevision) {
        applyBriefRevisionAnswers(draft, session, origin.briefRevision, correction.sourceEventId);
        delete session.pendingBriefRevisionRoutingId;
      }
      target!.requirementRevision = (target!.requirementRevision ?? 1) + 1;
      const decisions = effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), target!);
      step.executionBinding.decisionSetHash = decisionSetHash(decisions);
      const now = new Date().toISOString();
      correction.effectReconciliation = { policyVersion: 'isolated-test-reconciliation-v2', confirmedAt: now, executions: reconciliation.receipts };
      const supersedesArtifactIds = [...new Set(reconciliation.receipts.flatMap(receipt => receipt.artifactId ? [receipt.artifactId] : []))];
      // Only a new version can release the correction's own holds; other holds remain untouched.
      for (const work of works.filter(item => item.dispatchHold?.correctionId === correction.id)) {
        delete work.dispatchHold; work.revision += 1; work.updatedAt = now;
      }
      delete route.dispatchHold;
      route.currentIntentRevision = correction.pendingIntentRevision;
      route.effectiveIntentRevision = correction.pendingIntentRevision;
      route.status = 'ROUTED'; route.actionStatus = testExecution ? 'pending' : 'applied';
      delete route.decision; delete route.validation; delete route.finalAction;
      const event = finish(draft, correction, route, 'applied', []);
      plan.routingRevision = route.routingRevision!;
      const oldBrief = ((draft.briefsBySession as Record<string, TaskBrief[]> | undefined)?.[session.id] ?? []).find(brief =>
        brief.id === session.currentTaskBriefId && brief.workItemId === target!.id && brief.intentBinding);
      const waiting = ['WAIT_USER_CONFIRM', 'WAIT_WORKFLOW_SELECT', 'REVISING_BRIEF'].includes(session.status) ||
        (session.status === 'PAUSED' && ['WAIT_USER_CONFIRM', 'WAIT_WORKFLOW_SELECT', 'REVISING_BRIEF'].includes(session.pauseState?.previousStatus ?? ''));
      const briefStep = this.briefs && !testExecution && oldBrief && waiting && session.intentContractVersion === 'intent-understanding-v1'
        ? deriveCorrectedBriefStep(plan, oldBrief, target!) : undefined;
      const additionalEvents: CollaborationEvent[] = [];
      if (briefStep) {
        plan.steps.push(briefStep); route.actionStatus = 'pending';
        if (session.status === 'PAUSED') session.pauseState!.previousStatus = 'REVISING_BRIEF'; else session.status = 'REVISING_BRIEF';
        session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
        // Resolve the old card as superseded, never as approval. Its historical Brief remains immutable.
        const card = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(item => item.type === 'user_confirmation_requested' &&
          item.metadata.payload?.relatedBriefId === oldBrief!.id);
        const confirmationId = card?.metadata.payload?.confirmationId;
        if (confirmationId && !rows<CollaborationEvent>(draft, 'eventsBySession', session.id).some(item =>
          item.type === 'user_confirmation_resolved' && item.metadata.payload?.confirmationId === confirmationId)) {
          const superseded: CollaborationEvent = { id: `intent-brief-superseded:${oldBrief!.id}`, sessionId: session.id, workItemId: target!.id,
            type: 'user_confirmation_resolved', toAgentIds: [], createdAt: now, content: '原草稿的要求已更新，正在准备新版本。',
            metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { confirmationId, relatedBriefId: oldBrief!.id,
              status: 'rejected', selectedOptionKey: 'revise', correctionId: correction.id } } };
          appendCorrectionEvent(draft, superseded); additionalEvents.push(superseded);
        }
      }
      route.semanticPlan = structuredClone(plan);
      revisions.push({ id: `intent-revision:${route.id}:${correction.pendingIntentRevision}`, sessionId: session.id, dataEpoch: session.dataEpoch,
        routingId: route.id, intentRevision: correction.pendingIntentRevision, previousRevision: correction.previousIntentRevision,
        sourceEventId: correction.sourceEventId, authorizationState: 'validated', authorityGrants: structuredClone(grants),
        understanding: structuredClone(understanding), validatedPlan: plan, policyVersion: plan.policyVersion, createdAt: now });
      rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).push({ id: step.stepId, sessionId: session.id,
        dataEpoch: session.dataEpoch, routingId: route.id, intentRevision: correction.pendingIntentRevision, localKey: step.segmentKey,
        step: structuredClone(step), status: testExecution ? 'queued' : 'completed', reusedEffectIds: [],
        ...(testExecution && step.effectScope.effects.some(effect => effect.kind === 'write_artifact') && supersedesArtifactIds.length ? { supersedesArtifactIds } : {}),
        createdAt: now, updatedAt: now });
      if (briefStep) rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).push({ id: briefStep.stepId,
        sessionId: session.id, dataEpoch: session.dataEpoch, routingId: route.id, intentRevision: correction.pendingIntentRevision,
        localKey: briefStep.segmentKey, step: structuredClone(briefStep), status: 'queued', reusedEffectIds: [], createdAt: now, updatedAt: now });
      // The superseded original message cannot be consumed by the legacy Coordinator after activation.
      for (const follow of rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', session.id).filter(item => item.routingId === route.id)) {
        if (follow.status !== 'completed') follow.status = 'cancelled';
      }
      session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(item => item.routingId !== route.id);
      return { outcome: 'finished' as const, event, dispatch: testExecution ? { sessionId: session.id, stepId: step.stepId } : undefined,
        briefDispatch: briefStep ? { sessionId: session.id, stepId: briefStep.stepId } : undefined, additionalEvents };
    }, { sessionIds: [reference.sessionId] });
    if ('dispatch' in result && result.dispatch) this.tests?.schedule(result.dispatch);
    if ('briefDispatch' in result && result.briefDispatch) this.briefs?.schedule(result.briefDispatch);
    if ('additionalEvents' in result) for (const event of result.additionalEvents ?? []) this.events?.acceptCommitted(event);
    if ('event' in result && result.event) this.events?.acceptCommitted(result.event);
    return result.outcome;
  }
}

function bind(draft: PersistedState, reference: IntentCorrection, ownerId?: string) {
  const session = (draft.sessions as SessionDetail[] | undefined)?.find(item => item.id === reference.sessionId);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[reference.sessionId];
  if (!session || session.archivedAt || session.dataEpoch !== reference.dataEpoch ||
    (lifecycle && (lifecycle.state !== 'active' || (reference.sessionGeneration !== undefined && lifecycle.generation !== reference.sessionGeneration)))) return;
  const correction = rows<IntentCorrection>(draft, 'intentCorrectionsBySession', session.id).find(item => item.id === reference.id);
  const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(item => item.id === reference.routingId);
  if (!correction || !route || correction.supersededByCorrectionId || route.dispatchHold?.correctionId !== correction.id ||
    route.currentIntentRevision !== correction.previousIntentRevision) return;
  if (ownerId && (correction.status !== 'validating' || correction.processing?.ownerId !== ownerId || Date.parse(correction.processing.leaseExpiresAt) <= Date.now())) return;
  return { session, correction, route };
}

function finish(draft: PersistedState, correction: IntentCorrection, route: IntentRoutingRecord, status: IntentCorrection['status'], reasons: string[]) {
  correction.status = status; correction.reasonCodes = [...new Set(reasons)]; correction.updatedAt = new Date().toISOString();
  route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = correction.updatedAt;
  correction.routingRevision = route.routingRevision;
  if (correction.processing) correction.processing.leaseExpiresAt = correction.updatedAt;
  const event = correctionEvent(correction, status === 'applied' ? 'intent_correction_applied' :
    status === 'reconciliation_required' ? 'intent_correction_reconciliation_required' : 'runtime_progress',
  `intent-correction:${correction.id}:${status}:${route.routingRevision}`, status === 'applied' ?
    `纠错已生效，后续执行将使用更新后的要求。${correction.effectReconciliation?.executions.some(row => row.artifactId) ? '旧报告已保留，历史执行结果未被撤销。' : ''}` :
    status === 'clarification_required' ? '纠错需要补充目标或要求，旧执行仍保持暂停。' : '纠错暂未生效，旧执行仍保持暂停。');
  appendCorrectionEvent(draft, event);
  return event;
}

