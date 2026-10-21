import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { DecideInputBudgetInput, InputBudgetDecision, InputBudgetEstimate, InvocationPlan,
  LogicalOperation, SessionDetail, AgentTask } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from './session-lifecycle-store.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'logicalOperationsBySession', 'tasksBySession'];
const processConsumerId = randomUUID();
export const INPUT_BUDGET_EXCEEDED = 'INPUT_BUDGET_EXCEEDED';

/** Stores only identity, estimates and receipts. Prompts/tool history are never persisted here. */
export class InputBudgetStore {
  constructor(private readonly persistence?: PersistenceService, private readonly consumerId = processConsumerId) {}

  async assert(plan: InvocationPlan, estimate: InputBudgetEstimate, consume: boolean) {
    const policy = plan.inputBudgetPolicy;
    if (!policy) return;
    const total = estimate.estimatedInputTokens + estimate.outputReservationTokens;
    let blocked: InputBudgetDecision | undefined;
    if (this.persistence && plan.operation) {
      blocked = await this.persistence.mutateCollections(collections, draft => {
        const operation = this.validate(draft, plan.sessionId, policy.actorId, plan.operation!.id);
        const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession)[plan.sessionId];
        if (policy.dataEpoch !== lifecycle.dataEpoch || policy.sessionGeneration !== lifecycle.generation || !policy.slot ||
          (policy.kind === 'intent_understanding' && operation.phase !== 'user_message_routing') ||
          (policy.kind === 'agent_task' && (operation.taskId !== policy.taskId || operation.phase !== 'task_execution' ||
            !rows<AgentTask>(draft, 'tasksBySession', plan.sessionId).some(task => task.id === policy.taskId && !['completed', 'cancelled'].includes(task.status))))) {
          throw new ConflictException('INPUT_BUDGET_SCOPE_STALE');
        }
        const decisions = operation.inputBudgetDecisions ??= [];
        const current = decisions.filter(item => item.slot === policy.slot).at(-1);
        if (current && current.dataEpoch === policy.dataEpoch && current.sessionGeneration === policy.sessionGeneration &&
          current.actorId === policy.actorId && current.routingRevision === policy.routingRevision) {
          if (current.status === 'ended') throw new ConflictException('INPUT_BUDGET_CALL_ENDED');
          if (current.status === 'pending') return structuredClone(current);
          const ceiling = current.estimatedInputTokens + current.outputReservationTokens;
          const sameRerun = current.consumedByInvocationId === plan.invocationId && current.consumedByProcessId === this.consumerId;
          if (total <= ceiling && (current.status === 'granted' || sameRerun)) {
            if (consume && current.status === 'granted') {
              current.status = 'consumed'; current.consumedByInvocationId = plan.invocationId;
              current.consumedByProcessId = this.consumerId;
            }
            return undefined;
          }
          // An active rerun owns its consumed grant, even when a competitor's first round is cheap.
          if (current.status === 'consumed' && !sameRerun && operation.activeInvocationId) {
            throw new ConflictException('INPUT_BUDGET_GRANT_ALREADY_CONSUMED');
          }
        }
        if (total <= estimate.effectiveMaxInputTokens) return undefined;
        const hold: InputBudgetDecision = { ...policy, ...estimate, id: randomUUID(), operationId: operation.id,
          sessionId: plan.sessionId, status: 'pending', createdAt: new Date().toISOString() };
        decisions.push(hold);
        operation.pauseRequested = true;
        // Preflight can stop before RuntimeService has reserved an invocation.
        if (!operation.activeInvocationId) {
          operation.remainingActiveMs = Math.max(0, Date.parse(operation.deadlineAt) - Date.now());
          operation.status = 'paused'; operation.stopState = 'confirmed';
        }
        return structuredClone(hold);
      }, { sessionIds: [plan.sessionId] });
      if (!blocked) return;
    } else if (total <= estimate.effectiveMaxInputTokens) return;
    if (blocked || total > estimate.effectiveMaxInputTokens) {
      throw Object.assign(new Error('输入预算不足，已停止本次调用。请选择继续（仅本次放行）或结束。'), {
        code: INPUT_BUDGET_EXCEEDED, retryable: false, inputBudgetDecision: blocked,
        details: { ...estimate, inputBudgetDecision: blocked, inputBudgetExceeded: true }
      });
    }
  }

  async decide(sessionId: string, actorId: string, request: DecideInputBudgetInput, kind?: InputBudgetDecision['kind']) {
    if (!this.persistence) throw new ConflictException('INPUT_BUDGET_STORE_UNAVAILABLE');
    return this.persistence.mutateCollections(collections, draft => {
      const operation = this.validate(draft, sessionId, actorId, request.operationId);
      const hold = operation.inputBudgetDecisions?.find(row => row.id === request.decisionId);
      if (!hold || hold.actorId !== actorId) throw new ConflictException('INPUT_BUDGET_DECISION_UNAVAILABLE');
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession)[sessionId];
      if ((kind && hold.kind !== kind) || hold.dataEpoch !== lifecycle.dataEpoch || hold.sessionGeneration !== lifecycle.generation) {
        throw new ConflictException('INPUT_BUDGET_SCOPE_STALE');
      }
      if (hold.decision) {
        if (hold.decision !== request.decision) throw new ConflictException('INPUT_BUDGET_DECISION_CONFLICT');
        return { hold: structuredClone(hold), idempotentReplay: true,
          isCurrentDecision: operation.inputBudgetDecisions?.filter(row => row.slot === hold.slot).at(-1)?.id === hold.id };
      }
      if (hold.status !== 'pending' || operation.activeInvocationId || operation.stopState === 'unconfirmed') {
        throw new ConflictException('INPUT_BUDGET_CALL_NOT_STOPPED');
      }
      hold.decision = request.decision; hold.decidedAt = new Date().toISOString();
      hold.status = request.decision === 'continue' ? 'granted' : 'ended';
      return { hold: structuredClone(hold), idempotentReplay: false, isCurrentDecision: true };
    }, { sessionIds: [sessionId] });
  }

  private validate(draft: PersistedState, sessionId: string, actorId: string, operationId: string) {
    const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
    const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
    const operation = rows<LogicalOperation>(draft, 'logicalOperationsBySession', sessionId).find(row => row.id === operationId);
    if (!session || session.ownerId !== actorId || session.archivedAt || session.status === 'CANCELLED' || !lifecycle ||
      lifecycle.state !== 'active' || lifecycle.admission !== 'open' || lifecycle.dataEpoch !== session.dataEpoch || !operation ||
      operation.sessionGeneration !== lifecycle.generation) throw new ConflictException('INPUT_BUDGET_SCOPE_STALE');
    return operation;
  }
}

function rows<T>(draft: PersistedState, key: string, sessionId: string): T[] {
  return (draft[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
}
