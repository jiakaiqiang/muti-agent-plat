import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { validateRuntimeOutput, type CollaborationEvent, type IntentPlanStepRecord } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { assertCurrentIntentBrief, type IntentBriefReference } from './intent-brief-store.service.js';
import { INTENT_EXECUTION_COLLECTIONS } from './intent-execution-guard.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'briefsBySession', 'eventsBySession', 'eventOutbox', ...INTENT_EXECUTION_COLLECTIONS];
@Injectable()
export class IntentBriefReviewStoreService {
  constructor(private readonly persistence: PersistenceService) {}

  async saveResult(reference: IntentBriefReference, agentId: string, output: unknown) {
    const parsed = validateRuntimeOutput('agent_message', output);
    if (!parsed.valid || !parsed.value.content.trim() || Buffer.byteLength(parsed.value.content, 'utf8') > 32000) throw new Error('INTENT_BRIEF_REVIEW_OUTPUT_INVALID');
    return this.persistence.mutateCollections(collections, draft => {
      const { step } = assertCurrentIntentBrief(draft, reference, true);
      if (step.step.target.agentIds[0] !== agentId) throw new Error('INTENT_BRIEF_REVIEW_AGENT_MISMATCH');
      const result = { agentId, invocationId: reference.invocationId, content: parsed.value.content };
      if (step.processing!.result && !isDeepStrictEqual(step.processing!.result, result)) throw new Error('INTENT_BRIEF_REVIEW_RESULT_CONFLICT');
      step.processing!.result = result;
    }, { sessionIds: [reference.sessionId] });
  }

  async publish(reference: IntentBriefReference) {
    return this.persistence.mutateCollections(collections, draft => {
      const old = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', reference.sessionId).find(row => row.id === reference.stepId);
      if (old?.status === 'completed' && old.step.action === 'review_brief' && old.processing?.ownerId === reference.ownerId &&
        old.processing.result?.invocationId === reference.invocationId && old.responseEventId) {
        const event = rows<CollaborationEvent>(draft, 'eventsBySession', reference.sessionId).find(row => row.id === old.responseEventId);
        if (!event) throw new Error('INTENT_BRIEF_REVIEW_RECEIPT_MISSING');
        return { event: structuredClone(event), idempotentReplay: true };
      }
      const { session, step, route, work } = assertCurrentIntentBrief(draft, reference, true), result = step.processing!.result;
      if (!result || result.agentId !== step.step.target.agentIds[0] || result.invocationId !== reference.invocationId) throw new Error('INTENT_BRIEF_REVIEW_RESULT_MISSING');
      const now = new Date().toISOString();
      const event: CollaborationEvent = { id: `intent-brief-review:${step.id}`, sessionId: session.id, workItemId: work.id,
        type: 'agent_message', fromAgentId: result.agentId, toAgentIds: [], content: result.content, createdAt: now,
        metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { code: 'INTENT_BRIEF_REVIEW_COMPLETED',
          routingId: route.id, intentRevision: step.intentRevision, stepId: step.id, runtimeInvocationId: result.invocationId,
          relatedBriefId: step.step.replacesBrief?.briefId, suggestionOnly: true, replyToEventId: route.semanticPlan!.sourceEventId } } };
      appendCorrectionEvent(draft, event); step.status = 'completed'; step.responseEventId = event.id; step.updatedAt = now;
      // A completed opinion does not complete the route or approve any decision.
      route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = now;
      return { event: structuredClone(event), idempotentReplay: false };
    }, { sessionIds: [reference.sessionId] });
  }
}
