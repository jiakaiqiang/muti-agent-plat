import type { PersistedState } from './persistence.service.js';

/**
 * Limits a collection transaction to the Sessions it names. Only the
 * Session-partitioned event projections are narrowed; every other collection
 * keeps its full-collection semantics.
 */
export type CollectionScope = { sessionIds?: string[] };

export const SESSION_SCOPED_COLLECTIONS = new Set(['eventsBySession', 'eventOutbox']);

export function scopedSessionIds(scope: CollectionScope | undefined): string[] | undefined {
  return scope?.sessionIds?.length ? [...new Set(scope.sessionIds)] : undefined;
}

/** Rejects a mutation that added or edited event projections outside its scope. */
export function assertWithinCollectionScope(
  before: PersistedState,
  after: PersistedState,
  scope: CollectionScope | undefined
) {
  const sessionIds = scopedSessionIds(scope);
  if (!sessionIds) return;
  const allowed = new Set(sessionIds);
  if (isPlainRecord(after.eventsBySession)) {
    const previous = isPlainRecord(before.eventsBySession) ? before.eventsBySession : {};
    for (const [sessionId, events] of Object.entries(after.eventsBySession)) {
      if (!allowed.has(sessionId) && JSON.stringify(events) !== JSON.stringify(previous[sessionId])) {
        throw new Error(`COLLECTION_SCOPE_VIOLATION: eventsBySession:${sessionId}`);
      }
    }
  }
  if (Array.isArray(after.eventOutbox)) {
    for (const item of changedById(Array.isArray(before.eventOutbox) ? before.eventOutbox : [], after.eventOutbox)) {
      const sessionId = outboxSessionId(item);
      if (!sessionId || !allowed.has(sessionId)) {
        throw new Error(`COLLECTION_SCOPE_VIOLATION: eventOutbox:${sessionId ?? 'unknown'}`);
      }
    }
  }
}

/**
 * Folds a scoped commit into the full in-memory collection: the scoped Sessions
 * take the committed value, every other Session keeps what the cache holds.
 */
export function mergeScopedCollection(key: string, current: unknown, committed: unknown, sessionIds: string[]): unknown {
  const scoped = new Set(sessionIds);
  if (key === 'eventsBySession') {
    const result: Record<string, unknown> = isPlainRecord(current) ? structuredClone(current) : {};
    for (const sessionId of scoped) delete result[sessionId];
    if (isPlainRecord(committed)) Object.assign(result, structuredClone(committed));
    return result;
  }
  if (key === 'eventOutbox') {
    const kept = (Array.isArray(current) ? current : []).filter(item => !scoped.has(outboxSessionId(item) ?? ''));
    return [...structuredClone(kept), ...structuredClone(Array.isArray(committed) ? committed : [])];
  }
  return structuredClone(committed);
}

/** Records in `after` that are new or differ from the record with the same id in `before`. */
export function changedById(before: unknown[], after: unknown[]): unknown[] {
  const previous = new Map<string, string>();
  for (const item of before) {
    const id = isPlainRecord(item) ? item.id : undefined;
    if (typeof id === 'string' && id) previous.set(id, JSON.stringify(item));
  }
  return after.filter(item => {
    const id = isPlainRecord(item) ? item.id : undefined;
    // Records without a stable id cannot be matched, so they are always treated as changed.
    return typeof id !== 'string' || !id || previous.get(id) !== JSON.stringify(item);
  });
}

function outboxSessionId(item: unknown): string | undefined {
  if (!isPlainRecord(item) || item.aggregateType !== 'session') return undefined;
  return typeof item.aggregateId === 'string' ? item.aggregateId : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
