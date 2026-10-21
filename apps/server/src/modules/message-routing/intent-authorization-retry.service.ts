import { ConflictException, Injectable } from '@nestjs/common';
import type { CollaborationEvent, IntentContextSnapshot, IntentRoutingRecord, SessionDetail } from '@agent-cluster/shared';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { assertAuthorizationRetryInput, bindAuthorizationRetry } from './intent-authorization-retry.js';

@Injectable()
export class IntentAuthorizationRetryService {
  constructor(private readonly persistence: PersistenceService, private readonly context: ContextManagementService,
    private readonly plans: IntentPlanCommitService) {}

  async retry(sessionId: string, routingId: string, actorId: string, input: unknown) {
    assertAuthorizationRetryInput(input);
    // Refresh the relevant session scope before reading; another server may have changed the grant or committed this receipt.
    const { session, route, receipt } = await this.persistence.mutateCollections(['sessions', 'intentRoutingRecordsBySession', 'eventsBySession',
      'contextSnapshotsBySession', 'workItemsBySession', 'decisionRecordsBySession', 'summaryCheckpointsBySession', 'followUpMessagesBySession', 'tasksBySession', 'artifacts'], draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const route = (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]> | undefined)?.[sessionId]?.find(row => row.id === routingId);
      if (!session || session.ownerId !== actorId || session.dataEpoch !== input.dataEpoch || !route) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      return { session: structuredClone(session), route: structuredClone(route), receipt: bindAuthorizationRetry(route, actorId, input) };
    }, { sessionIds: [sessionId] });
    let snapshotId = route.snapshotId!;
    if (!receipt) {
      const event = this.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {})[sessionId]?.find(row => row.id === route.sourceEventId && row.type === 'user_message');
      if (!event || event.sessionId !== sessionId) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      const original = this.persistence.getCollection<Record<string, IntentContextSnapshot[]>>('contextSnapshotsBySession', {})[sessionId]?.find(row => row.id === route.semanticProposal!.snapshotId);
      if (!original || original.sourceEventId !== event.id || original.currentMessage !== event.content) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      const targetIds = route.semanticProposal!.understanding!.segments.flatMap(segment => segment.target.workItemId ? [segment.target.workItemId] : []);
      const snapshot = await this.context.buildIntentSnapshot({ session, sourceEventId: event.id, currentMessage: event.content,
        latestEventSeq: 0, explicitWorkItemIds: targetIds, decisionWorkItemIds: targetIds,
        mentionedAgentIds: original.mentionedAgentIds, skillRef: original.skillRef, agentRefs: original.agentRefs,
        attachmentRefs: original.attachmentRefs, replyToEventId: original.replyToEventId });
      snapshotId = snapshot.id;
    }
    // The transaction repeats ownership, CAS, source, lifecycle and current-authority validation.
    return this.plans.commit({ sessionId, routingId, actorId, expectedRoutingRevision: input.expectedRoutingRevision,
      authorizationRetry: { request: input, snapshotId } });
  }
}
