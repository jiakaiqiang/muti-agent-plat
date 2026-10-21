import type { CollaborationEvent, IntentCorrection } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { INTENT_RECORD_TABLES } from '../persistence/intent-record-invariants.js';

export const correctionCollections = ['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession',
  'workItemsBySession', 'tasksBySession', 'decisionRecordsBySession', 'followUpMessagesBySession', 'briefsBySession',
  'contextSnapshotsBySession', 'logicalOperationsBySession', 'workspaceWritebacks', 'artifacts', 'eventsBySession', 'eventOutbox', ...Object.keys(INTENT_RECORD_TABLES)];

export function correctionRows<T>(draft: PersistedState, key: string, sessionId: string): T[] {
  return (((draft[key] ??= {}) as Record<string, T[]>)[sessionId] ??= []);
}

export function correctionEvent(correction: IntentCorrection, type: CollaborationEvent['type'], id: string, content: string): CollaborationEvent {
  return { id, sessionId: correction.sessionId, type, content, toAgentIds: [], createdAt: correction.updatedAt,
    actor: { type: 'system', id: 'intent-correction' }, metadata: { schemaVersion: '0.1', renderAs: 'system_notice', idempotencyKey: id,
      payload: { correctionId: correction.id, routingId: correction.routingId, routingRevision: correction.routingRevision,
        intentRevision: correction.pendingIntentRevision, correctionStatus: correction.status, reasonCodes: correction.reasonCodes,
        ...(correction.status === 'applied' ? { retainedArtifactIds: (correction.effectReconciliation?.executions ?? []).flatMap(row => row.artifactId ? [row.artifactId] : []) } : {}) } } };
}

export function appendCorrectionEvent(draft: PersistedState, event: CollaborationEvent) {
  const events = correctionRows<CollaborationEvent>(draft, 'eventsBySession', event.sessionId);
  if (events.some(item => item.id === event.id)) return;
  events.push(event);
  ((draft.eventOutbox ??= []) as unknown[]).push({ id: `outbox:${event.id}`, idempotencyKey: `session:${event.sessionId}:event:${event.id}`,
    aggregateType: 'session', aggregateId: event.sessionId, eventType: event.type, payload: { event: structuredClone(event) },
    status: 'pending', attempts: 0, createdAt: event.createdAt });
}
