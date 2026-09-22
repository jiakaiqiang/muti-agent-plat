import type {
  CollaborationEvent,
  CollaborationLifecycleSnapshot,
  RuntimeStopSummary,
  SessionDetail,
  SessionStopRequest
} from '@agent-cluster/shared';
import { COLLABORATION_CONTRACT_VERSION } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
const SESSION_STOP_REQUESTS_COLLECTION = 'sessionStopRequestsBySession';
type StopRequestsBySession = Record<string, SessionStopRequest[]>;

export const SESSION_LIFECYCLES_COLLECTION = 'sessionLifecyclesBySession';
export type SessionLifecyclesBySession = Record<string, CollaborationLifecycleSnapshot>;

type LifecycleTransition = {
  lifecycle: CollaborationLifecycleSnapshot;
  event?: CollaborationEvent;
  changed: boolean;
};

/** Durable Session admission/tombstone state shared by every server process. */
export class SessionLifecycleStore {
  constructor(private readonly persistence: PersistenceService, private readonly now = Date.now) {}

  get(sessionId: string) {
    return this.persistence.getCollection<SessionLifecyclesBySession>(SESSION_LIFECYCLES_COLLECTION, {})[sessionId];
  }

  generation(sessionId: string) {
    return this.get(sessionId)?.generation;
  }

  isActive(sessionId: string, expectedGeneration?: number) {
    const lifecycle = this.get(sessionId);
    if (!lifecycle) return true; // Legacy Sessions remain on the pre-phase-1 path until first lifecycle mutation.
    return lifecycle.state === 'active' && lifecycle.admission === 'open' &&
      (expectedGeneration === undefined || lifecycle.generation === expectedGeneration);
  }

  matchesActiveGeneration(sessionId: string, expectedGeneration?: number) {
    const lifecycle = this.get(sessionId);
    if (!lifecycle) return expectedGeneration === undefined;
    return expectedGeneration !== undefined && this.isActive(sessionId, expectedGeneration);
  }

  async initialize(sessionId: string, dataEpoch: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      [SESSION_LIFECYCLES_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycles = lifecycleMap(draft);
        const existing = lifecycles[sessionId];
        if (existing) return { lifecycle: structuredClone(existing), changed: false };
        const lifecycle: CollaborationLifecycleSnapshot = {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionId,
          dataEpoch,
          generation: 1,
          revision: 1,
          state: 'active',
          admission: 'open',
          stopStatus: 'idle'
        };
        lifecycles[sessionId] = lifecycle;
        return transition(draft, lifecycle, '会话生命周期已启用。', this.now());
      }
    );
  }

  async beginDelete(sessionId: string, dataEpoch: string, deleteRequestId: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      ['sessions', SESSION_LIFECYCLES_COLLECTION, 'logicalOperationsBySession',
        SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycles = lifecycleMap(draft);
        const current = lifecycles[sessionId];
        if (current?.state === 'deleting' || current?.state === 'deleted') {
          return { lifecycle: structuredClone(current), changed: false };
        }
        const timestamp = new Date(this.now()).toISOString();
        const lifecycle: CollaborationLifecycleSnapshot = {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionId,
          dataEpoch,
          generation: (current?.generation ?? 0) + 1,
          revision: (current?.revision ?? 0) + 1,
          state: 'deleting',
          admission: 'closed',
          stopStatus: 'requested',
          deleteRequestId
        };
        lifecycles[sessionId] = lifecycle;
        const session = findSession(draft, sessionId);
        if (session && session.status !== 'PAUSED') {
          session.pauseState = { previousStatus: session.status, pausedAt: timestamp, reason: 'session_delete' };
          session.status = 'PAUSED';
          session.revision = (session.revision ?? 0) + 1;
          session.updatedAt = timestamp;
        }
        return transition(draft, lifecycle, '会话删除已开始，新的执行准入已关闭。', this.now());
      }
    );
  }

  async closeForStop(sessionId: string, dataEpoch: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      [SESSION_LIFECYCLES_COLLECTION, 'logicalOperationsBySession', SESSION_STOP_REQUESTS_COLLECTION,
        'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycles = lifecycleMap(draft);
        const current = lifecycles[sessionId];
        if (current && current.state !== 'active') return { lifecycle: structuredClone(current), changed: false };
        if (current?.admission === 'closed') return { lifecycle: structuredClone(current), changed: false };
        const lifecycle: CollaborationLifecycleSnapshot = {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          sessionId,
          dataEpoch,
          generation: current?.generation ?? 1,
          revision: (current?.revision ?? 0) + 1,
          state: 'active',
          admission: 'closed',
          stopStatus: 'requested'
        };
        lifecycles[sessionId] = lifecycle;
        return transition(draft, lifecycle, '会话停止中，新的执行准入已关闭。', this.now());
      }
    );
  }

  /**
   * Marks a safely stopped session as archived without changing the existing
   * deleted tombstone semantics. The lifecycle remains active but admission is
   * closed until the archive is restored.
   */
  async markArchived(sessionId: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      ['sessions', SESSION_LIFECYCLES_COLLECTION, SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycles = lifecycleMap(draft);
        const lifecycle = lifecycles[sessionId];
        if (!lifecycle) throw new Error('SESSION_LIFECYCLE_NOT_FOUND');
        const session = findSession(draft, sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (session.archivedAt) return { lifecycle: structuredClone(lifecycle), changed: false };
        if (lifecycle.state !== 'active' || lifecycle.admission !== 'closed') {
          throw new Error('SESSION_ARCHIVE_ADMISSION_NOT_CLOSED');
        }
        const stopSummary = stopSummaryFromDraft(draft, sessionId);
        if (!stopSummary.canResume) throw new Error('SESSION_STOP_UNCONFIRMED');
        const timestamp = new Date(this.now()).toISOString();
        session.archivedAt = timestamp;
        session.status = 'PAUSED';
        session.pauseState = {
          previousStatus: session.pauseState?.previousStatus ?? 'EXECUTING',
          pausedAt: timestamp,
          reason: 'session_archived'
        };
        session.revision = (session.revision ?? 0) + 1;
        session.updatedAt = timestamp;
        lifecycle.revision += 1;
        lifecycle.stopStatus = stopSummary.status;
        return transition(draft, lifecycle, '会话已归档，已从会话列表隐藏。', this.now());
      }
    );
  }

  /** Restores an archived session to the active session projection. */
  async restoreArchived(sessionId: string, requestId: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      ['sessions', SESSION_LIFECYCLES_COLLECTION, SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycles = lifecycleMap(draft);
        const lifecycle = lifecycles[sessionId];
        if (!lifecycle) throw new Error('SESSION_LIFECYCLE_NOT_FOUND');
        const session = findSession(draft, sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (!session.archivedAt) return { lifecycle: structuredClone(lifecycle), changed: false };
        const stopSummary = stopSummaryFromDraft(draft, sessionId);
        if (!stopSummary.canResume) throw new Error('SESSION_STOP_UNCONFIRMED');
        const timestamp = new Date(this.now()).toISOString();
        delete session.archivedAt;
        session.status = 'PAUSED';
        session.pauseState = {
          previousStatus: session.pauseState?.previousStatus ?? 'EXECUTING',
          pausedAt: timestamp,
          reason: 'session_archive_restored'
        };
        session.revision = (session.revision ?? 0) + 1;
        session.updatedAt = timestamp;
        lifecycle.admission = 'open';
        lifecycle.stopStatus = stopSummary.status;
        lifecycle.generation += 1;
        lifecycle.revision += 1;
        lifecycle.lastRestoreRequestId = requestId;
        lifecycle.restoredAt = timestamp;
        return transition(draft, lifecycle, '会话已从归档恢复到会话列表，当前处于暂停状态。', this.now());
      }
    );
  }

  async reopen(sessionId: string): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      [SESSION_LIFECYCLES_COLLECTION, SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycle = requireLifecycle(draft, sessionId);
        if (lifecycle.state !== 'active') throw new Error('SESSION_LIFECYCLE_NOT_ACTIVE');
        const status = latestStopStatus(draft, sessionId);
        if (status !== 'idle' && status !== 'confirmed') throw new Error('SESSION_STOP_UNCONFIRMED');
        if (lifecycle.admission === 'open' && (lifecycle.stopStatus === 'idle' || lifecycle.stopStatus === 'confirmed')) {
          return { lifecycle: structuredClone(lifecycle), changed: false };
        }
        lifecycle.admission = 'open';
        lifecycle.stopStatus = status;
        lifecycle.revision += 1;
        return transition(draft, lifecycle, '会话执行准入已恢复。', this.now());
      }
    );
  }

  async completeDelete(sessionId: string): Promise<LifecycleTransition & { stopSummary: RuntimeStopSummary }> {
    return this.persistence.mutateCollections(
      [SESSION_LIFECYCLES_COLLECTION, SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycle = requireLifecycle(draft, sessionId);
        const stopSummary = stopSummaryFromDraft(draft, sessionId);
        if (lifecycle.state === 'deleted') return {
          lifecycle: structuredClone(lifecycle), stopSummary, changed: false
        };
        if (lifecycle.state !== 'deleting') throw new Error('SESSION_DELETE_NOT_STARTED');
        lifecycle.stopStatus = stopSummary.status;
        lifecycle.revision += 1;
        if (!stopSummary.canResume) {
          const pending = transition(draft, lifecycle, '会话仍在删除中，正在等待可信停止证据。', this.now());
          return { ...pending, stopSummary };
        }
        lifecycle.state = 'deleted';
        lifecycle.admission = 'closed';
        lifecycle.deletedAt = new Date(this.now()).toISOString();
        return {
          ...transition(draft, lifecycle, '会话已安全隐藏，可在删除列表中恢复。', this.now()),
          stopSummary
        };
      }
    );
  }

  async restore(sessionId: string, input: { requestId: string; expectedGeneration: number }): Promise<LifecycleTransition> {
    return this.persistence.mutateCollections(
      ['sessions', SESSION_LIFECYCLES_COLLECTION, SESSION_STOP_REQUESTS_COLLECTION,
        'eventsBySession', 'eventOutbox'],
      draft => {
        const lifecycle = requireLifecycle(draft, sessionId);
        if (lifecycle.lastRestoreRequestId === input.requestId) {
          return { lifecycle: structuredClone(lifecycle), changed: false };
        }
        if (lifecycle.generation !== input.expectedGeneration) throw new Error('SESSION_LIFECYCLE_STALE_GENERATION');
        if (lifecycle.state !== 'deleted') throw new Error('SESSION_LIFECYCLE_NOT_DELETED');
        const stopStatus = latestStopStatus(draft, sessionId);
        if (stopStatus !== 'idle' && stopStatus !== 'confirmed') throw new Error('SESSION_STOP_UNCONFIRMED');
        const timestamp = new Date(this.now()).toISOString();
        lifecycle.state = 'active';
        lifecycle.admission = 'closed';
        lifecycle.stopStatus = stopStatus;
        lifecycle.generation += 1;
        lifecycle.revision += 1;
        lifecycle.lastRestoreRequestId = input.requestId;
        lifecycle.restoredAt = timestamp;
        delete lifecycle.deletedAt;
        delete lifecycle.deleteRequestId;
        const session = findSession(draft, sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');
        session.status = 'PAUSED';
        session.pauseState = {
          previousStatus: session.pauseState?.previousStatus ?? 'EXECUTING',
          pausedAt: timestamp,
          reason: 'session_restored'
        };
        session.revision = (session.revision ?? 0) + 1;
        session.updatedAt = timestamp;
        return transition(draft, lifecycle, '会话已恢复为暂停状态，需要用户显式继续。', this.now());
      }
    );
  }
}

export function syncLifecycleStopStatus(draft: PersistedState, sessionId: string, status: RuntimeStopSummary['status']) {
  const lifecycle = lifecycleMap(draft)[sessionId];
  if (!lifecycle || lifecycle.stopStatus === status) return;
  lifecycle.stopStatus = status;
  lifecycle.revision += 1;
}

function lifecycleMap(draft: PersistedState) {
  return (draft[SESSION_LIFECYCLES_COLLECTION] ??= {}) as SessionLifecyclesBySession;
}

function requireLifecycle(draft: PersistedState, sessionId: string) {
  const lifecycle = lifecycleMap(draft)[sessionId];
  if (!lifecycle) throw new Error('SESSION_LIFECYCLE_NOT_FOUND');
  return lifecycle;
}

function findSession(draft: PersistedState, sessionId: string) {
  return Array.isArray(draft.sessions)
    ? (draft.sessions as SessionDetail[]).find(session => session.id === sessionId)
    : undefined;
}

function latestStopStatus(draft: PersistedState, sessionId: string): RuntimeStopSummary['status'] {
  const latest = ((draft[SESSION_STOP_REQUESTS_COLLECTION] ?? {}) as StopRequestsBySession)[sessionId]?.at(-1);
  return latest?.status ?? 'idle';
}

function stopSummaryFromDraft(draft: PersistedState, sessionId: string): RuntimeStopSummary {
  const request = ((draft[SESSION_STOP_REQUESTS_COLLECTION] ?? {}) as StopRequestsBySession)[sessionId]?.at(-1);
  if (!request) return emptyStopSummary(sessionId);
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

function emptyStopSummary(sessionId: string): RuntimeStopSummary {
  return { sessionId, version: 0, status: 'idle', requestedCount: 0, confirmedCount: 0,
    targets: [], blockers: [], canResume: true };
}

function transition(
  draft: PersistedState,
  lifecycle: CollaborationLifecycleSnapshot,
  content: string,
  now: number
): LifecycleTransition {
  const event = appendLifecycleEvent(draft, lifecycle, content, now);
  return { lifecycle: structuredClone(lifecycle), event, changed: true };
}

function appendLifecycleEvent(
  draft: PersistedState,
  lifecycle: CollaborationLifecycleSnapshot,
  content: string,
  now: number
) {
  const idempotencyKey = `session-lifecycle:${lifecycle.sessionId}:${lifecycle.revision}`;
  const eventsBySession = (draft.eventsBySession ??= {}) as Record<string, CollaborationEvent[]>;
  const events = eventsBySession[lifecycle.sessionId] ??= [];
  const existing = events.find(event => event.metadata.idempotencyKey === idempotencyKey);
  if (existing) return existing;
  const event: CollaborationEvent = {
    id: idempotencyKey,
    sessionId: lifecycle.sessionId,
    type: 'session_lifecycle_changed',
    priority: lifecycle.state === 'active' && lifecycle.admission === 'open' ? 'normal' : 'high',
    toAgentIds: [],
    content,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      idempotencyKey,
      payload: { code: 'SESSION_LIFECYCLE_CHANGED', lifecycle: structuredClone(lifecycle) }
    },
    actor: { type: 'system', id: 'session-lifecycle', displayName: 'Session Lifecycle' },
    createdAt: new Date(now).toISOString()
  };
  events.push(event);
  const outbox = (draft.eventOutbox ??= []) as Array<Record<string, unknown>>;
  const outboxId = `outbox:${event.id}`;
  if (!outbox.some(record => record.id === outboxId)) outbox.push({
    id: outboxId,
    idempotencyKey: `session:${event.sessionId}:event:${event.id}`,
    aggregateType: 'session', aggregateId: event.sessionId, eventType: event.type,
    payload: { event: structuredClone(event) }, status: 'pending', attempts: 0, createdAt: event.createdAt
  });
  return event;
}
