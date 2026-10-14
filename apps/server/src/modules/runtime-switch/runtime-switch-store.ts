import { Injectable } from '@nestjs/common';
import {
  RUNTIME_SWITCH_CONTRACT_VERSION,
  canTransitionRuntimeSwitch,
  applyRuntimeSwitchToPreference,
  effectiveRuntimePreference,
  isTerminalRuntimeSwitchStatus,
  runtimeSwitchLogicalKey,
  type RuntimeSwitchFallbackMode,
  type RuntimeSwitchRequest,
  type RuntimeSwitchStatus,
  type RuntimeType
} from '@agent-cluster/shared';
import type { CollaborationEvent, RuntimeHandoffCheckpoint, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SESSION_LIFECYCLES_COLLECTION, type SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { nowIso } from '../../common/time.js';

export const RUNTIME_SWITCH_REQUESTS_COLLECTION = 'runtimeSwitchRequestsBySession';
export type RuntimeSwitchRequestsBySession = Record<string, RuntimeSwitchRequestRecord[]>;

export type RuntimeSwitchRequestRecord = RuntimeSwitchRequest & {
  contractVersion: typeof RUNTIME_SWITCH_CONTRACT_VERSION;
  /** Session + client Idempotency-Key; one key is one request. */
  logicalKey: string;
  /** The lifecycle generation the request was raised in, for fencing. */
  generation?: number;
  scope?: RuntimeSwitchRequest['scope'];
  timing?: RuntimeSwitchRequest['timing'];
  workItemId?: string;
};

export type OpenRuntimeSwitchInput = {
  sessionId: string;
  source: RuntimeSwitchRequest['source'];
  fromRuntimeType?: RuntimeType;
  targetRuntimeType: RuntimeType;
  resumeAfterSwitch: boolean;
  fallbackMode: RuntimeSwitchFallbackMode;
  idempotencyKey: string;
  expectedSessionRevision?: number;
  previousSessionStatus?: string;
  generation?: number;
  scope?: RuntimeSwitchRequest['scope'];
  timing?: RuntimeSwitchRequest['timing'];
  workItemId?: string;
  requestedBriefId?: string;
};

export type TransitionRuntimeSwitchInput = {
  generation?: number;
  stopRequestId?: string;
  stoppedInvocationIds?: string[];
  lifecycleGeneration?: number;
  /** Stable code plus a safe summary only; never a raw provider response. */
  error?: { code: string; message: string; retryable: boolean };
};

export type OpenRuntimeSwitchOutcome =
  | { status: 'opened'; request: RuntimeSwitchRequestRecord }
  | { status: 'duplicate'; request: RuntimeSwitchRequestRecord }
  | { status: 'rejected'; code: string };

export type RuntimeSwitchMutationOutcome =
  | { status: 'applied'; request: RuntimeSwitchRequestRecord }
  | { status: 'idempotent'; request: RuntimeSwitchRequestRecord }
  | { status: 'rejected'; code: string };

/**
 * The durable record of "the user asked to change Runtime".
 *
 * Nothing about a switch may live only in an in-flight promise or in client
 * state: a restart has to be able to tell whether the previous Runtime was
 * actually stopped, and a replayed POST must not produce a second stop barrier
 * or a second target invocation. Every mutation is therefore a persisted
 * transaction that also re-checks the Session lifecycle, so a deleted or
 * restored Session cannot be written by a callback from the run it replaced.
 */
@Injectable()
export class RuntimeSwitchStore {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly clock: () => string = nowIso
  ) {}

  list(sessionId: string): RuntimeSwitchRequestRecord[] {
    const all = this.persistence.getCollection<RuntimeSwitchRequestsBySession>(
      RUNTIME_SWITCH_REQUESTS_COLLECTION,
      {}
    );
    return structuredClone(all[sessionId] ?? []);
  }

  get(sessionId: string, requestId: string): RuntimeSwitchRequestRecord | undefined {
    return this.list(sessionId).find((item) => item.id === requestId);
  }

  /** Requests that have not reached a terminal state, for restart recovery. */
  unresolved(sessionId: string): RuntimeSwitchRequestRecord[] {
    return this.list(sessionId).filter((item) => !isTerminalRuntimeSwitchStatus(item.status));
  }

  /** The request a client should be shown: the live one, else the most recent. */
  current(sessionId: string): RuntimeSwitchRequestRecord | undefined {
    const all = this.list(sessionId);
    return all.find((item) => !isTerminalRuntimeSwitchStatus(item.status)) ?? all.at(-1);
  }

  async claimAttempt(sessionId: string, workItemId: string | undefined, attemptGroupId: string) {
    if (!this.list(sessionId).some(request => request.handoff && request.workItemId === workItemId)) return undefined;
    return this.persistence.mutateCollections([RUNTIME_SWITCH_REQUESTS_COLLECTION], draft => {
      const request = ((draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] ?? {}) as RuntimeSwitchRequestsBySession)[sessionId]?.at(-1);
      if (!request?.handoff || request.workItemId !== workItemId || !['applying', 'resuming', 'completed'].includes(request.status)) return undefined;
      if (!request.firstAttemptGroupId) request.firstAttemptGroupId = attemptGroupId;
      return structuredClone(request);
    });
  }

  async open(input: OpenRuntimeSwitchInput): Promise<OpenRuntimeSwitchOutcome> {
    const logicalKey = runtimeSwitchLogicalKey({
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey
    });
    const now = this.clock();
    return this.persistence.mutateCollections(
      [RUNTIME_SWITCH_REQUESTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION, 'sessions'],
      (draft): OpenRuntimeSwitchOutcome => {
        const all = (draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] ??= {}) as RuntimeSwitchRequestsBySession;
        const sessionRequests = (all[input.sessionId] ??= []);

        const existing = sessionRequests.find((item) => item.logicalKey === logicalKey);
        if (existing) {
          // The same key must mean the same intent. A changed target under a
          // reused key is a client bug, and honouring it would switch to a
          // Runtime the user never confirmed.
          if (
            existing.targetRuntimeType !== input.targetRuntimeType ||
            existing.fallbackMode !== input.fallbackMode ||
            existing.resumeAfterSwitch !== input.resumeAfterSwitch ||
            existing.scope !== input.scope || existing.timing !== input.timing
          ) {
            return { status: 'rejected', code: 'RUNTIME_SWITCH_IDEMPOTENCY_CONFLICT' };
          }
          return { status: 'duplicate', request: structuredClone(existing) };
        }

        const refusal = this.admissionRefusal(draft, input.sessionId, input.generation);
        if (refusal) return { status: 'rejected', code: refusal };
        const session = (draft.sessions as SessionDetail[] | undefined)?.find(item => item.id === input.sessionId);
        if (session && input.expectedSessionRevision !== undefined && (session.revision ?? 0) !== input.expectedSessionRevision) {
          return { status: 'rejected', code: 'RUNTIME_SWITCH_STALE_REVISION' };
        }

        // Two concurrent switches would race the same stop barrier and the same
        // preference write, so the second one waits for an explicit outcome.
        if (sessionRequests.some((item) => !isTerminalRuntimeSwitchStatus(item.status))) {
          return { status: 'rejected', code: 'RUNTIME_SWITCH_ALREADY_IN_PROGRESS' };
        }

        const request: RuntimeSwitchRequestRecord = {
          id: `runtime-switch:${logicalKey}`,
          sessionId: input.sessionId,
          contractVersion: RUNTIME_SWITCH_CONTRACT_VERSION,
          logicalKey,
          source: input.source,
          scope: input.scope,
          timing: input.timing,
          workItemId: input.workItemId,
          requestedBriefId: input.requestedBriefId,
          ...(input.fromRuntimeType ? { fromRuntimeType: input.fromRuntimeType } : {}),
          targetRuntimeType: input.targetRuntimeType,
          resumeAfterSwitch: input.resumeAfterSwitch,
          fallbackMode: input.fallbackMode,
          status: 'requested',
          version: 1,
          ...(input.expectedSessionRevision !== undefined
            ? { expectedSessionRevision: input.expectedSessionRevision }
            : {}),
          ...(input.previousSessionStatus ? { previousSessionStatus: input.previousSessionStatus } : {}),
          stoppedInvocationIds: [],
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          updatedAt: now
        };
        sessionRequests.push(request);
        draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] = all;
        return { status: 'opened', request: structuredClone(request) };
      }
    );
  }

  /**
   * Advances one request along the documented path.
   *
   * Re-requesting the status the request already holds is idempotent and does
   * not burn a version, because a retried stop confirmation is the same fact.
   * Anything the transition table forbids is refused without touching the
   * record: a switch that cannot prove the previous Runtime stopped must stay
   * where it is rather than fall forward into the target taking ownership.
   */
  async transition(
    requestId: string,
    next: RuntimeSwitchStatus,
    input: TransitionRuntimeSwitchInput = {}
  ): Promise<RuntimeSwitchMutationOutcome> {
    const now = this.clock();
    return this.persistence.mutateCollections(
      [RUNTIME_SWITCH_REQUESTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION],
      (draft): RuntimeSwitchMutationOutcome => {
        const all = (draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] ??= {}) as RuntimeSwitchRequestsBySession;
        const request = Object.values(all).flat().find((item) => item.id === requestId);
        if (!request) return { status: 'rejected', code: 'RUNTIME_SWITCH_NOT_FOUND' };

        const refusal = this.mutationRefusal(draft, request.sessionId, input.generation);
        if (refusal) return { status: 'rejected', code: refusal };

        if (request.status === next) {
          this.applyBindings(request, input);
          request.updatedAt = now;
          draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] = all;
          return { status: 'idempotent', request: structuredClone(request) };
        }
        if (!canTransitionRuntimeSwitch(request.status, next)) {
          return { status: 'rejected', code: 'RUNTIME_SWITCH_ILLEGAL_TRANSITION' };
        }

        if (next === 'failed') {
          // The stage it failed in decides what may be retried; losing it would
          // force a retry to start over and re-preflight past the stop barrier.
          request.failureStage = request.status as RuntimeSwitchRequestRecord['failureStage'];
          if (input.error) request.error = { ...input.error };
        }
        request.status = next;
        request.version += 1;
        this.applyBindings(request, input);
        request.updatedAt = now;
        draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] = all;
        return { status: 'applied', request: structuredClone(request) };
      }
    );
  }

  /** Policy, ownership generation and its event commit together. Admission stays closed until resume. */
  async apply(requestId: string, expectedRevision: number, handoff: RuntimeHandoffCheckpoint,
    event: CollaborationEvent) {
    return this.persistence.mutateCollections(
      ['sessions', RUNTIME_SWITCH_REQUESTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION, 'sessionStopRequestsBySession', 'eventsBySession', 'eventOutbox'],
      draft => {
        const requests = draft[RUNTIME_SWITCH_REQUESTS_COLLECTION] as RuntimeSwitchRequestsBySession;
        const request = Object.values(requests).flat().find(item => item.id === requestId);
        if (!request) throw new Error('RUNTIME_SWITCH_NOT_FOUND');
        const session = (draft.sessions as SessionDetail[]).find(item => item.id === request.sessionId);
        if (!session) throw new Error('SESSION_NOT_FOUND');
        if (request.status !== 'stop_confirmed') throw new Error('RUNTIME_SWITCH_STOP_REQUIRED');
        if (session.status !== 'PAUSED' || session.archivedAt || session.currentTaskBriefId !== request.requestedBriefId ||
            (session.revision ?? 0) !== expectedRevision || session.activeWorkItemId !== request.workItemId) {
          throw new Error('RUNTIME_SWITCH_STALE_CONTEXT');
        }
        const lifecycle = (draft[SESSION_LIFECYCLES_COLLECTION] as SessionLifecyclesBySession)[session.id];
        if (!lifecycle || lifecycle.state !== 'active' || lifecycle.admission !== 'closed' ||
            (request.generation !== undefined && request.generation !== lifecycle.generation)) throw new Error('RUNTIME_SWITCH_STALE_GENERATION');
        const stops = (draft.sessionStopRequestsBySession as Record<string, Array<{ status: string }>> | undefined)?.[session.id] ?? [];
        if (stops.length && !['confirmed', 'idle'].includes(stops.at(-1)!.status)) throw new Error('RUNTIME_SWITCH_STOP_UNCONFIRMED');
        const previous = effectiveRuntimePreference(session);
        const preference = applyRuntimeSwitchToPreference({ preference: previous,
          targetRuntimeType: request.targetRuntimeType, fallbackMode: request.fallbackMode });
        request.previousPreference = previous;
        delete session.runtimeFailover;
        if (request.scope === 'session') {
          session.runtimePreference = preference;
          delete session.runtimeSwitchOverride;
        } else {
          session.runtimeSwitchOverride = { workItemId: request.workItemId, preference, switchRequestId: request.id };
        }
        session.revision = (session.revision ?? 0) + 1;
        session.updatedAt = this.clock();
        lifecycle.generation += 1;
        lifecycle.revision += 1;
        request.generation = lifecycle.generation;
        request.lifecycleGeneration = lifecycle.generation;
        request.handoff = handoff;
        request.status = 'applying';
        request.version += 1;
        request.updatedAt = this.clock();
        const events = ((draft.eventsBySession ??= {}) as Record<string, CollaborationEvent[]>)[session.id] ??= [];
        events.push(event);
        ((draft.eventOutbox ??= []) as Array<Record<string, unknown>>).push({
          id: `outbox:${event.id}`, idempotencyKey: `session:${session.id}:event:${event.id}`,
          aggregateType: 'session', aggregateId: session.id, eventType: event.type,
          payload: { event: structuredClone(event) }, status: 'pending', attempts: 0, createdAt: event.createdAt
        });
        return { session: structuredClone(session), request: structuredClone(request), event };
      },
      // The switch event belongs to the switched Session; the scope guard rejects any mismatch.
      { sessionIds: [event.sessionId] });
  }

  private applyBindings(request: RuntimeSwitchRequestRecord, input: TransitionRuntimeSwitchInput) {
    if (input.stopRequestId) request.stopRequestId = input.stopRequestId;
    if (input.lifecycleGeneration !== undefined) request.lifecycleGeneration = input.lifecycleGeneration;
    if (input.stoppedInvocationIds?.length) {
      request.stoppedInvocationIds = Array.from(
        new Set([...request.stoppedInvocationIds, ...input.stoppedInvocationIds])
      );
    }
  }

  private admissionRefusal(
    draft: Record<string, unknown>,
    sessionId: string,
    generation?: number
  ): string | undefined {
    const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
    if (!lifecycle) return undefined;
    if (lifecycle.state === 'deleting' || lifecycle.state === 'deleted') return 'SESSION_ADMISSION_CLOSED';
    // A user must be able to switch an already-paused Session. The coordinator
    // still requires a confirmed stop before applying any policy.
    if (generation !== undefined && lifecycle.generation !== generation) {
      return 'RUNTIME_SWITCH_STALE_GENERATION';
    }
    return undefined;
  }

  /**
   * A switch deliberately closes admission while it stops the old Runtime, so a
   * transition may not require admission to be open. Deletion and generation
   * fencing still apply: those are the cases where a late callback must not win.
   */
  private mutationRefusal(
    draft: Record<string, unknown>,
    sessionId: string,
    generation?: number
  ): string | undefined {
    const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
    if (!lifecycle) return undefined;
    if (lifecycle.state === 'deleting' || lifecycle.state === 'deleted') return 'SESSION_ADMISSION_CLOSED';
    if (generation !== undefined && lifecycle.generation !== generation) {
      return 'RUNTIME_SWITCH_STALE_GENERATION';
    }
    return undefined;
  }
}
