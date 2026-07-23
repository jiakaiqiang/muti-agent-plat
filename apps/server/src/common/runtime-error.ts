import type { RuntimeError } from '@agent-cluster/shared';

const runtimeErrorCodes = new Set<RuntimeError['code']>([
  'RUNTIME_TIMEOUT',
  'RUNTIME_CANCELLED',
  'RUNTIME_INVOCATION_ERROR',
  'MODEL_ERROR',
  'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
  'CAPABILITY_BLOCKED',
  'CONTEXT_INSUFFICIENT',
  'TOKEN_BUDGET_EXCEEDED',
  'UNKNOWN_ERROR'
]);

export function isRuntimeError(value: unknown): value is RuntimeError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeError>;
  return (
    typeof candidate.code === 'string' &&
    runtimeErrorCodes.has(candidate.code as RuntimeError['code']) &&
    typeof candidate.message === 'string' &&
    typeof candidate.retryable === 'boolean'
  );
}

export function extractRuntimeError(error: unknown): RuntimeError | undefined {
  if (isRuntimeError(error)) return error;
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { cause?: unknown; runtimeError?: unknown };
  if (isRuntimeError(candidate.runtimeError)) return candidate.runtimeError;
  return isRuntimeError(candidate.cause) ? candidate.cause : undefined;
}
