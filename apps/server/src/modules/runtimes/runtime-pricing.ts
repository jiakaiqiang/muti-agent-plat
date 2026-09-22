import type { RuntimeModelPricing, RuntimeModelProvider, RuntimeUsage } from '@agent-cluster/shared';

export type RuntimePricingCatalog = {
  priceVersion: string;
  currency: 'USD';
  entries: Array<Omit<RuntimeModelPricing, 'priceVersion' | 'currency'> & { connectionId: string }>;
};

export function parseRuntimePricingCatalog(raw = process.env.AGENT_CLUSTER_RUNTIME_PRICING_JSON): RuntimePricingCatalog | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('RUNTIME_PRICING_CONFIG_INVALID: AGENT_CLUSTER_RUNTIME_PRICING_JSON must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPricing();
  const record = value as Record<string, unknown>;
  if (typeof record.priceVersion !== 'string' || !record.priceVersion.trim() || record.currency !== 'USD' || !Array.isArray(record.entries)) {
    throw invalidPricing();
  }
  const entries = record.entries.map((entry) => parseEntry(entry));
  if (new Set(entries.map((entry) => entry.connectionId)).size !== entries.length) {
    throw new Error('RUNTIME_PRICING_CONFIG_INVALID: connectionId values must be unique.');
  }
  return { priceVersion: record.priceVersion.trim(), currency: 'USD', entries };
}

export function pricingForConnection(
  catalog: RuntimePricingCatalog | undefined,
  connectionId: string
): RuntimeModelPricing | undefined {
  const entry = catalog?.entries.find((candidate) => candidate.connectionId === connectionId);
  if (!entry || !catalog) return undefined;
  const { connectionId: _connectionId, ...rates } = entry;
  return { ...rates, priceVersion: catalog.priceVersion, currency: catalog.currency };
}

export function estimateRuntimeUsageCost(
  provider: RuntimeModelProvider,
  usage: RuntimeUsage,
  pricing: RuntimeModelPricing | undefined
): Pick<RuntimeUsage, 'cost' | 'priceVersion' | 'costBasis'> {
  if (!pricing || usage.measurement !== 'actual') return {};
  const cacheRead = nonNegative(usage.cacheReadInputTokens);
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens);
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const uncachedInput = provider === 'openai-compatible' ? Math.max(0, input - cacheRead) : input;
  const amount = (
    uncachedInput * pricing.inputPerMillion +
    cacheRead * (pricing.cacheReadInputPerMillion ?? pricing.inputPerMillion) +
    cacheWrite * (pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion) +
    output * pricing.outputPerMillion
  ) / 1_000_000;
  return { cost: amount, priceVersion: pricing.priceVersion, costBasis: 'estimated' };
}

function parseEntry(value: unknown): RuntimePricingCatalog['entries'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPricing();
  const record = value as Record<string, unknown>;
  const connectionId = typeof record.connectionId === 'string' ? record.connectionId.trim() : '';
  if (!connectionId) throw invalidPricing();
  return {
    connectionId,
    inputPerMillion: rate(record.inputPerMillion),
    outputPerMillion: rate(record.outputPerMillion),
    ...(record.cacheReadInputPerMillion === undefined ? {} : { cacheReadInputPerMillion: rate(record.cacheReadInputPerMillion) }),
    ...(record.cacheWriteInputPerMillion === undefined ? {} : { cacheWriteInputPerMillion: rate(record.cacheWriteInputPerMillion) })
  };
}

function rate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalidPricing();
  return value;
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function invalidPricing(): Error {
  return new Error('RUNTIME_PRICING_CONFIG_INVALID: expected priceVersion, USD currency, and non-negative per-million rates keyed by connectionId.');
}
