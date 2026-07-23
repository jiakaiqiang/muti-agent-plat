import type { ContextAssembly, RuntimeBudget, SessionDetail } from '@agent-cluster/shared';

export function estimateTokens(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export type RuntimeInputTokenEstimate = {
  contextTokens: number;
  systemPromptTokens: number;
  schemaTokens: number;
  exampleTokens: number;
  additionalPromptTokens: number;
  totalTokens: number;
};

export type InputTokenEstimationError = {
  estimated: number;
  actual: number;
  ratio: number;
};

export const DEFAULT_INPUT_TOKEN_ESTIMATION_ERROR_THRESHOLD = 0.2;

export function calculateInputTokenEstimationError(
  estimated: number | undefined,
  actual: number | undefined
): InputTokenEstimationError | undefined {
  if (!Number.isFinite(estimated) || (estimated ?? 0) <= 0 || !Number.isFinite(actual) || (actual ?? -1) < 0) {
    return undefined;
  }
  return {
    estimated: estimated as number,
    actual: actual as number,
    ratio: (actual as number) / (estimated as number)
  };
}

export function inputTokenEstimationDrift(
  estimated: number | undefined,
  actual: number | undefined,
  threshold = DEFAULT_INPUT_TOKEN_ESTIMATION_ERROR_THRESHOLD
): InputTokenEstimationError | undefined {
  const estimation = calculateInputTokenEstimationError(estimated, actual);
  if (!estimation || estimation.actual <= 0) return undefined;
  const normalizedThreshold =
    Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : DEFAULT_INPUT_TOKEN_ESTIMATION_ERROR_THRESHOLD;
  return Math.abs(estimation.ratio - 1) > normalizedThreshold ? estimation : undefined;
}

export type InputTokenSafetyMargin = {
  configuredMaxInputTokens?: number;
  effectiveMaxInputTokens?: number;
  safetyMarginTokens: number;
  safetyMarginRatio: number;
};

export function reserveInputTokenSafetyMargin(
  configuredMaxInputTokens: number | undefined,
  safetyMarginRatio: number
): InputTokenSafetyMargin {
  const normalizedRatio = Number.isFinite(safetyMarginRatio)
    ? Math.max(0, Math.min(0.5, safetyMarginRatio))
    : 0.1;
  const normalizedMax =
    Number.isFinite(configuredMaxInputTokens) && (configuredMaxInputTokens ?? 0) > 0
      ? Math.floor(configuredMaxInputTokens as number)
      : undefined;
  if (normalizedMax === undefined) {
    return {
      configuredMaxInputTokens: undefined,
      effectiveMaxInputTokens: undefined,
      safetyMarginTokens: 0,
      safetyMarginRatio: normalizedRatio
    };
  }
  const safetyMarginTokens = Math.min(normalizedMax - 1, Math.ceil(normalizedMax * normalizedRatio));
  return {
    configuredMaxInputTokens: normalizedMax,
    effectiveMaxInputTokens: normalizedMax - safetyMarginTokens,
    safetyMarginTokens,
    safetyMarginRatio: normalizedRatio
  };
}

export function estimateRuntimeInputTokens(input: {
  contextAssembly: ContextAssembly;
  systemPrompt?: string;
  outputSchema?: unknown;
  outputExample?: unknown;
  additionalPromptText?: string[];
}): RuntimeInputTokenEstimate {
  const estimate = {
    contextTokens: estimateTokens(input.contextAssembly),
    systemPromptTokens: input.systemPrompt ? estimateTokens(input.systemPrompt) : 0,
    schemaTokens: input.outputSchema === undefined ? 0 : estimateTokens(input.outputSchema),
    exampleTokens: input.outputExample === undefined ? 0 : estimateTokens(input.outputExample),
    additionalPromptTokens: input.additionalPromptText?.length ? estimateTokens(input.additionalPromptText) : 0,
    totalTokens: 0
  };
  estimate.totalTokens =
    estimate.contextTokens +
    estimate.systemPromptTokens +
    estimate.schemaTokens +
    estimate.exampleTokens +
    estimate.additionalPromptTokens;
  return estimate;
}

export function buildBudget(session: SessionDetail): RuntimeBudget {
  const defaultBudget = Number(process.env.TOKEN_BUDGET_DEFAULT ?? 200_000);
  const total = normalizeBudget(session.tokenBudget ?? defaultBudget);
  return {
    maxInputTokens: Math.floor(total * 0.7),
    maxOutputTokens: Math.floor(total * 0.2),
    maxTotalTokens: total
  };
}

function normalizeBudget(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100_000;
}
