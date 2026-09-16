import type { RuntimeError } from './contracts.js';

export type ProviderFailureClass = 'authentication' | 'dns' | 'network' | 'rate_limit' | 'upstream_transient' | 'protocol' | 'schema' | 'unknown';

/** Classification never persists provider response bodies, URLs or credentials. */
export function classifyProviderFailure(error: RuntimeError): { failureClass: ProviderFailureClass; retryable: boolean; retryAfterMs?: number } {
  const details = error.details ?? {};
  const status = Number(details.httpStatus ?? details.status);
  const text = `${error.message} ${details.failureKind ?? ''} ${details.errorName ?? ''} ${details.errorCode ?? ''}`;
  const retryAfter = Number(details.retryAfterMs);
  const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter } : {};
  if (status === 401 || status === 403) return { failureClass: 'authentication', retryable: false };
  if (/format.mismatch|unsupported.protocol|provider_format_mismatch/i.test(text)) return { failureClass: 'protocol', retryable: false };
  if (error.code === 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' || /invalid.*schema|schema.*unsupported/i.test(text)) return { failureClass: 'schema', retryable: false };
  if (/ENOTFOUND|EAI_AGAIN|\bDNS\b/i.test(text)) return { failureClass: 'dns', retryable: true, ...delay };
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(text)) return { failureClass: 'network', retryable: true, ...delay };
  if (status === 429) return { failureClass: 'rate_limit', retryable: true, ...delay };
  if ([408, 500, 502, 503, 504, 524].includes(status)) return { failureClass: 'upstream_transient', retryable: true, ...delay };
  // Nonstandard 424 is not automatically temporary: require a known structured code.
  if (status === 424) return { failureClass: 'upstream_transient',
    retryable: ['UPSTREAM_UNAVAILABLE', 'ACCOUNT_POOL_EXHAUSTED', 'upstream_unavailable', 'account_pool_exhausted'].includes(String(details.errorCode ?? details.errorName)), ...delay };
  return { failureClass: 'unknown', retryable: error.retryable === true && details.providerFailure === true, ...delay };
}

export class ProviderCircuit {
  private readonly failures = new Map<string, { until: number; count: number }>();
  constructor(private readonly now = Date.now) {}
  key(identity: { connectionId: string; modelId: string; protocol: string }) {
    return JSON.stringify([identity.connectionId, identity.modelId, identity.protocol]);
  }
  remaining(key: string) {
    const value = this.failures.get(key);
    if (!value) return 0;
    if (value.until && value.until <= this.now()) { this.failures.delete(key); return 0; }
    return Math.max(0, value.until - this.now());
  }
  failed(key: string, failure: ReturnType<typeof classifyProviderFailure>) {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    const ttl = Math.max(120_000, failure.retryAfterMs ?? 0);
    this.failures.set(key, { count, until: count >= 2 || !failure.retryable ? this.now() + ttl : 0 });
  }
  succeeded(key: string) { this.failures.delete(key); }
}
