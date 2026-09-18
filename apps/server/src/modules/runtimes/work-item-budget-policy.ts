import type { AgentRunPhase, RuntimeAttemptTrace, WorkItemBudgetCategory } from '@agent-cluster/shared';

/** The error code a caller must surface when a requirement has no allowance left. */
export const WORK_ITEM_BUDGET_EXHAUSTED_CODE = 'WORK_ITEM_BUDGET_EXHAUSTED';

/**
 * Which surface a model call is charged to.
 *
 * Retry and supplemental read are properties of the attempt rather than the
 * phase, so they win: a retried classification is still a retry, and a
 * supplemental read stays attributable even when it happens during execution.
 */
export function budgetCategoryFor(
  phase: AgentRunPhase,
  attempt?: RuntimeAttemptTrace
): WorkItemBudgetCategory {
  if ((attempt?.supplementalContextAttempt ?? 0) > 0) return 'supplemental_read';
  if (attempt?.retryOfInvocationId || (attempt?.attempt ?? 1) > 1) return 'retry';
  switch (phase) {
    case 'user_message_routing':
      return 'classification';
    case 'discussion':
    case 'brief_consultation':
      return 'consultation';
    default:
      return 'execution';
  }
}

/**
 * User-visible capacity explanation. Kept Chinese on purpose: the project's
 * chinese-visible-copy gate forbids English budget wording from surfacing.
 */
export function workItemBudgetExhaustedMessage(input: {
  availableTokens: number;
  requestedTokens: number;
  limitTokens: number;
}): string {
  return `该需求的累计模型预算已不足（剩余 ${input.availableTokens} tokens，本次需要 ${input.requestedTokens}，需求上限 ${input.limitTokens}）。请等待当前轮次结算后再继续，或先缩小本次补读范围；平台不会静默截断请求。`;
}
