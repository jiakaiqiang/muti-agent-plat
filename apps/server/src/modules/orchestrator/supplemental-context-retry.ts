import type { RuntimeContextRequest, RuntimeError } from '@agent-cluster/shared';

const DEFAULT_MAX_RETRIES = 3;
const ENV_VAR = 'AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES';

export function resolveContextInsufficientMaxRetries(): number {
  const raw = process.env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_RETRIES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_RETRIES;
  return Math.floor(parsed);
}

export function canRetryWithSupplementalContext(
  code: RuntimeError['code'] | undefined,
  requestedContext: RuntimeContextRequest | undefined,
  retryCount: number,
  maxRetries: number
): boolean {
  if (code !== 'CONTEXT_INSUFFICIENT') return false;
  if (!requestedContext) return false;
  if (!Number.isFinite(maxRetries) || maxRetries <= 0) return false;
  return retryCount < maxRetries;
}
