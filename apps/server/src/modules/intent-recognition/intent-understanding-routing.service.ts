import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { validateRuntimeOutput, type AgentTask, type CollaborationEvent,
  type IntentContextSnapshot, type IntentRoutingRecord, type SessionDetail, type WorkItem } from '@agent-cluster/shared';
import { ContextManagementService, routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { operationPolicy } from '../runtimes/logical-operation-store.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession',
  'contextSnapshotsBySession', 'eventsBySession', 'workItemsBySession', 'tasksBySession'];
const terminal = ['ROUTED', 'REJECTED', 'BLOCKED', 'CLARIFICATION_REQUIRED'];
type Identity = { sessionId: string; routingId: string; snapshotId: string; recognitionOperationId?: string };

/** Durable semantic proposals only. A compiler/commit transaction must authorize every later effect. */
@Injectable()
export class IntentUnderstandingRoutingService {
  constructor(private readonly persistence: PersistenceService, private readonly context: ContextManagementService,
    private readonly semantic: SemanticIntentRouterService) {}

  async classify(input: Identity, signal?: AbortSignal): Promise<IntentRoutingRecord> {
    signal?.throwIfAborted();
    const initial = await this.mutate(input, (draft, route, session, snapshot) => {
      if (!route.semanticProposal) {
        if (route.classificationAttempts || route.decision || route.leaseOwner ||
          !['RECEIVED', 'SNAPSHOT_READY'].includes(route.status)) throw new ConflictException('INTENT_CONTRACT_MIGRATION_REQUIRED');
        const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
        route.semanticProposal = { contractVersion: 'intent-understanding-v1', dataEpoch: session.dataEpoch!,
          sessionGeneration: lifecycle?.generation, snapshotId: snapshot.id };
        touch(route);
      }
      if (route.semanticProposal.snapshotId !== snapshot.id) {
        if (route.status !== 'SNAPSHOT_READY' || route.snapshotId !== snapshot.id || route.snapshotRebuildCount !== 1) {
          throw new ConflictException('INTENT_SNAPSHOT_REBUILD_REQUIRED');
        }
        route.semanticProposal.snapshotId = snapshot.id;
        delete route.semanticProposal.understanding;
        touch(route);
      }
      return structuredClone(route);
    });
    if (terminal.includes(initial.status) || initial.semanticProposal?.understanding ||
      Date.parse(initial.semanticProposal?.retryAt ?? '') > Date.now()) return initial;
    input = { ...input, recognitionOperationId: initial.recognitionOperationId ?? initial.id };
    const owner = `understanding:${randomUUID()}`;
    const claim = await this.context.claimIntentRouting(input.sessionId, input.routingId, input.snapshotId, owner,
      operationPolicy('user_message_routing').timeoutMs + 30_000, 'intent-understanding-v1', input.recognitionOperationId);
    if (claim.state !== 'claimed') return claim.routing;

    for (;;) {
      signal?.throwIfAborted();
      const invocationId = randomUUID();
      const reserved = await this.mutate(input, (draft, route, session, snapshot) => {
        assertOwner(route, owner);
        const policy = operationPolicy('user_message_routing');
        route.classificationDeadlineAt ??= new Date(Date.now() + policy.timeoutMs).toISOString();
        if ((route.classificationAttempts ?? 0) >= policy.maxAttempts || Date.parse(route.classificationDeadlineAt) <= Date.now()) {
          block(route, 'INTENT_BUDGET_EXHAUSTED', 'budget');
          return { route: structuredClone(route) };
        }
        if (!snapshotCurrent(draft, session, snapshot)) {
          stale(route);
          return { route: structuredClone(route) };
        }
        route.status = 'CLASSIFYING';
        route.invocationId = invocationId;
        const attempt = route.classificationAttempts = (route.classificationAttempts ?? 0) + 1;
        route.attemptLog = [...(route.attemptLog ?? []), { invocationId, attempt,
          reason: route.semanticProposal!.repairFeedback ? 'schema_repair' : attempt === 1 ? 'classification' : 'transient_retry',
          startedAt: new Date().toISOString() }];
        delete route.semanticProposal!.retryAt;
        touch(route);
        return { route: structuredClone(route), session: structuredClone(session), snapshot: structuredClone(snapshot) };
      });
      if (!reserved.session || !reserved.snapshot) return reserved.route;
      const result = await this.semantic.understand({ session: reserved.session, snapshot: reserved.snapshot,
        routingId: input.routingId, routingRevision: reserved.route.inputBudgetDecision?.routingRevision ?? reserved.route.routingRevision,
        briefRevision: reserved.route.briefRevision,
        operationId: input.recognitionOperationId!, operationDeadlineAt: reserved.route.classificationDeadlineAt,
        invocationId, repairFeedback: reserved.route.semanticProposal?.repairFeedback, signal });
      signal?.throwIfAborted();
      const saved = await this.mutate(input, (draft, route, session, snapshot) => {
        assertOwner(route, owner);
        if (route.invocationId !== invocationId) throw new ConflictException('INTENT_INVOCATION_SUPERSEDED');
        if (result.status === 'failed' && result.code === 'INTENT_INPUT_BUDGET_EXCEEDED') {
          route.inputBudgetDecision = result.inputBudgetDecision;
          block(route, result.code, 'budget');
        } else if (Date.parse(route.classificationDeadlineAt!) <= Date.now()) {
          block(route, 'INTENT_BUDGET_EXHAUSTED', 'budget');
        } else if (!snapshotCurrent(draft, session, snapshot)) {
          stale(route);
        } else if (result.status === 'valid') {
          // Runtime output is validated again at this persistence boundary.
          const parsed = validateRuntimeOutput('intent_understanding', result.understanding);
          if (!parsed.valid) throw new ConflictException('INTENT_UNDERSTANDING_SCHEMA_INVALID');
          route.semanticProposal!.understanding = structuredClone(parsed.value);
          delete route.semanticProposal!.repairFeedback;
          route.status = 'VALIDATING';
          route.reasonCodes = ['INTENT_UNDERSTANDING_READY'];
          release(route);
        } else if (result.status === 'invalid') {
          const repaired = route.attemptLog?.some(item => item.reason === 'schema_repair');
          if (repaired || route.classificationAttempts! >= 2) block(route, 'INTENT_OUTPUT_INVALID', 'schema');
          else {
            route.semanticProposal!.repairFeedback = { previousOutput: result.previousOutput.slice(0, 8000),
              validationErrors: result.validationErrors.slice(0, 20).map(error => error.slice(0, 500)) };
            route.status = 'PENDING_RETRY';
            route.reasonCodes = ['INTENT_OUTPUT_INVALID'];
          }
        } else {
          const remaining = Date.parse(route.classificationDeadlineAt!) - Date.now();
          const delay = Number.isFinite(result.retryAfterMs) ? Math.max(0, result.retryAfterMs) : remaining;
          if (!result.retryable || result.failureClass !== 'transient' || route.classificationAttempts! >= 2 || delay >= remaining) {
            block(route, result.code, result.failureClass);
          } else {
            route.status = 'PENDING_RETRY';
            route.reasonCodes = [result.code];
            if (delay > 0) {
              route.semanticProposal!.retryAt = new Date(Date.now() + delay).toISOString();
              release(route);
            }
          }
        }
        touch(route);
        return structuredClone(route);
      });
      if (saved.status !== 'PENDING_RETRY' || saved.leaseOwner !== owner) return saved;
    }
  }

  private mutate<T>(input: Identity, mutate: (draft: PersistedState, route: IntentRoutingRecord,
    session: SessionDetail, snapshot: IntentContextSnapshot) => T) {
    return this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === input.sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[input.sessionId];
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', input.sessionId).find(row => row.id === input.routingId);
      const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', input.sessionId).find(row => row.id === input.snapshotId);
      if (!session || session.archivedAt || session.status === 'CANCELLED' || !session.dataEpoch ||
        (lifecycle && (lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch))) {
        throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      }
      if (!route || route.sessionId !== session.id || !snapshot || snapshot.sessionId !== session.id ||
        snapshot.sourceEventId !== route.sourceEventId) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      if (input.recognitionOperationId && input.recognitionOperationId !== (route.recognitionOperationId ?? route.id)) {
        throw new ConflictException('INTENT_RECOGNITION_SUPERSEDED');
      }
      const event = rows<CollaborationEvent>(draft, 'eventsBySession', input.sessionId)
        .find(row => row.id === route.sourceEventId && row.sessionId === session.id && row.type === 'user_message');
      if (!event || event.content !== snapshot.currentMessage) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      if (route.dispatchHold) throw new ConflictException('INTENT_DISPATCH_HELD');
      const proposal = route.semanticProposal;
      if (proposal && (proposal.contractVersion !== 'intent-understanding-v1' || proposal.dataEpoch !== session.dataEpoch ||
        proposal.sessionGeneration !== lifecycle?.generation)) throw new ConflictException('INTENT_GENERATION_STALE');
      return mutate(draft, route, session, snapshot);
    }, { sessionIds: [input.sessionId] });
  }
}

function rows<T>(draft: PersistedState, key: string, sessionId: string): T[] {
  return (draft[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
}
function snapshotCurrent(draft: PersistedState, session: SessionDetail, snapshot: IntentContextSnapshot) {
  return Boolean(snapshot.businessFingerprint) && snapshot.businessFingerprint === routingBusinessFingerprint(session,
    rows<WorkItem>(draft, 'workItemsBySession', session.id), rows<CollaborationEvent>(draft, 'eventsBySession', session.id),
    rows<AgentTask>(draft, 'tasksBySession', session.id));
}
function assertOwner(route: IntentRoutingRecord, owner: string) {
  if (route.leaseOwner !== owner || !(Date.parse(route.leaseExpiresAt ?? '') > Date.now()) ||
    !['CLASSIFYING', 'PENDING_RETRY'].includes(route.status)) throw new ConflictException('ROUTING_LEASE_LOST');
}
function touch(route: IntentRoutingRecord) { route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = new Date().toISOString(); }
function release(route: IntentRoutingRecord) { delete route.leaseOwner; delete route.leaseExpiresAt; }
function stale(route: IntentRoutingRecord) { route.status = 'PENDING_RETRY'; route.reasonCodes = ['SNAPSHOT_STALE']; release(route); touch(route); }
function block(route: IntentRoutingRecord, code: string, failureClass: IntentRoutingRecord['failureClass']) {
  route.status = 'BLOCKED'; route.blockedReason = code; route.failureClass = failureClass; route.reasonCodes = [code]; release(route); touch(route);
}
