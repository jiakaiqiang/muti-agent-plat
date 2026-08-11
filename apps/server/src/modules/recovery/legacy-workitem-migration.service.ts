import { Injectable } from '@nestjs/common';
import type { SessionDetail, WorkItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';

export type LegacyWorkItemMigrationIssue = {
  sessionId: string;
  collection: string;
  code: 'MISSING_SESSION' | 'MISSING_WORK_ITEM' | 'CROSS_SESSION_RECORD';
  count: number;
};

export type LegacyWorkItemMigrationSessionReport = {
  sessionId: string;
  workItemId?: string;
  requiresBootstrap: boolean;
  plannedRecordCount: number;
  plannedByCollection: Record<string, number>;
};

export type LegacyWorkItemMigrationReport = {
  mode: 'report' | 'apply';
  revision: string;
  sessionCount: number;
  plannedRecordCount: number;
  migratedRecordCount: number;
  sessions: LegacyWorkItemMigrationSessionReport[];
  issues: LegacyWorkItemMigrationIssue[];
};

const GROUPED_COLLECTIONS = [
  'eventsBySession',
  'briefsBySession',
  'tasksBySession',
  'memoriesBySession',
  'runtimeInvocationsBySession'
] as const;

@Injectable()
export class LegacyWorkItemMigrationService {
  constructor(private readonly persistence: PersistenceService) {}

  report(sessions: SessionDetail[], mode: 'report' | 'apply' = 'report'): LegacyWorkItemMigrationReport {
    const state = this.persistence.snapshotState();
    const workItems = state.workItemsBySession as Record<string, WorkItem[]> | undefined;
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const sessionReports: LegacyWorkItemMigrationSessionReport[] = [];
    const issues: LegacyWorkItemMigrationIssue[] = [];
    let plannedRecordCount = 0;

    for (const session of sessions) {
      const workItemId = session.activeWorkItemId ?? workItems?.[session.id]?.[0]?.id;
      const plannedByCollection: Record<string, number> = {};
      for (const collection of GROUPED_COLLECTIONS) {
        const count = this.countMissingGrouped(state, collection, session.id);
        if (count) plannedByCollection[collection] = count;
      }
      const artifactCount = this.countMissingArtifacts(state, session.id);
      if (artifactCount) plannedByCollection.artifacts = artifactCount;
      const workflowCount = this.countMissingWorkflowRuns(state, session.id);
      if (workflowCount) plannedByCollection.workflowRuntime = workflowCount;
      const total = Object.values(plannedByCollection).reduce((sum, count) => sum + count, 0);
      plannedRecordCount += total;
      sessionReports.push({
        sessionId: session.id,
        ...(workItemId ? { workItemId } : {}),
        requiresBootstrap: !workItemId,
        plannedRecordCount: total,
        plannedByCollection
      });
    }

    for (const [sessionId, grouped] of Object.entries((state.eventsBySession ?? {}) as Record<string, unknown>)) {
      if (!sessionMap.has(sessionId)) {
        const count = Array.isArray(grouped) ? grouped.length : 0;
        if (count) issues.push({ sessionId, collection: 'eventsBySession', code: 'MISSING_SESSION', count });
      }
    }
    return {
      mode,
      revision: this.persistence.stateRevision(),
      sessionCount: sessions.length,
      plannedRecordCount,
      migratedRecordCount: mode === 'apply' ? plannedRecordCount : 0,
      sessions: sessionReports,
      issues
    };
  }

  async apply(sessions: SessionDetail[]): Promise<LegacyWorkItemMigrationReport> {
    const revision = this.persistence.stateRevision();
    const report = this.report(sessions, 'apply');
    const migratedRecordCount = await this.persistence.mutateStateAtomically(revision, (draft) => {
      const workItems = (draft.workItemsBySession ?? {}) as Record<string, WorkItem[]>;
      const workItemBySession = new Map(sessions.map((session) => [session.id, session.activeWorkItemId ?? workItems[session.id]?.[0]?.id]));
      let migrated = 0;
      for (const collection of GROUPED_COLLECTIONS) {
        const grouped = draft[collection] as Record<string, unknown[]> | undefined;
        if (!grouped) continue;
        for (const [sessionId, records] of Object.entries(grouped)) {
          const workItemId = workItemBySession.get(sessionId);
          if (!workItemId || !Array.isArray(records)) continue;
          for (const record of records) {
            if (!record || typeof record !== 'object') continue;
            const item = record as Record<string, unknown>;
            if (!item.workItemId) {
              item.workItemId = workItemId;
              migrated += 1;
            }
          }
        }
      }
      const artifacts = (draft.artifacts as { artifactsById?: Record<string, Record<string, unknown>> } | undefined)?.artifactsById;
      if (artifacts) {
        for (const item of Object.values(artifacts)) {
          const workItemId = item.sessionId ? workItemBySession.get(String(item.sessionId)) : undefined;
          if (workItemId && !item.workItemId) {
            item.workItemId = workItemId;
            migrated += 1;
          }
        }
      }
      const runs = (draft.workflowRuntime as { runs?: Record<string, unknown>[] } | undefined)?.runs;
      if (Array.isArray(runs)) {
        for (const item of runs) {
          const workItemId = item.sessionId ? workItemBySession.get(String(item.sessionId)) : undefined;
          if (workItemId && !item.workItemId) {
            item.workItemId = workItemId;
            migrated += 1;
          }
        }
      }
      return migrated;
    }, { lockKey: 'legacy-work-item-migration' });
    return { ...report, migratedRecordCount };
  }

  private countMissingGrouped(state: PersistedState, collection: string, sessionId: string) {
    const records = (state[collection] as Record<string, unknown[]> | undefined)?.[sessionId];
    return Array.isArray(records) ? records.filter((item) => item && typeof item === 'object' && !(item as Record<string, unknown>).workItemId).length : 0;
  }

  private countMissingArtifacts(state: PersistedState, sessionId: string) {
    const artifacts = (state.artifacts as { artifactsById?: Record<string, Record<string, unknown>> } | undefined)?.artifactsById ?? {};
    return Object.values(artifacts).filter((item) => item.sessionId === sessionId && !item.workItemId).length;
  }

  private countMissingWorkflowRuns(state: PersistedState, sessionId: string) {
    const runs = (state.workflowRuntime as { runs?: Record<string, unknown>[] } | undefined)?.runs ?? [];
    return Array.isArray(runs) ? runs.filter((item) => item.sessionId === sessionId && !item.workItemId).length : 0;
  }
}
