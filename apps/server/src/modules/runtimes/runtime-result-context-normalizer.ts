import type { AgentRunResult, RuntimeContextRequest } from '@agent-cluster/shared';
import { normalizeRuntimeContextRequest } from './runtime-context-request-normalizer.js';

export function normalizeRuntimeResultContext(result: AgentRunResult): AgentRunResult {
  const error = result.error ? normalizeError(result.error) : undefined;
  return {
    ...result,
    ...(error ? { error } : {})
  };
}

function normalizeError(error: NonNullable<AgentRunResult['error']>) {
  const requestedContext = normalizeOptionalRequest(error.requestedContext);
  const { requestedContext: _discarded, ...rest } = error;
  return {
    ...rest,
    ...(requestedContext ? { requestedContext } : {})
  };
}

function normalizeOptionalRequest(value: unknown): RuntimeContextRequest | undefined {
  return value === undefined || value === null ? undefined : normalizeRuntimeContextRequest(value);
}
