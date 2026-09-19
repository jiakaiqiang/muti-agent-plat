import { Injectable } from '@nestjs/common';
import {
  CHANGE_REQUEST_CONTRACT_VERSION,
  canTransitionChangeRequest,
  changeRequestLogicalKey,
  isChangeAnalysisCurrent,
  type ChangeRequestBase,
  type ChangeRequestChoice,
  type ChangeRequestStatus
} from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SESSION_LIFECYCLES_COLLECTION, type SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { nowIso } from '../../common/time.js';

export const CHANGE_REQUESTS_COLLECTION = 'changeRequestsBySession';
export type ChangeRequestsBySession = Record<string, ChangeRequestRecord[]>;

export type ChangeRequestAnalysis = {
  base: ChangeRequestBase;
  analysisRevision: number;
  affectedTaskIds: string[];
  affectedFilePaths: string[];
  affectedDocumentRevision: number;
  /** The coordinator's user-facing explanation. Never a model transcript. */
  explanation: string;
  options: ChangeRequestChoice[];
  recordedAt: string;
};

export type ChangeRequestRecord = {
  id: string;
  sessionId: string;
  contractVersion: typeof CHANGE_REQUEST_CONTRACT_VERSION;
  /** Source message + the versions it was raised against; one message, one request. */
  logicalKey: string;
  sourceEventId: string;
  base: ChangeRequestBase;
  summary: string;
  generation?: number;
  status: ChangeRequestStatus;
  analysis?: ChangeRequestAnalysis;
  choice?: ChangeRequestChoice;
  choiceConfirmationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenChangeRequestInput = {
  base: ChangeRequestBase;
  sourceEventId: string;
  summary: string;
  generation?: number;
};

export type RecordAnalysisInput = {
  affectedTaskIds: string[];
  affectedFilePaths: string[];
  affectedDocumentRevision: number;
  explanation: string;
  options: ChangeRequestChoice[];
  /** Live versions at the moment the analysis finished; defaults to the request's own base. */
  current?: ChangeRequestBase;
};

export type OpenChangeRequestOutcome =
  | { status: 'opened'; request: ChangeRequestRecord }
  | { status: 'duplicate'; request: ChangeRequestRecord }
  | { status: 'rejected'; code: string };

export type ChangeRequestMutationOutcome =
  | { status: 'applied'; request: ChangeRequestRecord }
  | { status: 'idempotent'; request: ChangeRequestRecord }
  | { status: 'rejected'; code: string };

/** Statuses a request can still move out of; everything else is resolved. */
const OPEN_STATUSES: readonly ChangeRequestStatus[] = [
  'received',
  'analyzing',
  'waiting_user',
  'stopping',
  'revising',
  'waiting_confirmation'
];

/**
 * The durable record of an execution-time scope change: what the user asked
 * for, which versions it was raised against, what the coordinator found, and
 * which option the user picked. It is the single queue truth — the session's
 * `pendingFollowUpMessages` projection stays a view, never a second ledger.
 *
 * Every mutation is a persisted transaction so two clients (or two instances)
 * racing the same message produce one request, and a restart finds the open
 * work without replaying a model.
 */
@Injectable()
export class ChangeRequestStore {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly clock: () => string = nowIso
  ) {}

  list(sessionId: string): ChangeRequestRecord[] {
    const all = this.persistence.getCollection<ChangeRequestsBySession>(CHANGE_REQUESTS_COLLECTION, {});
    return structuredClone(all[sessionId] ?? []);
  }

  get(sessionId: string, requestId: string): ChangeRequestRecord | undefined {
    return this.list(sessionId).find((item) => item.id === requestId);
  }

  /** Requests still awaiting an outcome, for restart recovery and for the UI queue. */
  unresolved(sessionId: string): ChangeRequestRecord[] {
    return this.list(sessionId).filter((item) => OPEN_STATUSES.includes(item.status));
  }

  /** Changes the user parked for after the current run ends. */
  deferred(sessionId: string): ChangeRequestRecord[] {
    return this.list(sessionId).filter((item) => item.status === 'deferred');
  }

  async open(input: OpenChangeRequestInput): Promise<OpenChangeRequestOutcome> {
    const logicalKey = changeRequestLogicalKey({ base: input.base, sourceEventId: input.sourceEventId });
    const now = this.clock();
    return this.persistence.mutateCollections(
      [CHANGE_REQUESTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION],
      (draft): OpenChangeRequestOutcome => {
        const all = (draft[CHANGE_REQUESTS_COLLECTION] ??= {}) as ChangeRequestsBySession;
        const sessionRequests = (all[input.base.sessionId] ??= []);
        const existing = sessionRequests.find((item) => item.logicalKey === logicalKey);
        if (existing) return { status: 'duplicate', request: structuredClone(existing) };

        const refusal = this.admissionRefusal(draft, input.base.sessionId, input.generation);
        if (refusal) return { status: 'rejected', code: refusal };

        const request: ChangeRequestRecord = {
          id: `change-request:${logicalKey}`,
          sessionId: input.base.sessionId,
          contractVersion: CHANGE_REQUEST_CONTRACT_VERSION,
          logicalKey,
          sourceEventId: input.sourceEventId,
          base: structuredClone(input.base),
          summary: input.summary,
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          status: 'received',
          createdAt: now,
          updatedAt: now
        };
        sessionRequests.push(request);
        draft[CHANGE_REQUESTS_COLLECTION] = all;
        return { status: 'opened', request: structuredClone(request) };
      }
    );
  }

  /**
   * Records what the change would touch. Refused when the versions moved while
   * the analysis was being produced: showing the user an impact report for a
   * requirement that no longer exists is how a stale approval gets in.
   */
  async recordAnalysis(requestId: string, input: RecordAnalysisInput): Promise<ChangeRequestMutationOutcome> {
    const now = this.clock();
    return this.persistence.mutateCollections(
      [CHANGE_REQUESTS_COLLECTION],
      (draft): ChangeRequestMutationOutcome => {
        const all = (draft[CHANGE_REQUESTS_COLLECTION] ??= {}) as ChangeRequestsBySession;
        const request = Object.values(all).flat().find((item) => item.id === requestId);
        if (!request) return { status: 'rejected', code: 'CHANGE_REQUEST_NOT_FOUND' };

        const current = input.current ?? request.base;
        const previous = request.analysis;
        if (!isChangeAnalysisCurrent({ base: request.base, analysisRevision: previous?.analysisRevision ?? 0 }, current)) {
          return { status: 'rejected', code: 'CHANGE_ANALYSIS_STALE' };
        }
        // received -> analyzing -> waiting_user is the normal path; a deferred
        // request re-enters through analyzing, which the contract allows.
        if (!canTransitionChangeRequest(request.status, 'analyzing')) {
          return { status: 'rejected', code: 'CHANGE_REQUEST_NOT_ANALYSABLE' };
        }

        request.analysis = {
          base: structuredClone(request.base),
          analysisRevision: (previous?.analysisRevision ?? 0) + 1,
          affectedTaskIds: [...input.affectedTaskIds],
          affectedFilePaths: [...input.affectedFilePaths],
          affectedDocumentRevision: input.affectedDocumentRevision,
          explanation: input.explanation,
          options: [...input.options],
          recordedAt: now
        };
        // A re-analysis of a decided request starts a new decision.
        request.choice = undefined;
        request.choiceConfirmationId = undefined;
        request.status = 'waiting_user';
        request.updatedAt = now;
        draft[CHANGE_REQUESTS_COLLECTION] = all;
        return { status: 'applied', request: structuredClone(request) };
      }
    );
  }

  /**
   * Records the user's decision. Only an option the analysis actually offered
   * is accepted, and the first decision stays authoritative so a replayed click
   * cannot turn a "pause and revise" into a "reject".
   */
  async recordChoice(
    requestId: string,
    input: { choice: ChangeRequestChoice; confirmationId: string }
  ): Promise<ChangeRequestMutationOutcome> {
    const now = this.clock();
    return this.persistence.mutateCollections(
      [CHANGE_REQUESTS_COLLECTION],
      (draft): ChangeRequestMutationOutcome => {
        const all = (draft[CHANGE_REQUESTS_COLLECTION] ??= {}) as ChangeRequestsBySession;
        const request = Object.values(all).flat().find((item) => item.id === requestId);
        if (!request) return { status: 'rejected', code: 'CHANGE_REQUEST_NOT_FOUND' };
        if (request.choice) {
          return request.choice === input.choice
            ? { status: 'idempotent', request: structuredClone(request) }
            : { status: 'rejected', code: 'CHANGE_CHOICE_ALREADY_RECORDED' };
        }
        if (!request.analysis) return { status: 'rejected', code: 'CHANGE_ANALYSIS_MISSING' };
        if (!request.analysis.options.includes(input.choice)) {
          return { status: 'rejected', code: 'CHANGE_CHOICE_NOT_OFFERED' };
        }

        const next = CHOICE_STATUS[input.choice];
        if (!canTransitionChangeRequest(request.status, next)) {
          return { status: 'rejected', code: 'CHANGE_REQUEST_NOT_DECIDABLE' };
        }
        request.choice = input.choice;
        request.choiceConfirmationId = input.confirmationId;
        request.status = next;
        request.updatedAt = now;
        draft[CHANGE_REQUESTS_COLLECTION] = all;
        return { status: 'applied', request: structuredClone(request) };
      }
    );
  }

  /** Moves a decided request along its remaining lifecycle (stopping → revising → …). */
  async transition(requestId: string, status: ChangeRequestStatus): Promise<ChangeRequestMutationOutcome> {
    const now = this.clock();
    return this.persistence.mutateCollections(
      [CHANGE_REQUESTS_COLLECTION],
      (draft): ChangeRequestMutationOutcome => {
        const all = (draft[CHANGE_REQUESTS_COLLECTION] ??= {}) as ChangeRequestsBySession;
        const request = Object.values(all).flat().find((item) => item.id === requestId);
        if (!request) return { status: 'rejected', code: 'CHANGE_REQUEST_NOT_FOUND' };
        if (request.status === status) return { status: 'idempotent', request: structuredClone(request) };
        if (!canTransitionChangeRequest(request.status, status)) {
          return { status: 'rejected', code: 'CHANGE_REQUEST_TRANSITION_REJECTED' };
        }
        request.status = status;
        request.updatedAt = now;
        draft[CHANGE_REQUESTS_COLLECTION] = all;
        return { status: 'applied', request: structuredClone(request) };
      }
    );
  }

  private admissionRefusal(
    draft: Record<string, unknown>,
    sessionId: string,
    generation?: number
  ): string | undefined {
    const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
    if (!lifecycle) return undefined;
    if (lifecycle.admission === 'closed') return 'SESSION_ADMISSION_CLOSED';
    if (generation !== undefined && lifecycle.generation !== generation) return 'CHANGE_REQUEST_STALE_GENERATION';
    return undefined;
  }
}

/** Where each user decision puts the request. */
const CHOICE_STATUS: Readonly<Record<ChangeRequestChoice, ChangeRequestStatus>> = {
  pause_and_revise: 'stopping',
  defer: 'deferred',
  reject: 'rejected'
};
