import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { isConfirmIntentBriefInput, type CollaborationEvent, type DecisionRecord, type IntentBriefConfirmationReceipt,
  type IntentPlanStepRecord, type IntentRouteRevision, type IntentRoutingRecord, type SessionDetail, type TaskBrief, type WorkItem } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { appendDecisionInDraft } from '../context-management/context-management.service.js';
import { approveFollowUpInDraft } from './intent-follow-up-state.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { correctionRows as rows, appendCorrectionEvent as appendEvent } from './intent-correction-state.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'briefsBySession', 'workItemsBySession', 'decisionRecordsBySession',
  'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'contextSnapshotsBySession', 'tasksBySession',
  'logicalOperationsBySession', 'followUpMessagesBySession', 'eventsBySession', 'eventOutbox'];

@Injectable()
export class IntentBriefConfirmationService {
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService) {}

  async confirm(sessionId: string, briefId: string, actorId: string, input: unknown) {
    if (!isConfirmIntentBriefInput(input)) throw new BadRequestException('INTENT_BRIEF_CONFIRM_INPUT_INVALID');
    const request = structuredClone(input);
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      if (!session || session.ownerId !== actorId || session.dataEpoch !== request.dataEpoch || session.archivedAt ||
        session.intentContractVersion !== 'intent-understanding-v1' || !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch) {
        throw new ConflictException('INTENT_BRIEF_CONFIRM_SESSION_STALE');
      }
      const briefs = rows<TaskBrief>(draft, 'briefsBySession', sessionId), brief = briefs.find(row => row.id === briefId);
      if (!brief?.intentBinding || brief.sessionId !== sessionId) throw new ConflictException('INTENT_BRIEF_CONFIRM_TARGET_STALE');
      const reused = briefs.find(row => row.intentConfirmationReceipt?.request.idempotencyKey === request.idempotencyKey);
      if (reused && reused.id !== briefId) throw new ConflictException('INTENT_BRIEF_CONFIRM_KEY_CONFLICT');
      const previous = brief.intentConfirmationReceipt;
      if (previous) {
        const { idempotencyKey: _oldKey, ...original } = previous.request;
        const { idempotencyKey: _newKey, ...incoming } = request;
        if (previous.actorId !== actorId || !isDeepStrictEqual(original, incoming)) throw new ConflictException('INTENT_BRIEF_CONFIRM_ALREADY_RESOLVED');
        return { accepted: true as const, sessionId, briefId, dataEpoch: session.dataEpoch, status: previous.resultStatus,
          receipt: structuredClone(previous), idempotentReplay: true, events: [] as CollaborationEvent[] };
      }
      const binding = brief.intentBinding;
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === binding.routingId);
      const step = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId).find(row => row.id === binding.stepId);
      const version = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', sessionId).find(row => row.routingId === binding.routingId && row.intentRevision === binding.intentRevision);
      const work = rows<WorkItem>(draft, 'workItemsBySession', sessionId).find(row => row.id === brief.workItemId);
      const card = rows<CollaborationEvent>(draft, 'eventsBySession', sessionId).find(row => row.type === 'user_confirmation_requested' && row.metadata.payload?.confirmationId === request.confirmationId);
      const payload = card?.metadata.payload as Record<string, unknown> | undefined;
      const resolved = rows<CollaborationEvent>(draft, 'eventsBySession', sessionId).some(row => row.type === 'user_confirmation_resolved' && row.metadata.payload?.confirmationId === request.confirmationId);
      if (request.expectedBriefVersion !== brief.version || request.expectedIntentRevision !== binding.intentRevision || brief.confirmedByUser ||
        session.currentTaskBriefId !== brief.id || session.pendingBriefRevisionRoutingId || !work || session.activeWorkItemId !== work.id || work.dispatchHold ||
        !route || route.dispatchHold || route.status !== 'ROUTED' || route.effectiveIntentRevision !== binding.intentRevision ||
        !step || step.dataEpoch !== session.dataEpoch || step.status !== 'completed' || step.resultBriefId !== brief.id || step.step.action !== 'prepare_brief' ||
        step.processing?.briefResult?.invocationId !== binding.invocationId ||
        !version || version.dataEpoch !== session.dataEpoch || version.authorizationState !== 'validated' || version.validatedPlan?.outcome !== 'applicable' ||
        !version.validatedPlan.steps.some(row => isDeepStrictEqual(row, step.step)) || !payload || payload.reason !== 'confirm_task_brief' || resolved ||
        payload.relatedBriefId !== brief.id || payload.stepId !== step.id || payload.routingId !== route.id || payload.intentRevision !== binding.intentRevision ||
        !Array.isArray(payload.options) || !payload.options.some(option => (option as { key?: string })?.key === 'approve')) {
        throw new ConflictException('INTENT_BRIEF_CONFIRM_TARGET_STALE');
      }
      const execution = step.step.executionBinding;
      if (execution.sessionGeneration !== lifecycle.generation || (work.requirementRevision ?? 1) !== execution.requirementRevision ||
        (work.executionEpoch ?? 1) !== execution.executionEpoch || decisionSetHash(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', sessionId), work)) !== execution.decisionSetHash) {
        throw new ConflictException('INTENT_BRIEF_CONFIRM_CONTEXT_STALE');
      }
      if (brief.openQuestions.length) throw new ConflictException('INTENT_BRIEF_OPEN_QUESTIONS');
      const paused = session.status === 'PAUSED' && session.pauseState?.previousStatus === 'WAIT_USER_CONFIRM';
      if ((!paused && session.status !== 'WAIT_USER_CONFIRM') || !['idle', 'confirmed'].includes(lifecycle.stopStatus)) throw new ConflictException('INTENT_BRIEF_CONFIRM_STATE_CONFLICT');
      const now = new Date().toISOString(), eventId = `intent-brief-resolved:${step.id}`;
      const source: CollaborationEvent = { id: eventId, sessionId, workItemId: work.id, type: 'user_confirmation_resolved',
        actor: { type: 'user', id: actorId }, toAgentIds: [], createdAt: now,
        content: paused ? '任务草稿已确认，会话仍保持暂停；执行权限单独校验。' : '任务草稿已确认，后续执行计划和权限仍需单独校验。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { confirmationId: request.confirmationId, relatedBriefId: brief.id,
          briefVersion: brief.version, routingId: route.id, intentRevision: binding.intentRevision, stepId: step.id,
          reason: 'confirm_task_brief', status: 'approved', selectedOptionKey: 'approve' } } };
      const decisions = [{ kind: 'requirement' as const, content: brief.goal },
        ...(brief.scope.length ? [{ kind: 'constraint' as const, content: `任务范围：${brief.scope.join('; ')}` }] : []),
        ...(brief.outOfScope.length ? [{ kind: 'constraint' as const, content: `不在任务范围内：${brief.outOfScope.join('; ')}` }] : []),
        ...brief.constraints.map(content => ({ kind: 'constraint' as const, content })),
        { kind: 'approval' as const, content: `确认任务草稿 ${brief.id} 第 ${brief.version} 版；不授予执行效果权限。` }];
      for (const decision of decisions) appendDecisionInDraft(draft, { session, workItemId: work.id, sourceEventId: eventId, ...decision });
      work.requirementRevision = (work.requirementRevision ?? 1) + 1; work.revision++; work.updatedAt = now;
      const status = paused ? 'PAUSED' as const : 'WAIT_WORKFLOW_SELECT' as const;
      if (paused) session.pauseState!.previousStatus = 'WAIT_WORKFLOW_SELECT'; else session.status = status;
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      const receipt: IntentBriefConfirmationReceipt = { id: `intent-brief-receipt:${step.id}`, actorId, request, sourceEventId: eventId,
        requirementRevision: work.requirementRevision, resultStatus: status, createdAt: now };
      brief.confirmedByUser = true; brief.confirmedAt = now; brief.intentConfirmationReceipt = receipt;
      const confirmed: CollaborationEvent = { id: `intent-brief-confirmed:${step.id}`, sessionId, workItemId: work.id, type: 'brief_confirmed',
        toAgentIds: [], actor: { type: 'user', id: actorId }, createdAt: now, content: '任务草稿确认已保存。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { briefId: brief.id, confirmationId: request.confirmationId,
          receiptId: receipt.id, routingId: route.id, intentRevision: binding.intentRevision, requirementRevision: work.requirementRevision } } };
      appendEvent(draft, source); appendEvent(draft, confirmed);
      // A follow-up Brief is the sole owner-confirmed gate for creating its one AgentTask.
      approveFollowUpInDraft(draft, session, brief);
      return { accepted: true as const, sessionId, briefId, dataEpoch: session.dataEpoch, status, receipt: structuredClone(receipt), idempotentReplay: false, events: [source, confirmed] };
    }, { sessionIds: [sessionId] });
    for (const event of result.events) this.events?.acceptCommitted(event);
    return { accepted: result.accepted, sessionId, briefId, dataEpoch: result.dataEpoch, status: result.status, receipt: result.receipt, idempotentReplay: result.idempotentReplay };
  }
}
