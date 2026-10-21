import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { isRetryIntentBriefInput, type CollaborationEvent, type IntentPlanStepRecord, type IntentRoutingRecord,
  type LogicalOperation, type SessionDetail, type SessionStopRequest } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { assertCurrentIntentBrief } from './intent-brief-store.service.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { INTENT_EXECUTION_COLLECTIONS } from './intent-execution-guard.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';
import { hasFailedBriefStep } from './intent-brief-reviews.js';

const collections = ['agents', 'sessions', 'sessionLifecyclesBySession', 'sessionStopRequestsBySession', 'logicalOperationsBySession',
  'briefsBySession', 'eventsBySession', 'eventOutbox', ...INTENT_EXECUTION_COLLECTIONS];

@Injectable()
export class IntentBriefRetryService {
  constructor(private readonly persistence: PersistenceService, private readonly executor: IntentBriefExecutorService,
    @Optional() private readonly events?: EventsService) {}

  async view(sessionId: string, stepId: string, actorId: string) {
    return this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const step = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId).find(row => row.id === stepId);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === step?.routingId);
      if (!session || session.ownerId !== actorId || session.archivedAt || !step || step.dataEpoch !== session.dataEpoch ||
        !['prepare_brief', 'review_brief'].includes(step.step.action) || !route) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      let canRetry = true;
      try { assertRetryTarget(draft, session, step); } catch { canRetry = false; }
      const reviewerId = step.step.action === 'review_brief' ? step.step.target.agentIds[0] : undefined;
      const reviewer = (draft.agents as import('@agent-cluster/shared').AgentDefinition[] | undefined)?.find(row => row.id === reviewerId);
      return { sessionId, stepId, dataEpoch: session.dataEpoch, routingId: route.id, routingRevision: route.routingRevision!,
        intentRevision: step.intentRevision, operationId: step.briefOperationId ?? `brief:${step.id}`, status: step.status,
        action: step.step.action, ...(reviewerId ? { reviewerId, reviewerName: reviewer?.name || reviewerId } : {}),
        failureCode: step.failureCode, canRetry };
    }, { sessionIds: [sessionId] });
  }

  async retry(sessionId: string, stepId: string, actorId: string, input: unknown) {
    if (!isRetryIntentBriefInput(input)) throw new BadRequestException('INTENT_BRIEF_RETRY_INPUT_INVALID');
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      const steps = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId), step = steps.find(row => row.id === stepId);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === step?.routingId);
      if (!session || session.ownerId !== actorId || session.archivedAt || session.dataEpoch !== input.dataEpoch ||
        session.intentContractVersion !== 'intent-understanding-v1' || !lifecycle || lifecycle.state !== 'active' ||
        !step || step.dataEpoch !== session.dataEpoch || !route || !['prepare_brief', 'review_brief'].includes(step.step.action)) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      const old = step.briefRetryReceipts?.find(receipt => receipt.request.idempotencyKey === input.idempotencyKey);
      if (old) {
        if (old.actorId !== actorId || !isDeepStrictEqual(old.request, input)) throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
        return { step: structuredClone(step), receipt: structuredClone(old), idempotentReplay: true };
      }
      if (steps.some(other => other.id !== stepId && other.briefRetryReceipts?.some(receipt => receipt.request.idempotencyKey === input.idempotencyKey))) {
        throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
      }
      const previousOperationId = step.briefOperationId ?? `brief:${step.id}`;
      if (route.routingRevision !== input.expectedRoutingRevision || step.intentRevision !== input.expectedIntentRevision ||
        previousOperationId !== input.expectedOperationId) throw new ConflictException('INTENT_PLAN_REVISION_CONFLICT');
      assertRetryTarget(draft, session, step);
      const now = new Date().toISOString();
      const receipt: NonNullable<IntentPlanStepRecord['briefRetryReceipts']>[number] = { id: randomUUID(), actorId,
        request: structuredClone(input), operationId: `brief:${stepId}:retry:${randomUUID()}`, previousOperationId,
        acceptedRoutingRevision: route.routingRevision! + 1, createdAt: now,
        previous: { ...(step.failureCode ? { failureCode: step.failureCode } : {}),
          ...(step.failureDetail ? { failureDetail: step.failureDetail } : {}),
          ...(step.processing ? { processing: structuredClone(step.processing) } : {}) } };
      (step.briefRetryReceipts ??= []).push(receipt); step.briefOperationId = receipt.operationId;
      step.status = 'queued'; step.updatedAt = now; delete step.processing; delete step.failureCode; delete step.failureDetail;
      route.actionStatus = hasFailedBriefStep(steps, route.id, step.intentRevision) ? 'failed' : 'pending';
      route.routingRevision = receipt.acceptedRoutingRevision; route.updatedAt = now;
      const event: CollaborationEvent = { id: `intent-brief-retry:${receipt.id}`, sessionId, workItemId: step.step.target.workItemId ?? undefined,
        type: 'intent_plan_committed', actor: { type: 'user', id: actorId }, toAgentIds: [], createdAt: now,
        content: step.step.action === 'review_brief' ? '已受理该 Agent 的重新审阅请求，已完成的其他意见和旧失败记录均保留。' : '已受理任务草稿的重新生成请求，旧失败记录已保留。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { code: 'INTENT_BRIEF_RETRY_REQUESTED',
          stepId, routingId: route.id, intentRevision: step.intentRevision, operationId: receipt.operationId, previousOperationId,
          retryReceiptId: receipt.id, replyToEventId: route.sourceEventId } } };
      appendCorrectionEvent(draft, event);
      return { step: structuredClone(step), receipt: structuredClone(receipt), idempotentReplay: false, event };
    }, { sessionIds: [sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    if (result.step.briefOperationId === result.receipt.operationId && ['queued', 'running'].includes(result.step.status)) this.executor.schedule({ sessionId, stepId });
    return { accepted: true as const, sessionId, stepId, dataEpoch: input.dataEpoch, ...result };
  }
}

function assertRetryTarget(draft: PersistedState, session: SessionDetail, step: IntentPlanStepRecord) {
  if (step.status !== 'failed' || step.resultBriefId || step.processing?.briefResult || step.processing?.result ||
    ['INTENT_EXECUTION_SUPERSEDED', 'INTENT_SOURCE_BINDING_MISMATCH'].includes(step.failureCode ?? '') || session.pendingBriefRevisionRoutingId) {
    throw new ConflictException('INTENT_BRIEF_RETRY_UNAVAILABLE');
  }
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
  const stop = rows<SessionStopRequest>(draft, 'sessionStopRequestsBySession', session.id).at(-1);
  if (!lifecycle || !['idle', 'confirmed'].includes(lifecycle.stopStatus) || (stop && stop.status !== 'confirmed') ||
    rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id).some(row => ['requested', 'unconfirmed'].includes(row.stopState) ||
      (row.activeInvocationId && (row.id === (step.briefOperationId ?? `brief:${step.id}`) || row.intentStepId === step.id)))) {
    throw new ConflictException('OPERATION_STOP_UNCONFIRMED');
  }
  const ownerId = randomUUID(), invocationId = randomUUID();
  // A detached prospective claim reuses all production target/version checks.
  // No claim, budget or admission change is persisted by this validation.
  const candidate = { ...step, status: 'running' as const, processing: { ownerId, invocationId, attemptsUsed: 0,
    leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), deadlineAt: new Date(Date.now() + 120000).toISOString() } };
  const validation = { ...draft, intentPlanStepsBySession: {
    ...(draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>),
    [session.id]: rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).map(row => row.id === step.id ? candidate : row) } };
  try { assertCurrentIntentBrief(validation, { sessionId: session.id, stepId: step.id, ownerId, invocationId }, step.step.action === 'review_brief'); }
  catch { throw new ConflictException('INTENT_BRIEF_RETRY_TARGET_STALE'); }
}
