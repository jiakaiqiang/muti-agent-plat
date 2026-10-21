import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { canRetryIntentRecognition, type CollaborationEvent, type IntentRoutingRecord, type LogicalOperation,
  type RetryIntentRecognitionInput, type SessionDetail, type SessionStopRequest } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { IntentMessagePipelineService } from './intent-message-pipeline.service.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'sessionStopRequestsBySession', 'logicalOperationsBySession',
  'intentRoutingRecordsBySession', 'eventsBySession', 'eventOutbox'];

@Injectable()
export class IntentRecognitionRetryService {
  constructor(private readonly persistence: PersistenceService, private readonly pipeline: IntentMessagePipelineService,
    @Optional() private readonly events?: EventsService) {}

  async retry(sessionId: string, routingId: string, actorId: string, value: unknown) {
    assertInput(value); const request = value;
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      const routes = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId), route = routes.find(row => row.id === routingId);
      if (!session || session.ownerId !== actorId || session.archivedAt || session.status === 'CANCELLED' || session.dataEpoch !== request.dataEpoch ||
        !route || !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch ||
        route.semanticIngress?.dataEpoch !== session.dataEpoch || route.semanticIngress.sessionGeneration !== lifecycle.generation) {
        throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      }
      const previousReceipt = route.recognitionRetryReceipts?.find(row => row.request.idempotencyKey === request.idempotencyKey);
      if (previousReceipt) {
        if (previousReceipt.actorId !== actorId || !isDeepStrictEqual(previousReceipt.request, request)) throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
        return { routing: structuredClone(route), receipt: structuredClone(previousReceipt), idempotentReplay: true };
      }
      if (routes.some(other => other.id !== routingId && other.recognitionRetryReceipts?.some(row => row.request.idempotencyKey === request.idempotencyKey))) {
        throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
      }
      if (route.routingRevision !== request.expectedRoutingRevision) throw new ConflictException('INTENT_PLAN_REVISION_CONFLICT');
      if (!canRetryIntentRecognition(route)) throw new ConflictException('INTENT_RECOGNITION_RETRY_UNAVAILABLE');
      const previousOperationId = route.recognitionOperationId ?? route.id;
      const operations = rows<LogicalOperation>(draft, 'logicalOperationsBySession', sessionId);
      const stop = rows<SessionStopRequest>(draft, 'sessionStopRequestsBySession', sessionId).at(-1);
      if (!['idle', 'confirmed'].includes(lifecycle.stopStatus) || (stop && stop.status !== 'confirmed') ||
        operations.some(row => ['requested', 'unconfirmed'].includes(row.stopState) || (row.id === previousOperationId && row.activeInvocationId))) {
        throw new ConflictException('OPERATION_STOP_UNCONFIRMED');
      }
      const source = rows<CollaborationEvent>(draft, 'eventsBySession', sessionId).find(row => row.id === route.sourceEventId && row.type === 'user_message');
      if (!source || source.sessionId !== sessionId) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      const budget = route.blockedReason === 'INTENT_INPUT_BUDGET_EXCEEDED' ? route.inputBudgetDecision : undefined;
      if (Boolean(budget) !== Boolean(request.inputBudget)) throw new ConflictException('INPUT_BUDGET_DECISION_REQUIRED');
      const now = new Date().toISOString(), operationId = budget ? previousOperationId : `${route.id}:recognition:${randomUUID()}`;
      if (budget) {
        const operation = operations.find(row => row.id === budget.operationId);
        const hold = operation?.inputBudgetDecisions?.find(row => row.id === request.inputBudget?.decisionId);
        if (!hold || hold.id !== budget.id || hold.actorId !== actorId || hold.dataEpoch !== session.dataEpoch ||
          hold.sessionGeneration !== lifecycle.generation || hold.kind !== 'intent_understanding' || hold.routingId !== routingId ||
          hold.status !== 'pending' || hold.decision || operation?.activeInvocationId || !route.snapshotId || !route.semanticProposal ||
          !['ready', 'paused'].includes(operation?.status ?? '')) throw new ConflictException('INPUT_BUDGET_DECISION_UNAVAILABLE');
        hold.decision = request.inputBudget!.decision; hold.decidedAt = now;
        hold.status = hold.decision === 'continue' ? 'granted' : 'ended';
        route.inputBudgetDecision = structuredClone(hold);
      }
      const receipt: NonNullable<IntentRoutingRecord['recognitionRetryReceipts']>[number] = { id: randomUUID(), request: structuredClone(request), actorId,
        operationId, previousOperationId, acceptedRoutingRevision: route.routingRevision! + 1, createdAt: now,
        previous: { status: route.status, failureClass: route.failureClass, blockedReason: route.blockedReason, reasonCodes: [...route.reasonCodes],
          classificationAttempts: route.classificationAttempts ?? 0, classificationDeadlineAt: route.classificationDeadlineAt,
          snapshotRebuildCount: route.snapshotRebuildCount ?? 0, snapshotId: route.snapshotId, invocationId: route.invocationId,
          attemptLog: structuredClone(route.attemptLog ?? []), semanticProposal: structuredClone(route.semanticProposal) } };
      (route.recognitionRetryReceipts ??= []).push(receipt);
      route.recognitionOperationId = operationId;
      route.status = budget ? request.inputBudget!.decision === 'end' ? 'REJECTED' : 'SNAPSHOT_READY' : 'RECEIVED';
      route.reasonCodes = [budget && request.inputBudget!.decision === 'end' ? 'INTENT_INPUT_BUDGET_ENDED' : 'INTENT_RECOGNITION_RETRY_REQUESTED'];
      route.routingRevision = receipt.acceptedRoutingRevision; route.updatedAt = now;
      delete route.invocationId; delete route.blockedReason; delete route.failureClass;
      if (!budget) {
        delete route.semanticProposal; delete route.snapshotId;
        delete route.classificationAttempts; delete route.classificationDeadlineAt; delete route.attemptLog; delete route.snapshotRebuildCount;
      }
      const event: CollaborationEvent = { id: `intent-recognition-retry:${receipt.id}`, sessionId, type: 'intent_recognition_retry_requested',
        actor: { type: 'user', id: actorId }, toAgentIds: [], createdAt: now, content: '已受理原消息的重新识别请求，结果仍需校验。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId, sourceEventId: route.sourceEventId,
          operationId, previousOperationId, routingRevision: route.routingRevision, retryReceiptId: receipt.id } } };
      appendCorrectionEvent(draft, event);
      return { routing: structuredClone(route), receipt: structuredClone(receipt), idempotentReplay: false, event };
    }, { sessionIds: [sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    if ((!result.idempotentReplay || !result.receipt.request.inputBudget) && result.routing.status !== 'REJECTED' && result.routing.recognitionOperationId === result.receipt.operationId) this.pipeline.schedule({ sessionId, routingId, recognitionOperationId: result.receipt.operationId });
    return result;
  }
}

function assertInput(value: unknown): asserts value is RetryIntentRecognitionInput {
  const input = value as RetryIntentRecognitionInput;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey', 'inputBudget'].includes(key)) ||
    (input.inputBudget !== undefined && (!input.inputBudget || typeof input.inputBudget !== 'object' ||
      Object.keys(input.inputBudget).some(key => !['decisionId', 'decision'].includes(key)) ||
      typeof input.inputBudget.decisionId !== 'string' || !input.inputBudget.decisionId || !['continue', 'end'].includes(input.inputBudget.decision))) ||
    input.contractVersion !== 'intent-recognition-retry-v1' || !Number.isSafeInteger(input.expectedRoutingRevision) || input.expectedRoutingRevision < 1 ||
    ![input.dataEpoch, input.idempotencyKey].every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256)) {
    throw new BadRequestException('INTENT_RECOGNITION_RETRY_INPUT_INVALID');
  }
}
