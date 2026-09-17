import type { AgentRunPhase, LogicalOperation, SessionStopRequest, SessionStopTargetState } from '@agent-cluster/shared';
import { phaseTimeoutMs } from '../../common/runtime-config.js';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import { SESSION_STOP_REQUESTS_COLLECTION, type StopRequestsBySession } from './session-stop-state-store.js';
import { appendRuntimeStopStateEvent } from './runtime-stop-event.js';
import {
  SESSION_LIFECYCLES_COLLECTION,
  type SessionLifecyclesBySession,
  syncLifecycleStopStatus
} from './session-lifecycle-store.js';

const collection = 'logicalOperationsBySession';
type Operations = Record<string, LogicalOperation[]>;
const STOPPED_SESSION_STATUSES = new Set(['PAUSED', 'INTERRUPTED', 'CANCELLED', 'COMPLETED']);

export function operationPolicy(phase: AgentRunPhase) {
  const control = phase === 'user_message_routing' || phase === 'task_acceptance';
  const configured = phaseTimeoutMs(phase);
  const raw = process.env[`PHASE_TIMEOUT_${phase.toUpperCase()}_MS`]?.trim();
  return { policyVersion: 'execution-reliability-v1' as const,
    timeoutMs: control ? 120_000 : configured > 0 && configured <= 2_147_483_647 ? configured : 1_200_000,
    diagnostics: !control && raw && !(Number(raw) > 0 && Number(raw) <= 2_147_483_647)
      ? ['INVALID_OR_DISABLED_PHASE_TIMEOUT_USING_FINITE_DEFAULT'] : [],
    maxAttempts: control ? 2 : 3 };
}

/** The durable reservation is committed before an adapter may start a process. */
export class LogicalOperationStore {
  private readonly ownerId = crypto.randomUUID();
  private pending = Promise.resolve();
  private cache: Operations = {};
  constructor(private readonly persistence: PersistenceService, private readonly now = Date.now) {}

  list(sessionId: string) {
    return this.persistence.getCollection<Operations>(collection, this.cache)[sessionId] ?? [];
  }

  findResumable(sessionId: string, scopeKey: string) {
    const lifecycle = this.persistence.getCollection<SessionLifecyclesBySession>(SESSION_LIFECYCLES_COLLECTION, {})[sessionId];
    if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) return undefined;
    return this.list(sessionId).find(item => item.status === 'paused' && item.scopeKey === scopeKey &&
      (!lifecycle || item.sessionGeneration === lifecycle.generation));
  }

  begin(input: { id: string; sessionId: string; taskId?: string; phase: AgentRunPhase; parentId?: string; previousId?: string; scopeKey?: string }) {
    return this.mutateStopAware(input.sessionId, (operations, _requests, draft) => {
      const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[input.sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
        throw new Error('SESSION_ADMISSION_CLOSED');
      }
      const id = lifecycle && operations.some(item =>
        item.id === input.id && item.sessionGeneration !== lifecycle.generation)
        ? generationOperationId(input.id, lifecycle.generation)
        : input.id;
      const existing = operations.find(item => item.id === id);
      if (existing) return structuredClone(existing);
      const policy = operationPolicy(input.phase);
      const now = this.now();
      const parentId = input.parentId && lifecycle && operations.some(item =>
        item.id === input.parentId && item.sessionGeneration !== lifecycle.generation)
        ? generationOperationId(input.parentId, lifecycle.generation)
        : input.parentId;
      const parent = parentId ? operations.find(item => item.id === parentId) : undefined;
      if (input.parentId && !parent) throw new Error('OPERATION_PARENT_MISSING');
      const deadline = Math.min(now + policy.timeoutMs, parent ? Date.parse(parent.deadlineAt) : Infinity);
      const operation: LogicalOperation = { ...input, id, ...(parentId ? { parentId } : {}),
        ...(lifecycle ? { sessionGeneration: lifecycle.generation } : {}),
        policyVersion: policy.policyVersion, status: 'ready',
        deadlineAt: new Date(deadline).toISOString(), remainingActiveMs: Math.max(0, deadline - now),
        maxAttempts: policy.maxAttempts, attemptsUsed: 0, stopState: 'none', invocationIds: [],
        diagnostics: policy.diagnostics, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      operations.push(operation);
      return structuredClone(operation);
    });
  }

  reserve(sessionId: string, operationId: string, invocationId: string,
    binding?: { transport?: LogicalOperation['transport']; outputContractKey?: string; executionKind?: LogicalOperation['executionKind'] }) {
    return this.mutateStopAware(sessionId, (operations, requests, draft) => {
      const session = Array.isArray(draft.sessions)
        ? (draft.sessions as Array<{ id?: string; status?: string }>).find(item => item.id === sessionId)
        : undefined;
      const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open' ||
        operationGenerationMismatch(operations, operationId, lifecycle.generation))) {
        throw new Error('SESSION_ADMISSION_CLOSED');
      }
      if (session?.status && STOPPED_SESSION_STATUSES.has(session.status)) {
        throw new Error('OPERATION_STOP_UNCONFIRMED');
      }
      if (requests.at(-1)?.status !== undefined && requests.at(-1)?.status !== 'confirmed') {
        throw new Error('OPERATION_STOP_UNCONFIRMED');
      }
      const operation = this.require(operations, operationId);
      if (operations.some(item => item.stopState === 'unconfirmed' ||
        (item.status === 'running' && item.executionKind !== 'internal' && item.ownerId !== this.ownerId))) throw new Error('OPERATION_STOP_UNCONFIRMED');
      if (operation.status === 'paused' || operation.status === 'interrupted') throw new Error('OPERATION_REQUIRES_RESUME');
      if (operation.activeInvocationId) throw new Error('OPERATION_ALREADY_RUNNING');
      if (operation.outputContractKey && binding?.outputContractKey && operation.outputContractKey !== binding.outputContractKey) {
        throw new Error('OPERATION_OUTPUT_VERSION_CHANGED');
      }
      if (operation.invocationIds.includes(invocationId)) throw new Error('OPERATION_DUPLICATE_INVOCATION');
      if (operation.attemptsUsed >= operation.maxAttempts || Date.parse(operation.deadlineAt) <= this.now()) {
        throw new Error('OPERATION_BUDGET_EXHAUSTED');
      }
      operation.attemptsUsed += 1;
      operation.invocationIds.push(invocationId);
      operation.activeInvocationId = invocationId;
      operation.ownerId = this.ownerId;
      operation.transport = binding?.transport;
      operation.executionKind = binding?.executionKind ?? 'process';
      operation.outputContractKey ??= binding?.outputContractKey;
      operation.status = 'running';
      operation.stopState = 'none';
      operation.updatedAt = new Date(this.now()).toISOString();
      return structuredClone(operation);
    });
  }

  settle(sessionId: string, operationId: string, invocationId: string, stopState: LogicalOperation['stopState'] = 'confirmed', pause = false) {
    return this.mutateStopAware(sessionId, (operations, requests, draft) => {
      const operation = this.require(operations, operationId);
      if (operation.activeInvocationId !== invocationId) return;
      if (operation.stopState !== 'unconfirmed') operation.remainingActiveMs = Math.max(0, Date.parse(operation.deadlineAt) - this.now());
      operation.stopState = stopState;
      operation.pauseRequested ||= pause;
      operation.status = stopState === 'unconfirmed' ? 'interrupted'
        : operation.pauseRequested ? 'paused' : operation.remainingActiveMs > 0 && operation.attemptsUsed < operation.maxAttempts ? 'ready' : 'exhausted';
      if (stopState === 'confirmed') delete operation.activeInvocationId;
      operation.updatedAt = new Date(this.now()).toISOString();
      const request = requests.at(-1);
      const changed = updateStopTarget(request, invocationId, stopState === 'confirmed' ? 'confirmed' : 'unknown',
        this.now(), stopState === 'confirmed' ? 'adapter_result' : undefined);
      if (request) syncLifecycleStopStatus(draft, sessionId, request.status);
      return changed && request ? appendRuntimeStopStateEvent(draft, request) : undefined;
    });
  }

  resume(sessionId: string, operationId: string) {
    return this.mutateStopAware(sessionId, (operations, _requests, draft) => {
      const operation = this.require(operations, operationId);
      const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open' ||
        operation.sessionGeneration !== lifecycle.generation)) throw new Error('SESSION_ADMISSION_CLOSED');
      if (operation.status !== 'paused') throw new Error('OPERATION_NOT_PAUSED');
      if (operation.stopState !== 'confirmed' || operation.activeInvocationId) throw new Error('OPERATION_STOP_UNCONFIRMED');
      if (operation.remainingActiveMs <= 0 || operation.attemptsUsed >= operation.maxAttempts) throw new Error('OPERATION_BUDGET_EXHAUSTED');
      const parent = operation.parentId ? this.require(operations, operation.parentId) : undefined;
      operation.deadlineAt = new Date(Math.min(this.now() + operation.remainingActiveMs,
        parent ? Date.parse(parent.deadlineAt) : Infinity)).toISOString();
      operation.status = 'ready';
      operation.pauseRequested = false;
      return structuredClone(operation);
    });
  }

  hasUnknownStop(sessionId: string) {
    return this.list(sessionId).some(item => item.stopState === 'unconfirmed' ||
      (item.status === 'running' && item.executionKind !== 'internal' && item.ownerId !== this.ownerId));
  }

  reserveCorrection(sessionId: string, operationId: string) {
    return this.mutateStopAware(sessionId, (operations, _requests, draft) => {
      const operation = this.require(operations, operationId);
      const lifecycle = ((draft[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open' ||
        operation.sessionGeneration !== lifecycle.generation)) throw new Error('SESSION_ADMISSION_CLOSED');
      if ((operation.correctionsUsed ?? 0) >= 1 || Date.parse(operation.deadlineAt) <= this.now()) return false;
      operation.correctionsUsed = 1;
      return true;
    });
  }

  async confirmTransportResult(invocationId: string, binding: NonNullable<LogicalOperation['transport']>) {
    return (await this.confirmTransportReceipt(invocationId, binding)).confirmed;
  }

  async confirmTransportReceipt(invocationId: string, binding: NonNullable<LogicalOperation['transport']>) {
    // Resolve and settle against the same locked snapshot, including after a
    // server restart. A duplicate receipt cannot confirm a newer invocation.
    let committed: Operations | undefined;
    const receipt = await this.persistence.mutateCollections([SESSION_LIFECYCLES_COLLECTION, collection,
      SESSION_STOP_REQUESTS_COLLECTION, 'eventsBySession', 'eventOutbox'], draft => {
      const all = (draft[collection] ??= {}) as Operations;
      const stopRequests = (draft[SESSION_STOP_REQUESTS_COLLECTION] ??= {}) as StopRequestsBySession;
      const candidates = Object.values(all).flat().filter(item => item.invocationIds.includes(invocationId) &&
        item.transport?.deviceId === binding.deviceId && item.transport.workspaceId === binding.workspaceId &&
        item.transport.runtimeType === binding.runtimeType);
      const operation = candidates.find(item => item.activeInvocationId === invocationId) ?? candidates.find(item =>
        item.stopState === 'confirmed' && !item.activeInvocationId);
      if (!operation) return {
        confirmed: false,
        alreadyConfirmed: false,
        stopConfirmed: false,
        sessionId: undefined,
        operationId: undefined,
        stopRequestId: undefined,
        version: undefined,
        event: undefined
      };
      const alreadyConfirmed = operation.stopState === 'confirmed' && operation.activeInvocationId !== invocationId;
      const stopConfirmed = operation.stopState === 'unconfirmed' || operation.pauseRequested === true;
      if (!alreadyConfirmed) {
        if (operation.stopState !== 'unconfirmed') operation.remainingActiveMs = Math.max(0, Date.parse(operation.deadlineAt) - this.now());
        operation.stopState = 'confirmed';
        operation.status = operation.pauseRequested ? 'paused'
          : operation.remainingActiveMs > 0 && operation.attemptsUsed < operation.maxAttempts ? 'ready' : 'exhausted';
        delete operation.activeInvocationId;
        operation.updatedAt = new Date(this.now()).toISOString();
      }
      const request = stopRequests[operation.sessionId]?.at(-1);
      const changed = updateStopTarget(request, invocationId, 'confirmed', this.now(), 'transport_receipt');
      if (request) syncLifecycleStopStatus(draft, operation.sessionId, request.status);
      committed = structuredClone(all);
      return { confirmed: true, alreadyConfirmed, stopConfirmed, sessionId: operation.sessionId,
        operationId: operation.id, stopRequestId: request?.id, version: request?.version,
        event: changed && request ? appendRuntimeStopStateEvent(draft, request) : undefined };
    });
    if (committed) this.cache = committed;
    return receipt;
  }

  sessionForInvocation(invocationId: string) {
    const all = this.persistence.getCollection<Operations>(collection, this.cache);
    return Object.values(all).flat().find(item => item.invocationIds.includes(invocationId))?.sessionId;
  }

  private require(operations: LogicalOperation[], id: string) {
    const operation = operations.find(item => item.id === id);
    if (!operation) throw new Error('OPERATION_NOT_FOUND');
    return operation;
  }

  private mutate<T>(sessionId: string, mutation: (operations: LogicalOperation[]) => T): Promise<T> {
    const run = async () => {
      let committed: Operations | undefined;
      const result = await this.persistence.mutateCollections([collection], (draft: PersistedState) => {
        const all = (draft[collection] ??= {}) as Operations;
        const result = mutation(all[sessionId] ??= []);
        committed = structuredClone(all);
        return result;
      });
      if (committed) this.cache = committed;
      return result;
    };
    const result = this.pending.then(run, run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private mutateStopAware<T>(
    sessionId: string,
    mutation: (operations: LogicalOperation[], requests: SessionStopRequest[], draft: PersistedState) => T
  ): Promise<T> {
    const run = async () => {
      let committed: Operations | undefined;
      const result = await this.persistence.mutateCollections(
        ['sessions', SESSION_LIFECYCLES_COLLECTION, collection, SESSION_STOP_REQUESTS_COLLECTION,
          'eventsBySession', 'eventOutbox'],
        (draft: PersistedState) => {
          const all = (draft[collection] ??= {}) as Operations;
          const stopRequests = (draft[SESSION_STOP_REQUESTS_COLLECTION] ??= {}) as StopRequestsBySession;
          const result = mutation(all[sessionId] ??= [], stopRequests[sessionId] ??= [], draft);
          committed = structuredClone(all);
          return result;
        }
      );
      if (committed) this.cache = committed;
      return result;
    };
    const result = this.pending.then(run, run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

function generationOperationId(baseId: string, generation: number) {
  return `${baseId}:generation:${generation}`;
}

function updateStopTarget(
  request: SessionStopRequest | undefined,
  invocationId: string,
  state: SessionStopTargetState,
  now: number,
  evidence?: 'adapter_result' | 'transport_receipt'
) {
  if (!request || request.status === 'confirmed') return false;
  const target = request.targets.find(item => item.invocationId === invocationId);
  if (!target || target.state === state && target.evidence === evidence) return false;
  const timestamp = new Date(now).toISOString();
  target.state = state;
  target.updatedAt = timestamp;
  if (evidence) target.evidence = evidence;
  request.version += 1;
  request.status = request.targets.every(item => item.state === 'confirmed') ? 'confirmed' : 'waiting';
  request.updatedAt = timestamp;
  return true;
}

function operationGenerationMismatch(operations: LogicalOperation[], operationId: string, generation: number) {
  const operation = operations.find(item => item.id === operationId);
  return operation?.sessionGeneration !== undefined && operation.sessionGeneration !== generation;
}
