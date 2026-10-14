import type { AgentRunResult, RuntimeError } from './contracts.js';
import { classifyProviderFailure } from './provider-failure.js';

/** Only adapters observing process close may add this evidence. Silence is never a fault. */
export function confirmedRuntimeExit(error: RuntimeError, exitCode: number | null): RuntimeError {
  const provider = classifyProviderFailure(error);
  if (provider.failureClass !== 'unknown' || error.code !== 'MODEL_ERROR' || error.termination ||
      error.details?.structuredOutputGuard || error.details?.providerFailure ||
      /unknown option|unrecognized (?:option|argument)|invalid.*argument|permission denied|\b(?:EACCES|ENOENT)\b/i.test(error.message)) return error;
  return { ...error, retryable: true, details: { ...error.details,
    runtimeFailure: 'process_exit', processExitConfirmed: true, exitCode } };
}

export function canAutomaticallyFailover(result: AgentRunResult): boolean {
  const error = result.error;
  if (result.status === 'cancelled' || result.termination || !error?.retryable || error.termination ||
      error.details?.stopUnconfirmed || error.details?.structuredOutputGuard || error.details?.operationFailure) return false;
  return error.details?.providerFailure === true ||
    (error.code === 'MODEL_ERROR' && error.details?.runtimeFailure === 'process_exit' && error.details?.processExitConfirmed === true);
}
