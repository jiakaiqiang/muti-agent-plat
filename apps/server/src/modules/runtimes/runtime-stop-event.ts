import type { CollaborationEvent, SessionStopRequest } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import type { PersistedState } from '../persistence/persistence.service.js';

export function appendRuntimeStopStateEvent(draft: PersistedState, request: SessionStopRequest) {
  const idempotencyKey = `runtime-stop:${request.id}:${request.version}`;
  const eventsBySession = (draft.eventsBySession ??= {}) as Record<string, CollaborationEvent[]>;
  const events = eventsBySession[request.sessionId] ??= [];
  const existing = events.find(event => event.metadata.idempotencyKey === idempotencyKey);
  const confirmedCount = request.targets.filter(target => target.state === 'confirmed').length;
  if (existing) {
    const summary = (existing.metadata.payload as { stopSummary?: {
      status?: string;
      requestedCount?: number;
      confirmedCount?: number;
    } }).stopSummary;
    if (summary?.status !== request.status || summary.requestedCount !== request.targets.length ||
      summary.confirmedCount !== confirmedCount) {
      workspaceMetrics.increment('runtime_stop_event_idempotency_conflict_total');
    }
    return existing;
  }
  const event: CollaborationEvent = {
    id: idempotencyKey,
    sessionId: request.sessionId,
    type: 'runtime_progress',
    priority: request.status === 'confirmed' ? 'normal' : 'high',
    toAgentIds: [],
    content: request.status === 'confirmed'
      ? '执行已停止。'
      : `已确认 ${confirmedCount}/${request.targets.length} 个停止目标。`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      idempotencyKey,
      payload: {
        code: 'RUNTIME_STOP_STATE_CHANGED',
        stopRequestId: request.id,
        version: request.version,
        stopSummary: {
          sessionId: request.sessionId,
          stopRequestId: request.id,
          version: request.version,
          status: request.status,
          requestedCount: request.targets.length,
          confirmedCount,
          targets: structuredClone(request.targets),
          blockers: request.targets.filter(target => target.state !== 'confirmed').map(target => ({
            invocationId: target.invocationId,
            ...(target.operationId ? { operationId: target.operationId } : {}),
            reason: target.state === 'unknown' ? 'process_exit_unknown' : 'process_running',
            message: target.state === 'unknown' ? '尚无可信的进程结束证据。' : '正在等待执行进程结束。'
          })),
          canResume: request.status === 'confirmed',
          updatedAt: request.updatedAt
        }
      }
    },
    actor: { type: 'system', id: 'runtime-supervisor', displayName: 'Runtime Supervisor' },
    createdAt: request.updatedAt
  };
  events.push(event);
  const outbox = (draft.eventOutbox ??= []) as Array<Record<string, unknown>>;
  const outboxId = `outbox:${event.id}`;
  if (!outbox.some(record => record.id === outboxId)) outbox.push({
    id: outboxId,
    idempotencyKey: `session:${event.sessionId}:event:${event.id}`,
    aggregateType: 'session',
    aggregateId: event.sessionId,
    eventType: event.type,
    payload: { event: structuredClone(event) },
    status: 'pending',
    attempts: 0,
    createdAt: event.createdAt
  });
  return event;
}
