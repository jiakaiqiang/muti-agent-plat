import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Optional, type OnModuleDestroy, type OnApplicationBootstrap } from '@nestjs/common';
import { validateRuntimeOutput, type AgentTask, type ClarifyIntentRoutingInput, type CollaborationEvent,
  type IntentRoutingRecord, type SessionDetail, type WorkItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { ContextManagementService, routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { SemanticIntentRouterService } from '../intent-recognition/semantic-intent-router.service.js';
import { EventsService } from '../events/events.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { assertClarifyIntentRoutingInput, bindIntentClarification } from './intent-clarification.js';
import { assertSemanticClarificationChoice } from './semantic-clarification.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';

type Reference = { sessionId: string; routingId: string };
const collections = ['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession', 'workItemsBySession', 'tasksBySession', 'eventsBySession', 'eventOutbox'];

@Injectable()
export class SemanticClarificationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly controllers = new Set<AbortController>();
  private destroyed = false;
  constructor(private readonly persistence: PersistenceService, private readonly context: ContextManagementService,
    private readonly semantic: SemanticIntentRouterService, private readonly plans: IntentPlanCommitService, @Optional() private readonly events?: EventsService) {}

  onApplicationBootstrap() {
    const all = this.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {});
    for (const route of Object.values(all).flat()) if (['pending', 'ready'].includes(route.semanticClarification?.status ?? '')) this.schedule({ sessionId: route.sessionId, routingId: route.id });
  }
  onModuleDestroy() { this.destroyed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const controller of this.controllers) controller.abort(); }
  private schedule(reference: Reference, at = Date.now()) {
    if (this.destroyed || this.timers.has(reference.routingId)) return;
    const timer = setTimeout(() => { this.timers.delete(reference.routingId); void this.process(reference).catch(() => undefined); }, Math.max(1, at - Date.now() + 1));
    timer.unref(); this.timers.set(reference.routingId, timer);
  }

  async resolve(reference: Reference, actorId: string, input: ClarifyIntentRoutingInput) {
    assertClarifyIntentRoutingInput(input);
    if (input.contractVersion !== 'intent-clarify-v1') throw new ConflictException('CLARIFICATION_VERSION_REQUIRED');
    const replay = await this.mutate(reference, (draft, route, session, generation) => {
      if (session.ownerId !== actorId) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      if (route.semanticClarification?.status === 'blocked' && route.semanticClarification.request.confirmationId === input.confirmationId &&
        route.semanticClarification.request.choice === input.choice) throw new ConflictException(route.semanticClarification.failureCode);
      const binding = bindIntentClarification(route, rows<CollaborationEvent>(draft, 'eventsBySession', session.id), input);
      if (binding.replay) return 'replay';
      const pending = route.semanticClarification;
      if (pending) {
        if (pending.canonicalChoiceHash !== binding.canonicalChoiceHash) throw new ConflictException(
          pending.request.idempotencyKey === input.idempotencyKey ? 'IDEMPOTENCY_PAYLOAD_CONFLICT' : 'CLARIFICATION_CHOICE_CONFLICT');
        if (pending.actorId !== actorId) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
        return 'joined';
      }
      if (rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).some(other => other.id !== route.id &&
        (other.resolution?.idempotencyKey === input.idempotencyKey || other.semanticClarification?.request.idempotencyKey === input.idempotencyKey))) {
        throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
      }
      const payload = binding.card.metadata.payload;
      if (payload?.dataEpoch !== session.dataEpoch || payload.sessionGeneration !== generation ||
        payload.businessFingerprint !== routingBusinessFingerprint(session, rows<WorkItem>(draft, 'workItemsBySession', session.id),
          rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id))) {
        throw new ConflictException('CLARIFICATION_SNAPSHOT_STALE');
      }
      route.semanticClarification = { request: structuredClone(input), canonicalChoiceHash: binding.canonicalChoiceHash, actorId,
        dataEpoch: session.dataEpoch, sessionGeneration: generation, status: 'pending', attemptsUsed: 0, invocationIds: [],
        deadlineAt: new Date(Date.now() + 120000).toISOString() };
      return 'new';
    });
    if (replay !== 'replay') await this.process(reference);
    const route = this.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {})[reference.sessionId]?.find(row => row.id === reference.routingId);
    if (!route?.resolution) throw new ConflictException(route?.semanticClarification?.failureCode ?? 'CLARIFICATION_IN_PROGRESS');
    return { routing: route, plan: route.semanticPlan, idempotentReplay: replay !== 'new',
      workItem: this.context.listWorkItems(reference.sessionId).find(work => work.id === route.resolution?.resultWorkItemId) };
  }
  private process(reference: Reference) {
    const active = this.inFlight.get(reference.routingId); if (active) return active;
    const promise = this.run(reference).finally(() => this.inFlight.delete(reference.routingId));
    this.inFlight.set(reference.routingId, promise); return promise;
  }
  private async run(reference: Reference) {
    if (this.destroyed) return;
    const owner = randomUUID();
    const claim = await this.mutate(reference, (_draft, route) => {
      const pending = route.semanticClarification;
      if (!pending || !['pending', 'ready'].includes(pending.status) || route.resolution) return;
      if (Date.parse(pending.leaseExpiresAt ?? '') > Date.now()) return { wakeAt: Date.parse(pending.leaseExpiresAt!) };
      pending.ownerId = owner; pending.leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
      return { claimed: true };
    });
    if (claim?.wakeAt) { this.schedule(reference, claim.wakeAt); return; }
    if (!claim?.claimed) return;
    const controller = new AbortController(); this.controllers.add(controller);
    const heartbeat = setInterval(() => { void this.mutate(reference, (_draft, route) => {
      if (route.semanticClarification?.ownerId !== owner) { controller.abort(); return; }
      route.semanticClarification.leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
    }).catch(() => controller.abort()); }, 10000); heartbeat.unref();
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const current = await this.mutate(reference, (_draft, route, session) => {
          this.owned(route, owner);
          const pending = route.semanticClarification!;
          if (Date.parse(pending.deadlineAt) <= Date.now()) throw new ConflictException('CLARIFICATION_BUDGET_EXHAUSTED');
          return { route: structuredClone(route), session: structuredClone(session) };
        });
        const pending = current.route.semanticClarification!;
        if (pending.status === 'ready') {
          await this.plans.commit({ ...reference, actorId: pending.actorId, expectedRoutingRevision: pending.request.expectedRoutingRevision!,
            clarification: pending.request, clarificationOwner: owner }); return;
        }
        if (pending.attemptsUsed >= 2) throw new ConflictException('CLARIFICATION_BUDGET_EXHAUSTED');
        if (Date.parse(pending.retryAt ?? '') > Date.now()) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, Date.parse(pending.retryAt!) - Date.now());
          controller.signal.addEventListener('abort', abort, { once: true });
        });
        const original = this.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {})[reference.sessionId]
          ?.find(event => event.id === current.route.sourceEventId && event.type === 'user_message');
        if (!original) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
        const snapshot = await this.context.buildIntentSnapshot({ session: current.session, sourceEventId: original.id,
          currentMessage: original.content, latestEventSeq: 0 });
        const invocationId = randomUUID();
        const reserved = await this.mutate(reference, (draft, route, session) => {
          this.owned(route, owner); const state = route.semanticClarification!;
          const binding = bindIntentClarification(route, rows<CollaborationEvent>(draft, 'eventsBySession', reference.sessionId), state.request);
          if (binding.card.metadata.payload?.businessFingerprint !== routingBusinessFingerprint(session, rows<WorkItem>(draft, 'workItemsBySession', session.id),
            rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id))) throw new ConflictException('CLARIFICATION_SNAPSHOT_STALE');
          if (state.attemptsUsed >= 2 || Date.parse(state.deadlineAt) <= Date.now()) throw new ConflictException('CLARIFICATION_BUDGET_EXHAUSTED');
          state.attemptsUsed++; state.invocationIds.push(invocationId); state.snapshotId = snapshot.id; delete state.retryAt;
          return binding.card;
        });
        const payload = reserved.metadata.payload!, boundIds = (key: string) => Array.isArray(payload[key]) ? payload[key] as string[] : [];
        const result = await this.semantic.understand({ session: current.session, snapshot,
          operationId: `${reference.routingId}:clarification:${pending.request.confirmationId}`, invocationId, operationDeadlineAt: pending.deadlineAt,
          clarification: { choice: pending.request.choice, activeWorkItemId: typeof payload.activeWorkItemId === 'string' ? payload.activeWorkItemId : undefined,
            inheritedDecisionIds: boundIds('inheritedDecisionIds'), inheritedArtifactIds: boundIds('inheritedArtifactIds') },
          repairFeedback: pending.repairFeedback, signal: controller.signal });
        if (result.status === 'failed') {
          const delay = Number.isFinite(result.retryAfterMs) ? Math.max(100, result.retryAfterMs) : 100;
          if (result.retryable && result.failureClass === 'transient' && pending.attemptsUsed + 1 < 2 && Date.now() + delay < Date.parse(pending.deadlineAt)) {
            await this.mutate(reference, (_draft, route) => { this.owned(route, owner); route.semanticClarification!.retryAt = new Date(Date.now() + delay).toISOString(); });
            continue;
          }
          throw new ConflictException(result.code);
        }
        await this.mutate(reference, (_draft, route) => {
          this.owned(route, owner); const state = route.semanticClarification!;
          if (Date.parse(state.deadlineAt) <= Date.now()) throw new ConflictException('CLARIFICATION_BUDGET_EXHAUSTED');
          if (result.status === 'invalid') {
            if (state.repairFeedback || state.attemptsUsed >= 2) throw new ConflictException('INTENT_OUTPUT_INVALID');
            state.repairFeedback = { previousOutput: result.previousOutput.slice(0, 8000), validationErrors: result.validationErrors.slice(0, 20) }; return;
          }
          const parsed = validateRuntimeOutput('intent_understanding', result.understanding);
          if (!parsed.valid) throw new ConflictException('INTENT_OUTPUT_INVALID');
          assertSemanticClarificationChoice(state.request, reserved, parsed.value);
          state.understanding = structuredClone(parsed.value); state.status = 'ready';
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const blockedEvent = await this.mutate(reference, (draft, route) => {
        if (route.resolution || route.semanticClarification?.ownerId !== owner) return;
        route.semanticClarification.status = 'blocked'; route.semanticClarification.failureCode = error instanceof ConflictException ? error.message : 'CLARIFICATION_PROCESSING_FAILED';
        route.status = 'BLOCKED'; route.blockedReason = route.semanticClarification.failureCode; route.reasonCodes = [route.blockedReason];
        route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = new Date().toISOString();
        const event: CollaborationEvent = { id: `clarification-blocked:${route.semanticClarification.request.confirmationId}`, sessionId: reference.sessionId,
          type: 'intent_plan_blocked', actor: { type: 'system', id: 'intent-clarification' }, toAgentIds: [], createdAt: route.updatedAt,
          content: '本次关系选择尚未生效，处理过程受阻；当前消息未执行。', metadata: { schemaVersion: '0.1', renderAs: 'system_notice',
            payload: { routingId: route.id, routingRevision: route.routingRevision, reasonCode: route.blockedReason } } };
        appendCorrectionEvent(draft, event); return event;
        }).catch(() => undefined);
        if (blockedEvent) this.events?.acceptCommitted(blockedEvent);
      }
    } finally { clearInterval(heartbeat); this.controllers.delete(controller); }
  }
  private owned(route: IntentRoutingRecord, owner: string) {
    if (route.semanticClarification?.ownerId !== owner || Date.parse(route.semanticClarification.leaseExpiresAt ?? '') <= Date.now() ||
      !['pending', 'ready'].includes(route.semanticClarification.status)) throw new ConflictException('CLARIFICATION_LEASE_LOST');
  }
  private mutate<T>(reference: Reference, fn: (draft: PersistedState, route: IntentRoutingRecord, session: SessionDetail, generation: number) => T) {
    return this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[]).find(row => row.id === reference.sessionId);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', reference.sessionId).find(row => row.id === reference.routingId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[reference.sessionId];
      if (!session || session.archivedAt || session.status === 'CANCELLED' || !route?.semanticContractVersion || !lifecycle ||
        lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch || route.dispatchHold ||
        route.semanticProposal?.sessionGeneration !== lifecycle.generation || (route.semanticClarification &&
          (route.semanticClarification.dataEpoch !== session.dataEpoch || route.semanticClarification.sessionGeneration !== lifecycle.generation))) {
        throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      }
      return fn(draft, route, session, lifecycle.generation);
    }, { sessionIds: [reference.sessionId] });
  }
}
