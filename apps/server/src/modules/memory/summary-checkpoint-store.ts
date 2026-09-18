import { createHash } from 'node:crypto';
import type {
  AgentRunPhase,
  SessionDetail,
  SummaryCheckpointRecord,
  SummaryCheckpointRejectionCode,
  SummaryMemory,
  WorkItem
} from '@agent-cluster/shared';
import type { PersistedState, PersistenceService } from '../persistence/persistence.service.js';
import {
  SESSION_LIFECYCLES_COLLECTION,
  type SessionLifecyclesBySession
} from '../runtimes/session-lifecycle-store.js';

export const SUMMARY_CHECKPOINTS_COLLECTION = 'summaryCheckpointsBySession';
export type SummaryCheckpointsBySession = Record<string, SummaryCheckpointRecord[]>;

export type SummaryCheckpointDraft = {
  sessionId: string;
  workItemId: string;
  phase: AgentRunPhase;
  coveredEventSeq: number;
  workItemRevision: number;
  decisionLedgerRevision: number;
  policyVersion: string;
  generation?: number;
  summaryMemory: SummaryMemory;
  sourceEventIds: string[];
  sourceArtifactIds: string[];
  sourceMemoryIds: string[];
  sourceDecisionIds: string[];
  checkpointId?: string;
};

export type SummaryCheckpointCommitOutcome =
  | { status: 'committed'; record: SummaryCheckpointRecord }
  | { status: 'duplicate'; record: SummaryCheckpointRecord }
  | { status: 'rejected'; code: SummaryCheckpointRejectionCode; latest?: SummaryCheckpointRecord };

export function summaryCheckpointLogicalKey(input: {
  workItemId: string;
  coveredEventSeq: number;
  workItemRevision: number;
  decisionLedgerRevision: number;
  policyVersion: string;
}) {
  return [
    input.workItemId,
    `seq:${input.coveredEventSeq}`,
    `wi:${input.workItemRevision}`,
    `dl:${input.decisionLedgerRevision}`,
    input.policyVersion
  ].join('|');
}

export function summaryCheckpointContentHash(summaryMemory: SummaryMemory) {
  return createHash('sha256').update(stableJson(summaryMemory)).digest('hex');
}

/**
 * Durable summary checkpoints with one commit per logical key.
 *
 * The commit runs inside the persistence transaction that reads the current
 * rows, so two workers summarizing the same coverage cannot both win, and a
 * late result built from an older requirement/ledger version or a superseded
 * session generation is refused instead of overwriting newer facts.
 */
export class SummaryCheckpointStore {
  private pending = Promise.resolve();
  private cache: SummaryCheckpointsBySession = {};

  constructor(
    private readonly persistence: PersistenceService,
    private readonly now = () => new Date().toISOString()
  ) {}

  list(sessionId: string, workItemId?: string): SummaryCheckpointRecord[] {
    const rows = this.persistence.getCollection<SummaryCheckpointsBySession>(SUMMARY_CHECKPOINTS_COLLECTION, this.cache)[sessionId] ?? [];
    return workItemId ? rows.filter((item) => item.workItemId === workItemId) : rows;
  }

  latest(sessionId: string, workItemId: string): SummaryCheckpointRecord | undefined {
    return latestOf(this.list(sessionId, workItemId));
  }

  commit(draft: SummaryCheckpointDraft): Promise<SummaryCheckpointCommitOutcome> {
    const now = this.now();
    return this.mutate(draft.sessionId, (rows, state): SummaryCheckpointCommitOutcome => {
      const lifecycle = ((state[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[draft.sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
        return { status: 'rejected', code: 'SESSION_ADMISSION_CLOSED' };
      }
      if (lifecycle && draft.generation !== undefined && draft.generation !== lifecycle.generation) {
        return { status: 'rejected', code: 'SUMMARY_CHECKPOINT_STALE_GENERATION' };
      }
      const session = (state.sessions as SessionDetail[] | undefined)?.find((item) => item.id === draft.sessionId);
      const workItem = ((state.workItemsBySession as Record<string, WorkItem[]> | undefined)?.[draft.sessionId] ?? [])
        .find((item) => item.id === draft.workItemId);
      if (!session || !workItem || workItem.revision !== draft.workItemRevision ||
        (session.decisionLedgerRevision ?? 0) !== draft.decisionLedgerRevision) {
        return { status: 'rejected', code: 'SUMMARY_CHECKPOINT_STALE_VERSION' };
      }
      const logicalKey = summaryCheckpointLogicalKey(draft);
      const existing = rows.find((item) => item.logicalKey === logicalKey);
      if (existing) return { status: 'duplicate', record: structuredClone(existing) };

      const latest = latestOf(rows.filter((item) => item.workItemId === draft.workItemId));
      if (latest) {
        if (draft.workItemRevision < latest.workItemRevision || draft.decisionLedgerRevision < latest.decisionLedgerRevision) {
          return { status: 'rejected', code: 'SUMMARY_CHECKPOINT_STALE_VERSION', latest: structuredClone(latest) };
        }
        if (draft.coveredEventSeq < latest.coveredEventSeq) {
          return { status: 'rejected', code: 'SUMMARY_CHECKPOINT_COVERAGE_REGRESSED', latest: structuredClone(latest) };
        }
      }
      const record: SummaryCheckpointRecord = {
        checkpointId: draft.checkpointId ?? crypto.randomUUID(),
        sessionId: draft.sessionId,
        workItemId: draft.workItemId,
        logicalKey,
        coveredEventSeq: draft.coveredEventSeq,
        workItemRevision: draft.workItemRevision,
        decisionLedgerRevision: draft.decisionLedgerRevision,
        policyVersion: draft.policyVersion,
        contentHash: summaryCheckpointContentHash(draft.summaryMemory),
        ...(draft.generation !== undefined ? { generation: draft.generation } : {}),
        phase: draft.phase,
        summaryMemory: structuredClone(draft.summaryMemory),
        sourceEventIds: [...draft.sourceEventIds],
        sourceArtifactIds: [...draft.sourceArtifactIds],
        sourceMemoryIds: [...draft.sourceMemoryIds],
        sourceDecisionIds: [...draft.sourceDecisionIds],
        createdAt: now
      };
      rows.push(record);
      return { status: 'committed', record: structuredClone(record) };
    });
  }

  private mutate<T>(
    sessionId: string,
    mutation: (rows: SummaryCheckpointRecord[], state: PersistedState) => T
  ): Promise<T> {
    const run = async () => {
      let committed: SummaryCheckpointsBySession | undefined;
      const result = await this.persistence.mutateCollections(
        [SUMMARY_CHECKPOINTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION, 'sessions', 'workItemsBySession'],
        (draft: PersistedState) => {
          const all = (draft[SUMMARY_CHECKPOINTS_COLLECTION] ??= {}) as SummaryCheckpointsBySession;
          const outcome = mutation(all[sessionId] ??= [], draft);
          committed = structuredClone(all);
          return outcome;
        }
      );
      if (committed) this.cache = committed;
      return result;
    };
    // Serialize in-process; cross-process atomicity comes from the persistence transaction.
    const result = this.pending.then(run, run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Highest coverage wins; ties resolve to the newest version fingerprint. */
function latestOf(rows: SummaryCheckpointRecord[]) {
  return [...rows].sort((left, right) =>
    right.coveredEventSeq - left.coveredEventSeq ||
    right.workItemRevision - left.workItemRevision ||
    right.decisionLedgerRevision - left.decisionLedgerRevision ||
    right.createdAt.localeCompare(left.createdAt)
  )[0];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
