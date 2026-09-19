import { createHash } from 'node:crypto';
import {
  canTransitionRequirementDocument,
  canonicalRequirementDocumentContent,
  isRequirementDocumentSections,
  requirementDocumentLogicalKey,
  supersedeOlderDocuments,
  type RequirementDocument,
  type RequirementDocumentSections,
  type WorkItem
} from '@agent-cluster/shared';
import type { PersistedState, PersistenceService } from '../persistence/persistence.service.js';
import {
  SESSION_LIFECYCLES_COLLECTION,
  type SessionLifecyclesBySession
} from '../runtimes/session-lifecycle-store.js';

export const REQUIREMENT_DOCUMENTS_COLLECTION = 'requirementDocumentsBySession';
export type RequirementDocumentsBySession = Record<string, RequirementDocument[]>;

export type RequirementDocumentRejectionCode =
  | 'SESSION_ADMISSION_CLOSED'
  | 'DOCUMENT_STALE_REQUIREMENT'
  | 'DOCUMENT_SECTIONS_INVALID'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_INVALID_TRANSITION';

type Rejected = { status: 'rejected'; code: RequirementDocumentRejectionCode };

export type PublishRequirementDocumentInput = {
  sessionId: string;
  workItemId: string;
  workItemRevision: number;
  publishedByAgentId: string;
  sourceBriefId?: string;
  sourceDecisionIds: string[];
  sourceDelegationIds: string[];
  sections: RequirementDocumentSections;
  documentId?: string;
};

export type PublishRequirementDocumentOutcome =
  | { status: 'published'; document: RequirementDocument }
  | { status: 'duplicate'; document: RequirementDocument }
  | Rejected;

export type ConfirmRequirementDocumentOutcome =
  | { status: 'applied'; document: RequirementDocument }
  | { status: 'idempotent'; document: RequirementDocument }
  | Rejected;

export function requirementDocumentContentHash(sections: RequirementDocumentSections): string {
  return createHash('sha256').update(canonicalRequirementDocumentContent(sections)).digest('hex');
}

/**
 * Immutable, versioned requirement documents — the thing the user reads and
 * confirms. Content never changes after publication; a change is the next
 * revision, and older revisions become history rather than disappearing.
 *
 * Same discipline as the checkpoint and discussion stores: writes run inside
 * the persistence transaction that reads the current rows, a (requirement,
 * revision, content) publishes once, and refusals leave no row behind.
 */
export class RequirementDocumentStore {
  private pending = Promise.resolve();
  private cache: RequirementDocumentsBySession = {};

  constructor(
    private readonly persistence: PersistenceService,
    private readonly now = () => new Date().toISOString()
  ) {}

  list(sessionId: string, workItemId?: string): RequirementDocument[] {
    const rows = this.persistence.getCollection<RequirementDocumentsBySession>(REQUIREMENT_DOCUMENTS_COLLECTION, this.cache)[sessionId] ?? [];
    return (workItemId ? rows.filter((item) => item.workItemId === workItemId) : rows).map((item) => structuredClone(item));
  }

  get(sessionId: string, documentId: string): RequirementDocument | undefined {
    return this.list(sessionId).find((item) => item.id === documentId);
  }

  /** The newest revision for a requirement, whatever its status. */
  latest(sessionId: string, workItemId: string): RequirementDocument | undefined {
    return [...this.list(sessionId, workItemId)].sort((left, right) => right.documentRevision - left.documentRevision)[0];
  }

  publish(input: PublishRequirementDocumentInput): Promise<PublishRequirementDocumentOutcome> {
    // Validate before touching state so an invalid draft never enters the
    // transaction, let alone the hash.
    if (!isRequirementDocumentSections(input.sections)) {
      return Promise.resolve({ status: 'rejected', code: 'DOCUMENT_SECTIONS_INVALID' });
    }
    const now = this.now();
    const contentHash = requirementDocumentContentHash(input.sections);
    return this.mutate(input.sessionId, (rows, state): PublishRequirementDocumentOutcome => {
      const admission = this.checkAdmission(state, input.sessionId);
      if (admission) return admission;
      const workItem = ((state.workItemsBySession as Record<string, WorkItem[]> | undefined)?.[input.sessionId] ?? [])
        .find((item) => item.id === input.workItemId);
      if (!workItem || workItem.revision !== input.workItemRevision) {
        return { status: 'rejected', code: 'DOCUMENT_STALE_REQUIREMENT' };
      }

      const forItem = rows.filter((item) => item.workItemId === input.workItemId);
      const latest = [...forItem].sort((left, right) => right.documentRevision - left.documentRevision)[0];
      // Identical content on the same requirement revision is the same
      // document, however many times it is published.
      if (latest && latest.workItemRevision === input.workItemRevision && latest.contentHash === contentHash) {
        return { status: 'duplicate', document: structuredClone(latest) };
      }

      const document: RequirementDocument = {
        id: input.documentId ?? crypto.randomUUID(),
        sessionId: input.sessionId,
        workItemId: input.workItemId,
        workItemRevision: input.workItemRevision,
        documentRevision: (latest?.documentRevision ?? 0) + 1,
        contentHash,
        status: 'formal',
        publishedByAgentId: input.publishedByAgentId,
        ...(input.sourceBriefId ? { sourceBriefId: input.sourceBriefId } : {}),
        sourceDecisionIds: [...input.sourceDecisionIds],
        sourceDelegationIds: [...input.sourceDelegationIds],
        sections: structuredClone(input.sections),
        createdAt: now
      };
      const logicalKey = requirementDocumentLogicalKey(document);
      if (rows.some((item) => requirementDocumentLogicalKey(item) === logicalKey)) {
        // Two publishers raced to the same revision number; the first row wins.
        const winner = rows.find((item) => requirementDocumentLogicalKey(item) === logicalKey)!;
        return { status: 'duplicate', document: structuredClone(winner) };
      }

      const superseded = supersedeOlderDocuments(rows, { latestDocumentRevision: document.documentRevision, now });
      rows.splice(0, rows.length, ...superseded, document);
      return { status: 'published', document: structuredClone(document) };
    });
  }

  confirm(documentId: string, input: { confirmationId: string }): Promise<ConfirmRequirementDocumentOutcome> {
    const now = this.now();
    const sessionId = this.sessionIdOf(documentId);
    if (!sessionId) return Promise.resolve({ status: 'rejected', code: 'DOCUMENT_NOT_FOUND' });
    return this.mutate(sessionId, (rows, state): ConfirmRequirementDocumentOutcome => {
      const admission = this.checkAdmission(state, sessionId);
      if (admission) return admission;
      const document = rows.find((item) => item.id === documentId);
      if (!document) return { status: 'rejected', code: 'DOCUMENT_NOT_FOUND' };
      if (document.status === 'confirmed') return { status: 'idempotent', document: structuredClone(document) };
      if (!canTransitionRequirementDocument(document.status, 'confirmed')) {
        return { status: 'rejected', code: 'DOCUMENT_INVALID_TRANSITION' };
      }
      document.status = 'confirmed';
      document.confirmedAt = now;
      document.confirmationId = input.confirmationId;
      return { status: 'applied', document: structuredClone(document) };
    });
  }

  private checkAdmission(state: PersistedState, sessionId: string): Rejected | undefined {
    const lifecycle = ((state[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
    if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
      return { status: 'rejected', code: 'SESSION_ADMISSION_CLOSED' };
    }
    return undefined;
  }

  private sessionIdOf(documentId: string): string | undefined {
    const all = this.persistence.getCollection<RequirementDocumentsBySession>(REQUIREMENT_DOCUMENTS_COLLECTION, this.cache);
    for (const [sessionId, rows] of Object.entries(all)) {
      if (rows.some((item) => item.id === documentId)) return sessionId;
    }
    return undefined;
  }

  private mutate<T>(sessionId: string, mutation: (rows: RequirementDocument[], state: PersistedState) => T): Promise<T> {
    const run = async () => {
      let committed: RequirementDocumentsBySession | undefined;
      const result = await this.persistence.mutateCollections(
        [REQUIREMENT_DOCUMENTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION, 'sessions', 'workItemsBySession'],
        (draft: PersistedState) => {
          const all = (draft[REQUIREMENT_DOCUMENTS_COLLECTION] ??= {}) as RequirementDocumentsBySession;
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
