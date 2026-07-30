import type { RuntimeError } from '@agent-cluster/shared';

export function localRuntimeError(runtimeError: RuntimeError) {
  return Object.assign(new Error(runtimeError.message), { cause: runtimeError, runtimeError });
}

export function extractLocalRuntimeError(error: unknown): RuntimeError | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { cause?: unknown; runtimeError?: unknown };
  return asRuntimeError(candidate.runtimeError) ?? asRuntimeError(candidate.cause);
}

function asRuntimeError(value: unknown): RuntimeError | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RuntimeError>;
  return typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
    ? candidate as RuntimeError
    : undefined;
}
