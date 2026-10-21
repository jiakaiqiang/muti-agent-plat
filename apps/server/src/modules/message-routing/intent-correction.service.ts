import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { CollaborationEvent, CorrectIntentRoutingInput, DecisionRecord, IntentCorrection, IntentPlanStepRecord,
  IntentResolutionReceipt, IntentRouteRevision, IntentRoutingRecord, LogicalOperation, SessionDetail,
  SessionFollowUpMessage, WorkItem, AgentTask, WorkspaceWritebackRecord } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { correctionCollections, correctionRows as rows, correctionEvent, appendCorrectionEvent } from './intent-correction-state.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import { resolveMessageCorrection } from './message-correction-target.js';
import { reconcileCorrectionEffects } from './intent-correction-effects.js';
import type { ArtifactState } from '../artifacts/artifact-store.js';

export function parseIntentCorrection(value: unknown): CorrectIntentRoutingInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_INTENT_CORRECTION');
  const input = value as Record<string, unknown>;
  const fields = ['contractVersion', 'expectedRoutingRevision', 'idempotencyKey', 'instruction', 'targetWorkItemId',
    'supersedesDecisionId', 'expectedDecisionRevision'];
  const id = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  if (Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key)) ||
    input.contractVersion !== 'intent-correction-v1' || !revision(input.expectedRoutingRevision) ||
    !id(input.idempotencyKey) || typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 8_000 ||
    (input.targetWorkItemId !== null && !id(input.targetWorkItemId)) ||
    (input.supersedesDecisionId !== null && !id(input.supersedesDecisionId)) ||
    (input.expectedDecisionRevision !== null && !revision(input.expectedDecisionRevision)) ||
    (input.supersedesDecisionId === null) !== (input.expectedDecisionRevision === null)) throw new BadRequestException('INVALID_INTENT_CORRECTION');
  return Object.fromEntries(fields.map(key => [key, input[key]])) as CorrectIntentRoutingInput;
}

@Injectable()
export class IntentCorrectionService implements OnModuleInit, OnModuleDestroy {
  private readonly processing = new Map<string, Promise<void>>();
  private readonly wakeups = new Map<string, NodeJS.Timeout>();
  private destroyed = false;
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService,
    @Optional() private readonly runtime?: RuntimeService, @Optional() private readonly planner?: IntentCorrectionPlannerService) {}

  onModuleInit() {
    const all = this.persistence.getCollection<Record<string, IntentCorrection[]>>('intentCorrectionsBySession', {});
    for (const correction of Object.values(all).flat()) {
      if (['accepted', 'waiting_for_stop', 'validating'].includes(correction.status) || this.canReconcile(correction)) this.schedule(correction);
    }
  }

  schedule(correction: IntentCorrection) {
    if (this.destroyed || this.processing.has(correction.id)) return;
    const run = (correction.status === 'validating' ? this.planner?.process(correction) ?? Promise.resolve() : this.reconcileStop(correction)).catch(() => {
      // The accepted receipt and hold stay durable. Recovery retries the same id.
    }).finally(() => this.processing.delete(correction.id));
    this.processing.set(correction.id, run);
  }

  onModuleDestroy() {
    this.destroyed = true;
    for (const timer of this.wakeups.values()) clearTimeout(timer);
    this.wakeups.clear();
  }

  private canReconcile(correction: IntentCorrection) {
    return correction.status === 'reconciliation_required' &&
      correction.reasonCodes.some(code => ['CORRECTION_EFFECT_RECONCILIATION_REQUIRED', 'CORRECTION_STOP_UNCONFIRMED'].includes(code));
  }

  private wake(correction: IntentCorrection) {
    // Automatic stop recovery has a fixed window. It never resets semantic attempts or deadlines.
    if (this.destroyed || this.wakeups.has(correction.id) || Date.now() + 10_000 > Date.parse(correction.createdAt) + 120_000) return;
    const timer = setTimeout(() => {
      this.wakeups.delete(correction.id);
      this.schedule(correction);
    }, 10_000);
    timer.unref(); this.wakeups.set(correction.id, timer);
  }

  async reconcileStop(correction: IntentCorrection) {
    const current = await this.transition(correction, 'waiting_for_stop', []);
    if (!current) return;
    correction = current;
    let stopped = correction.affectedExecutionIds.length === 0;
    if (!stopped && this.runtime) {
      const result = await this.runtime.cancelIntentExecutionsAndWait(correction.sessionId, correction.affectedExecutionIds);
      stopped = result.stopConfirmed;
    }
    // Re-read journal evidence in the transaction; a runtime stop response alone proves no effects.
    const ready = await this.transition(correction, 'validating',
      [stopped ? 'CORRECTION_PLAN_VALIDATION_PENDING' : 'CORRECTION_STOP_UNCONFIRMED']);
    if (ready?.status === 'validating' && !this.destroyed) await this.planner?.process(ready);
  }

  private async transition(correction: IntentCorrection, status: IntentCorrection['status'], reasons: string[]) {
    const result = await this.persistence.mutateCollections(correctionCollections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(item => item.id === correction.sessionId);
      if (!session || session.dataEpoch !== correction.dataEpoch || session.archivedAt) return;
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
      if (lifecycle && (lifecycle.state !== 'active' || (correction.sessionGeneration !== undefined && lifecycle.generation !== correction.sessionGeneration))) return;
      const current = rows<IntentCorrection>(draft, 'intentCorrectionsBySession', session.id).find(item => item.id === correction.id);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(item => item.id === correction.routingId);
      if (!current || !route || route.dispatchHold?.correctionId !== current.id ||
        (!['accepted', 'waiting_for_stop'].includes(current.status) && !this.canReconcile(current))) return;
      // Recovery keeps the waiting state stable instead of incrementing route revisions on every poll.
      if (status === 'waiting_for_stop' && this.canReconcile(current)) return { correction: structuredClone(current) };
      let pending = false;
      if (status === 'validating') {
        const proof = reconcileCorrectionEffects(draft, current);
        if (proof.state !== 'ready') {
          status = 'reconciliation_required'; pending = proof.state === 'pending';
          reasons = [reasons.includes('CORRECTION_STOP_UNCONFIRMED') ? 'CORRECTION_STOP_UNCONFIRMED' : 'CORRECTION_EFFECT_RECONCILIATION_REQUIRED'];
          delete current.effectReconciliation;
        } else {
          current.effectReconciliation = { policyVersion: 'isolated-test-reconciliation-v2', confirmedAt: new Date().toISOString(), executions: proof.receipts };
          reasons = ['CORRECTION_PLAN_VALIDATION_PENDING'];
        }
      }
      if (current.status === status && JSON.stringify(current.reasonCodes) === JSON.stringify(reasons)) return { correction: structuredClone(current), pending };
      current.status = status; current.reasonCodes = reasons; current.updatedAt = new Date().toISOString();
      route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = current.updatedAt;
      current.routingRevision = route.routingRevision;
      const event = correctionEvent(current, status === 'reconciliation_required' ? 'intent_correction_reconciliation_required' : 'runtime_progress',
        `intent-correction:${current.id}:${status}`, status === 'waiting_for_stop' ? '正在停止受影响的旧执行。' :
          status === 'reconciliation_required' ? '纠错等待停止或效果核对，旧执行仍被阻止。' : '纠错已保留，等待新计划校验，旧执行仍被阻止。');
      appendCorrectionEvent(draft, event);
      return { correction: structuredClone(current), event, pending };
    }, { sessionIds: [correction.sessionId] });
    if (result?.event) this.events?.acceptCommitted(result.event);
    if (result && 'pending' in result && result.pending) this.wake(result.correction);
    return result?.correction;
  }

  list(sessionId: string, routingId: string) {
    return this.persistence.getCollection<Record<string, IntentCorrection[]>>('intentCorrectionsBySession', {})[sessionId]
      ?.filter(item => item.routingId === routingId) ?? [];
  }

  history(sessionId: string, routingId: string) {
    return this.persistence.getCollection<Record<string, IntentRouteRevision[]>>('intentRouteRevisionsBySession', {})[sessionId]
      ?.filter(item => item.routingId === routingId) ?? [];
  }

  async accept(sessionId: string, routingId: string, actorId: string, raw: unknown) {
    return this.commit(sessionId, actorId, { routingId, request: parseIntentCorrection(raw) });
  }

  async acceptMessage(sessionId: string, actorId: string, routingId: string, expectedLeaseOwner?: string) {
    return this.commit(sessionId, actorId, { message: { routingId, expectedLeaseOwner } });
  }

  async clarifyMessage(sessionId: string, routingId: string, expectedRevision: number, reason: string) {
    const result = await this.persistence.mutateCollections(correctionCollections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === routingId);
      if (!session || session.archivedAt || (lifecycle && lifecycle.state !== 'active') || !route ||
        route.dispatchHold || route.correctionId || (route.routingRevision ?? 1) !== expectedRevision ||
        !['VALIDATING', 'CLARIFICATION_REQUIRED'].includes(route.status)) throw new ConflictException('CORRECTION_SOURCE_CHANGED');
      const now = new Date().toISOString();
      route.status = 'CLARIFICATION_REQUIRED'; route.routingRevision = expectedRevision + 1; route.updatedAt = now;
      route.reasonCodes = ['CORRECTION_TARGET_REQUIRED', reason];
      delete route.leaseOwner; delete route.leaseExpiresAt; delete route.finalAction;
      const follow = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', sessionId).find(row => row.routingId === route.id);
      if (follow) {
        follow.status = 'cancelled'; follow.receiverRecognitionPending = false;
        session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(row => row.id !== follow.id);
      }
      const event: CollaborationEvent = { id: `intent-correction-target:${route.id}:${route.routingRevision}`, sessionId,
        type: 'agent_message', actor: { type: 'system', id: 'intent-correction' }, toAgentIds: [], createdAt: now,
        content: '尚未能唯一定位要纠正的原消息或旧约束，未修改任务。请回复需要纠正的原消息并说明旧约束，或在原消息上点击“纠正理解”选择目标。',
        metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { routingId, routingRevision: route.routingRevision,
          correctionStatus: 'clarification_required', reasonCodes: route.reasonCodes } } };
      appendCorrectionEvent(draft, event);
      return { event, followUpId: follow?.id };
    }, { sessionIds: [sessionId] });
    this.events?.acceptCommitted(result.event);
    return result;
  }

  private async commit(sessionId: string, actorId: string, input:
    { routingId: string; request: CorrectIntentRoutingInput } | { message: { routingId: string; expectedLeaseOwner?: string } }) {
    const result = await this.persistence.mutateCollections(correctionCollections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(item => item.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      if (!session || session.archivedAt || (lifecycle && lifecycle.state !== 'active')) throw new NotFoundException('CORRECTION_SESSION_UNAVAILABLE');
      if (session.ownerId !== actorId) throw new NotFoundException('CORRECTION_SESSION_UNAVAILABLE');
      const records = rows<IntentCorrection>(draft, 'intentCorrectionsBySession', sessionId);
      const previousMessage = 'message' in input && records.find(row => row.dataEpoch === session.dataEpoch &&
        row.actorId === actorId && row.originRoutingId === input.message.routingId);
      if (previousMessage) return { correction: structuredClone(previousMessage), idempotentReplay: true };
      const origin = 'message' in input ? resolveMessageCorrection(draft, session, input.message) : undefined;
      const { routingId, request: rawRequest } = origin ?? input as { routingId: string; request: CorrectIntentRoutingInput };
      const request = parseIntentCorrection(rawRequest);
      const payloadHash = createHash('sha256').update(JSON.stringify({ routingId, request })).digest('hex');
      const replay = records.find(item => item.dataEpoch === session.dataEpoch && item.actorId === actorId && item.idempotencyKey === request.idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
        return { correction: structuredClone(replay), idempotentReplay: true };
      }
      const routing = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(item => item.id === routingId);
      if (!routing) throw new NotFoundException('CORRECTION_ROUTING_NOT_FOUND');
      if (routing.correctionTargetRoutingId) throw new ConflictException('CORRECTION_USE_ORIGINAL_ROUTING');
      if ((routing.routingRevision ?? 1) !== request.expectedRoutingRevision) throw new ConflictException('ROUTING_REVISION_CONFLICT');
      const previousCorrection = routing.dispatchHold ? records.find(item => item.id === routing.dispatchHold!.correctionId) : undefined;
      const replaceable = previousCorrection && ['rejected', 'clarification_required'].includes(previousCorrection.status);
      if (routing.dispatchHold && !replaceable) throw new ConflictException('CORRECTION_ALREADY_PENDING');
      const works = rows<WorkItem>(draft, 'workItemsBySession', sessionId);
      const followUps = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', sessionId).filter(item => item.routingId === routingId);
      const boundIds = [...new Set(followUps.map(item => item.workItemId).filter((id): id is string => Boolean(id)))];
      if (routing.decision?.selectedWorkItemId) boundIds.push(routing.decision.selectedWorkItemId);
      if (routing.forcedWorkItemId) boundIds.push(routing.forcedWorkItemId);
      const effective = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', sessionId).find(item =>
        item.routingId === routingId && item.intentRevision === routing.effectiveIntentRevision);
      for (const step of effective?.validatedPlan?.steps ?? []) if (step.target.workItemId) boundIds.push(step.target.workItemId);
      const target = request.targetWorkItemId ? works.find(item => item.id === request.targetWorkItemId) : undefined;
      if (request.targetWorkItemId && !target) throw new NotFoundException('CORRECTION_WORK_ITEM_NOT_FOUND');
      const affected = [...new Set([...boundIds, ...(target ? [target.id] : []), ...(replaceable ? previousCorrection.affectedWorkItemIds : [])])];
      if (affected.some(id => !works.some(work => work.id === id))) throw new ConflictException('CORRECTION_TARGET_STALE');
      if (affected.some(id => { const hold = works.find(work => work.id === id)?.dispatchHold;
        return hold && (!replaceable || hold.correctionId !== previousCorrection.id); })) throw new ConflictException('CORRECTION_ALREADY_PENDING');
      if (request.supersedesDecisionId) {
        const decision = rows<DecisionRecord>(draft, 'decisionRecordsBySession', sessionId).find(item => item.id === request.supersedesDecisionId);
        if (!target || !decision || (decision.workItemId !== target.id && !target.inheritedDecisionIds.includes(decision.id))) throw new BadRequestException('DECISION_TARGET_OUTSIDE_WORK_ITEM');
        if (decision.status !== 'confirmed' || decision.revision !== request.expectedDecisionRevision) throw new ConflictException('DECISION_REVISION_CONFLICT');
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      if (replaceable) previousCorrection.supersededByCorrectionId = id;
      const sourceEventId = origin?.event.id ?? `intent-correction:${id}:input`;
      const revisions = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', sessionId);
      const previousRevision = routing.currentIntentRevision ?? 1;
      if (!revisions.some(item => item.routingId === routingId && item.intentRevision === previousRevision)) {
        if (routing.currentIntentRevision !== undefined) throw new ConflictException('CORRECTION_VERSION_MISSING');
        revisions.push({ id: `intent-revision:${routingId}:1`, sessionId, dataEpoch: session.dataEpoch, routingId,
          intentRevision: 1, previousRevision: null, sourceEventId: routing.sourceEventId, authorizationState: 'unknown',
          understanding: null, validatedPlan: null, legacyDecision: structuredClone(routing.decision), policyVersion: routing.policyVersion, createdAt: now });
      }
      // Only a genuine saved choice can become a historical receipt.
      if (routing.resolution) {
        const receipts = rows<IntentResolutionReceipt>(draft, 'intentResolutionReceiptsBySession', sessionId);
        if (!receipts.some(item => item.routingId === routingId && item.resolution.confirmationId === routing.resolution!.confirmationId)) {
          receipts.push({ id: `intent-resolution:${routingId}:${routing.resolution.confirmationId}`, sessionId, dataEpoch: session.dataEpoch,
            routingId, resolution: structuredClone(routing.resolution), createdAt: routing.resolution.resolvedAt });
        }
        routing.resolution.supersededAt = now;
      }
      const hold = { correctionId: id, reason: 'intent_correction' as const, createdAt: now };
      routing.currentIntentRevision = previousRevision;
      routing.effectiveIntentRevision ??= previousRevision;
      routing.routingRevision = (routing.routingRevision ?? 1) + 1;
      routing.executionEpoch = (routing.executionEpoch ?? 1) + 1;
      routing.dispatchHold = hold;
      routing.correctionId = id;
      routing.updatedAt = now;
      delete routing.leaseOwner; delete routing.leaseExpiresAt;
      for (const work of works.filter(item => affected.includes(item.id))) {
        work.dispatchHold = structuredClone(hold);
        work.requirementRevision ??= 1;
        work.executionEpoch = (work.executionEpoch ?? 1) + 1;
        work.revision += 1; work.updatedAt = now;
      }
      const tasks = rows<AgentTask>(draft, 'tasksBySession', sessionId);
      const operations = rows<LogicalOperation>(draft, 'logicalOperationsBySession', sessionId);
      const affectedExecutionIds = operations.filter(operation => {
        if (!operation.activeInvocationId || operation.admissionClass === 'routing') return false;
        const workId = operation.workItemId ?? tasks.find(task => task.id === operation.taskId)?.workItemId;
        return operation.executionBinding?.routingId === routingId || (workId ? affected.includes(workId) : affected.length > 0);
      }).map(operation => operation.activeInvocationId!);
      // Finished reports are durable effects too. Missing execution evidence must block, never silently disappear.
      const reports = Object.values((draft.artifacts as ArtifactState | undefined)?.artifactsById ?? {}).filter(artifact => artifact.sessionId === sessionId);
      for (const step of rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId).filter(step =>
        step.dataEpoch === session.dataEpoch && step.routingId === routingId && (step.resultArtifactId || reports.some(artifact =>
          artifact.id === `intent-test-report:${step.id}` || artifact.metadata.intentTestReport?.stepId === step.id)))) {
        const invocationId = step.processing?.invocationId ?? `missing-report-execution:${step.id}`;
        if (!affectedExecutionIds.includes(invocationId)) affectedExecutionIds.push(invocationId);
      }
      for (const writeback of (draft.workspaceWritebacks ?? []) as WorkspaceWritebackRecord[]) {
        if (writeback.sessionId !== sessionId || !['merging', 'applying'].includes(writeback.status)) continue;
        const workId = writeback.workItemId ?? tasks.find(task => task.id === writeback.taskId)?.workItemId;
        if (writeback.executionBinding?.routingId === routingId || (workId ? affected.includes(workId) : affected.length > 0)) {
          if (!affectedExecutionIds.includes(writeback.invocationId)) affectedExecutionIds.push(writeback.invocationId);
        }
      }
      for (const step of rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId)) {
        if (step.status === 'queued' && (step.routingId === routingId || affected.includes(step.step.target.workItemId ?? ''))) {
          step.status = 'invalidated'; step.updatedAt = now;
        }
      }
      const correction: IntentCorrection = { id, sessionId, dataEpoch: session.dataEpoch, routingId, actorId,
        ...(origin ? { originRoutingId: origin.source.id, ...(origin.follow ? { originFollowUpId: origin.follow.id } : {}) } : {}),
        ...(origin ? { processing: { ownerId: '', leaseExpiresAt: now,
          deadlineAt: origin.source.classificationDeadlineAt ?? now,
          attemptsUsed: origin.source.classificationAttempts ?? 2,
          repairsUsed: origin.source.attemptLog?.filter(row => row.reason === 'schema_repair').length ?? 0,
          snapshotRebuildsUsed: origin.source.snapshotRebuildCount ?? 0,
          invocationIds: origin.source.attemptLog?.map(row => row.invocationId) ?? [] } } : {}),
        sessionGeneration: lifecycle?.generation ?? 1,
        idempotencyKey: request.idempotencyKey, payloadHash, request, sourceEventId,
        previousIntentRevision: previousRevision, pendingIntentRevision: Math.max(previousRevision,
          ...records.filter(item => item.routingId === routingId).map(item => item.pendingIntentRevision)) + 1, routingRevision: routing.routingRevision,
        status: 'accepted', affectedWorkItemIds: affected, affectedExecutionIds, reasonCodes: [], createdAt: now, updatedAt: now };
      records.push(correction);
      let inputEvent: CollaborationEvent | undefined;
      if (origin) {
        origin.source.status = 'ROUTED'; origin.source.correctionId = id;
        origin.source.correctionTargetRoutingId = routingId;
        origin.source.routingRevision = (origin.source.routingRevision ?? 1) + 1;
        origin.source.reasonCodes = ['CORRECTION_ACCEPTED']; origin.source.updatedAt = now;
        delete origin.source.leaseOwner; delete origin.source.leaseExpiresAt; delete origin.source.finalAction;
        if (origin.follow) {
          origin.follow.status = 'cancelled'; origin.follow.receiverRecognitionPending = false;
          session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(row => row.id !== origin.follow!.id);
        }
      } else {
        inputEvent = correctionEvent(correction, 'user_message', sourceEventId, request.instruction);
        inputEvent.actor = { type: 'user', id: actorId };
        appendCorrectionEvent(draft, inputEvent);
      }
      const event = correctionEvent(correction, 'intent_correction_requested', `intent-correction:${id}:accepted`, '已接收纠错，正在停止受影响的旧执行。');
      appendCorrectionEvent(draft, event);
      return { correction: structuredClone(correction), event, inputEvent, idempotentReplay: false };
    }, { sessionIds: [sessionId] });
    if (result.inputEvent) this.events?.acceptCommitted(result.inputEvent);
    if (result.event) this.events?.acceptCommitted(result.event);
    return result;
  }
}
