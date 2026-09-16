import type { LogicalOperation, RuntimeStopSummary, SessionStopRequest } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import { appendRuntimeStopStateEvent } from './runtime-stop-event.js';

export const SESSION_STOP_REQUESTS_COLLECTION = 'sessionStopRequestsBySession';
export type StopRequestsBySession = Record<string, SessionStopRequest[]>;
type OperationsBySession = Record<string, LogicalOperation[]>;

export class SessionStopStateStore {
  constructor(private readonly persistence: PersistenceService, private readonly now = Date.now) {}

  list(sessionId: string) {
    return this.persistence.getCollection<StopRequestsBySession>(SESSION_STOP_REQUESTS_COLLECTION, {})[sessionId] ?? [];
  }

  latest(sessionId: string) {
    return this.list(sessionId).at(-1);
  }

  async request(sessionId: string, reason: string, supervisedInvocationIds: string[] = []) {
    return (await this.requestWithEvent(sessionId, reason, supervisedInvocationIds)).request;
  }

  async requestWithEvent(sessionId: string, reason: string, supervisedInvocationIds: string[] = []) {
    return this.persistence.mutateCollections(
      ['logicalOperationsBySession', SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      (draft: PersistedState) => {
        const requests = (draft[SESSION_STOP_REQUESTS_COLLECTION] ??= {}) as StopRequestsBySession;
        const existing = requests[sessionId]?.at(-1);
        if (existing && existing.status !== 'confirmed') return {
          request: structuredClone(existing),
          event: appendRuntimeStopStateEvent(draft, existing)
        };

        const operations = ((draft.logicalOperationsBySession ?? {}) as OperationsBySession)[sessionId] ?? [];
        const targetIds = new Set<string>();
        for (const operation of operations) {
          if (operation.activeInvocationId && operation.stopState !== 'confirmed') targetIds.add(operation.activeInvocationId);
        }
        const timestamp = new Date(this.now()).toISOString();
        const targets = [...targetIds].map(invocationId => {
          const operation = operations.find(item => item.activeInvocationId === invocationId || item.invocationIds.includes(invocationId));
          return {
            invocationId,
            ...(operation ? { operationId: operation.id } : {}),
            state: 'waiting' as const,
            updatedAt: timestamp
          };
        });
        const request: SessionStopRequest = {
          id: crypto.randomUUID(),
          sessionId,
          reason,
          targetInvocationIds: targets.map(target => target.invocationId),
          targets,
          version: 1,
          status: targets.length ? 'waiting' : 'confirmed',
          createdAt: timestamp,
          updatedAt: timestamp
        };
        (requests[sessionId] ??= []).push(request);
        return { request: structuredClone(request), event: appendRuntimeStopStateEvent(draft, request) };
      }
    );
  }

  summary(sessionId: string): RuntimeStopSummary {
    const request = this.latest(sessionId);
    if (!request) return {
      sessionId,
      version: 0,
      status: 'idle',
      requestedCount: 0,
      confirmedCount: 0,
      targets: [],
      blockers: [],
      canResume: true
    };
    const blockers = request.targets.filter(target => target.state !== 'confirmed').map(target => ({
      invocationId: target.invocationId,
      ...(target.operationId ? { operationId: target.operationId } : {}),
      reason: target.state === 'pending_sync' ? 'stop_state_pending_sync' as const
        : target.state === 'unknown' ? 'process_exit_unknown' as const : 'process_running' as const,
      message: target.state === 'pending_sync' ? '执行已结束，停止状态正在同步。'
        : target.state === 'unknown' ? '尚无可信的进程结束证据。' : '正在等待执行进程结束。'
    }));
    const confirmedCount = request.targets.filter(target => target.state === 'confirmed').length;
    return {
      sessionId,
      stopRequestId: request.id,
      version: request.version,
      status: request.status,
      requestedCount: request.targets.length,
      confirmedCount,
      targets: structuredClone(request.targets),
      blockers,
      canResume: request.status === 'confirmed' && blockers.length === 0,
      updatedAt: request.updatedAt
    };
  }
}
