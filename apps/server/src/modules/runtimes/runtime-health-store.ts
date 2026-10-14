import { ConflictException, NotFoundException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { AgentRuntimeEvent, CollaborationEvent, InvocationPlan, RuntimeHealthSnapshot, RuntimeHealthWaitInput,
  RuntimeObservation, RuntimeObservationKind, RuntimeHealthCapabilities } from '@agent-cluster/shared';
import { runtimeEventObservation, runtimeHealthLabel, normalizeRuntimeHealthSnapshot } from '@agent-cluster/shared';
import { createRuntimeHealthState, reduceRuntimeHealth, type RuntimeHealthState } from '../../common/runtime-health-policy.js';
import type { PersistenceService } from '../persistence/persistence.service.js';
import type { EventsService } from '../events/events.service.js';

export const RUNTIME_HEALTH_COLLECTION = 'runtimeHealthBySession';
type HealthBySession = Record<string, RuntimeHealthSnapshot[]>;

/** Health is an auxiliary projection. Saving it must never abort/replay an invocation. */
export class RuntimeHealthStore {
  private readonly live = new Map<string, RuntimeHealthState>();
  private readonly pending = new Map<string, RuntimeHealthSnapshot>();
  private writes?: Promise<void>;
  private syncFailures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly persistence: PersistenceService, private readonly events?: EventsService,
    private readonly monotonic = () => performance.now()) {}

  begin(plan: InvocationPlan, generation: number, silenceMs: number, capabilities?: RuntimeHealthCapabilities) {
    const previous = this.list(plan.sessionId).find(item => item.invocationId === plan.invocationId);
    const state = createRuntimeHealthState({ sessionId: plan.sessionId, operationId: plan.operation?.id ?? plan.invocationId,
      invocationId: plan.invocationId, sessionGeneration: generation, observerEpoch: crypto.randomUUID(),
      agentId: plan.agent.agentId, phase: plan.phase, runtimeType: plan.executionTarget.runtimeType,
      startedAt: new Date().toISOString(), deadlineAt: plan.operation?.deadlineAt, capabilities,
      version: (previous?.version ?? 0) + 1 }, this.monotonic());
    this.live.set(plan.invocationId, state);
    this.pending.set(plan.invocationId, state.snapshot);
    void silenceMs;
    return state.snapshot;
  }

  list(sessionId: string): RuntimeHealthSnapshot[] {
    const operations = this.persistence.getCollection<Record<string, Array<{ id: string; stopState: string; activeInvocationId?: string; invocationIds: string[] }>>>
      ('logicalOperationsBySession', {})[sessionId] ?? [];
    for (const state of this.live.values()) {
      const item = state.snapshot;
      if (item.sessionId === sessionId && item.stage === 'stopping' && operations.some(op =>
        op.id === item.operationId && op.stopState === 'confirmed' && !op.activeInvocationId && op.invocationIds.includes(item.invocationId))) {
        this.signal(item.invocationId, 'terminal_received', 0, { source: 'durable_stop_receipt' });
        void this.flush();
      }
    }
    const persisted = (this.persistence.getCollection<HealthBySession>(RUNTIME_HEALTH_COLLECTION, {})[sessionId] ?? [])
      .map(normalizeRuntimeHealthSnapshot).filter((item): item is RuntimeHealthSnapshot => Boolean(item && item.sessionId === sessionId));
    const items = new Map(persisted.map(snapshot => [snapshot.invocationId, snapshot.stage === 'terminal' ? snapshot : {
      ...snapshot, historical: true, health: 'unknown' as const, stage: 'unknown_wait' as const,
      reasonCode: 'historical_observation', processStatus: 'unknown' as const, requestStatus: 'unknown' as const,
      canWait: false, canStop: false
    }]));
    for (const state of this.live.values()) if (state.snapshot.sessionId === sessionId) items.set(state.snapshot.invocationId, state.snapshot);
    return structuredClone([...items.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
  }

  observe(invocationId: string, event: AgentRuntimeEvent, silenceMs: number) {
    const state = this.live.get(invocationId);
    if (!state || event.invocationId !== invocationId) return;
    const md = event.metadata ?? {};
    if (md.progressReplay === true) return;
    if (md.code === 'RUNTIME_REQUEST_OBSERVATION' && md.observationKind === 'observation_due') {
      this.tick(invocationId, typeof md.count === 'number' && md.count > 0 ? Math.min(md.count, silenceMs) : silenceMs); return;
    }
    const observation = runtimeEventObservation(event);
    if (observation) this.signal(invocationId, observation.kind, silenceMs, { ...observation, source: 'runtime' });
  }

  signal(invocationId: string, kind: RuntimeObservationKind, silenceMs: number, fields: Partial<RuntimeObservation> = {}) {
    const state = this.live.get(invocationId);
    if (!state) return;
    this.update(invocationId, reduceRuntimeHealth(state, { type: 'observation', observation: {
      ...state.snapshot, ...fields, kind, source: fields.source ?? 'supervisor',
      sequence: state.lastSequence + 1, observedAt: new Date().toISOString()
    } }, this.monotonic(), silenceMs));
  }

  tick(invocationId: string, silenceMs: number) {
    const state = this.live.get(invocationId);
    if (state) this.update(invocationId, reduceRuntimeHealth(state,
      { type: 'tick', observedAt: new Date().toISOString() }, this.monotonic(), silenceMs));
  }

  snapshot(invocationId: string) { return this.live.get(invocationId)?.snapshot; }

  budgetFallback(invocationId: string, reason: NonNullable<RuntimeHealthSnapshot['budgetFallbackReason']>) {
    const state = this.live.get(invocationId);
    if (!state || ['terminal', 'stopping'].includes(state.snapshot.stage)) return;
    this.update(invocationId, { ...state, snapshot: { ...state.snapshot, budgetFallbackReason: reason,
      version: state.snapshot.version + 1, updatedAt: new Date().toISOString() } });
  }

  async wait(sessionId: string, invocationId: string, input: RuntimeHealthWaitInput) {
    const state = this.live.get(invocationId);
    if (!state || state.snapshot.sessionId !== sessionId) throw new NotFoundException('Active invocation not found.');
    const snapshot = state.snapshot;
    const lifecycle = this.persistence.getCollection<Record<string, { generation: number; state: string; admission: string }>>
      ('sessionLifecyclesBySession', {})[sessionId];
    if (lifecycle && (lifecycle.generation !== input.sessionGeneration || lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
      throw new ConflictException({ code: 'RUNTIME_HEALTH_CONFLICT', snapshot });
    }
    if (snapshot.sessionGeneration !== input.sessionGeneration || snapshot.stage !== 'unknown_wait' || !snapshot.canWait) {
      throw new ConflictException({ code: 'RUNTIME_HEALTH_CONFLICT', snapshot });
    }
    if (snapshot.lastWaitKey === input.idempotencyKey) return structuredClone(snapshot);
    if (snapshot.version !== input.expectedVersion) throw new ConflictException({ code: 'RUNTIME_HEALTH_CONFLICT', snapshot });
    const next = reduceRuntimeHealth(state, { type: 'wait', observedAt: new Date().toISOString() }, this.monotonic(), 0);
    next.snapshot.lastWaitKey = input.idempotencyKey;
    this.update(invocationId, next);
    await this.flush(true);
    return structuredClone(this.snapshot(invocationId) ?? next.snapshot);
  }

  private update(id: string, next: RuntimeHealthState) {
    const previous = this.live.get(id);
    this.live.set(id, next);
    if (next !== previous && next.snapshot.version !== previous?.snapshot.version) this.pending.set(id, next.snapshot);
  }

  /** Coalesced by the supervisor tick; serialized, atomic snapshot + outbox. */
  flush(manualRetry = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.writes) return this.writes;
    if (manualRetry) { this.syncFailures = 0; clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    if (this.syncFailures >= 3 || this.retryTimer) return Promise.resolve();
    this.writes = (async () => {
      const batch = [...this.pending.values()].map(item => structuredClone(item));
      if (!batch.length) return;
      try {
        const committed = await this.persistence.mutateCollections([RUNTIME_HEALTH_COLLECTION, 'eventsBySession', 'eventOutbox', 'sessionLifecyclesBySession'], draft => {
          const all = (draft[RUNTIME_HEALTH_COLLECTION] ??= {}) as HealthBySession;
          const emitted: CollaborationEvent[] = [];
          for (const snapshot of batch) {
            const lifecycle = (draft.sessionLifecyclesBySession as Record<string, { state: string; generation: number }> | undefined)?.[snapshot.sessionId];
            if (lifecycle && (['deleted', 'deleting'].includes(lifecycle.state) ||
              (lifecycle.generation !== snapshot.sessionGeneration && !['terminal', 'stopping'].includes(snapshot.stage)))) continue;
            delete snapshot.pendingSync;
            const items = all[snapshot.sessionId] ??= [];
            const index = items.findIndex(item => item.invocationId === snapshot.invocationId);
            const old = index >= 0 ? items[index] : undefined;
            if (old && old.version >= snapshot.version) continue;
            if (index >= 0) items[index] = snapshot; else items.push(snapshot);
            if (old?.stage === snapshot.stage && old.health === snapshot.health && old.lastWaitKey === snapshot.lastWaitKey &&
              old.failureAt === snapshot.failureAt && old.budgetFallbackReason === snapshot.budgetFallbackReason) continue;
            const id = `runtime-health:${snapshot.invocationId}:${snapshot.version}`;
            const event: CollaborationEvent = { id, sessionId: snapshot.sessionId, fromAgentId: snapshot.agentId,
              toAgentIds: [], type: 'runtime_progress', content: runtimeHealthLabel(snapshot), createdAt: snapshot.updatedAt,
              actor: { type: 'system', id: 'runtime-supervisor', displayName: 'Runtime Supervisor' },
              metadata: { schemaVersion: '0.1', renderAs: 'system_notice', idempotencyKey: id,
                payload: { code: 'RUNTIME_REQUEST_HEALTH_CHANGED', healthSnapshot: snapshot } } };
            const events = ((draft.eventsBySession ??= {}) as Record<string, CollaborationEvent[]>)[snapshot.sessionId] ??= [];
            if (!events.some(item => item.id === id)) events.push(event);
            const outbox = (draft.eventOutbox ??= []) as Array<Record<string, unknown>>;
            if (!outbox.some(item => item.id === `outbox:${id}`)) outbox.push({ id: `outbox:${id}`,
              idempotencyKey: `session:${snapshot.sessionId}:event:${id}`, aggregateType: 'session', aggregateId: snapshot.sessionId,
              eventType: event.type, payload: { event }, status: 'pending', attempts: 0, createdAt: event.createdAt });
            emitted.push(event);
          }
          return emitted;
        });
        for (const event of committed) this.events?.acceptCommitted(event);
        this.syncFailures = 0;
        for (const snapshot of batch) {
          if (this.pending.get(snapshot.invocationId)?.version === snapshot.version) this.pending.delete(snapshot.invocationId);
          const live = this.live.get(snapshot.invocationId);
          if (live) live.snapshot.pendingSync = false;
          if (live?.snapshot.stage === 'terminal' && !this.pending.has(snapshot.invocationId)) this.live.delete(snapshot.invocationId);
        }
      } catch {
        for (const snapshot of batch) {
          const state = this.live.get(snapshot.invocationId);
          if (state) state.snapshot.pendingSync = true;
        }
        this.syncFailures++;
        if (this.syncFailures < 3) {
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush(); }, 1000 * 2 ** this.syncFailures);
          this.retryTimer.unref();
        }
        // Bounded auxiliary sync only. Never abort/resume/replay a model on storage failure.
      }
    })().finally(() => {
      this.writes = undefined;
      // A terminal/wait update can arrive during the previous atomic write.
      // Coalesce it into one follow-up; never lose it when supervision stops ticking.
      if (this.pending.size && this.syncFailures === 0) queueMicrotask(() => { void this.flush(); });
    });
    return this.writes;
  }

  dispose() { this.disposed = true; clearTimeout(this.retryTimer); }
}
