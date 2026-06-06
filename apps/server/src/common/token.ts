import type { ContextPack, RuntimeBudget, SessionDetail } from '@agent-cluster/shared';

export function estimateTokens(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export function buildBudget(session: SessionDetail): RuntimeBudget {
  const total = normalizeBudget(session.tokenBudget ?? Number(process.env.TOKEN_BUDGET_DEFAULT ?? 100_000));
  return {
    maxInputTokens: Math.floor(total * 0.7),
    maxOutputTokens: Math.floor(total * 0.2),
    maxTotalTokens: total
  };
}

export function fitContextToBudget(contextPack: ContextPack): { contextPack: ContextPack; estimatedTokens: number; trimmed: boolean } {
  const maxInputTokens = contextPack.budget.maxInputTokens;
  let next = contextPack;
  let estimatedTokens = estimateTokens(next);
  let trimmed = false;

  if (!maxInputTokens || estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed };
  }

  next = {
    ...next,
    relevantEvents: next.relevantEvents.slice(-4),
    ragSnippets: next.ragSnippets.slice(0, 2)
  };
  estimatedTokens = estimateTokens(next);
  trimmed = true;

  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed };
  }

  next = {
    ...next,
    relevantEvents: [],
    ragSnippets: [],
    artifacts: next.artifacts.slice(-3)
  };
  estimatedTokens = estimateTokens(next);
  return { contextPack: next, estimatedTokens, trimmed };
}

function normalizeBudget(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100_000;
}
