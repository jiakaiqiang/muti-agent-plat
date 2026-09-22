import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateRuntimeUsageCost, parseRuntimePricingCatalog, pricingForConnection } from './runtime-pricing.js';

test('pricing catalog is versioned and matches an exact connection only', () => {
  const catalog = parseRuntimePricingCatalog(JSON.stringify({
    priceVersion: 'pricing-2026-09-20',
    currency: 'USD',
    entries: [{ connectionId: 'remote:model-a', inputPerMillion: 2, outputPerMillion: 8 }]
  }));
  assert.deepEqual(pricingForConnection(catalog, 'remote:model-a'), {
    priceVersion: 'pricing-2026-09-20', currency: 'USD', inputPerMillion: 2, outputPerMillion: 8
  });
  assert.equal(pricingForConnection(catalog, 'remote:model-b'), undefined);
});

test('invalid, duplicate, or negative pricing fails closed', () => {
  assert.throws(() => parseRuntimePricingCatalog('{'), /RUNTIME_PRICING_CONFIG_INVALID/);
  assert.throws(() => parseRuntimePricingCatalog(JSON.stringify({ priceVersion: 'v1', currency: 'USD', entries: [
    { connectionId: 'same', inputPerMillion: 1, outputPerMillion: 1 },
    { connectionId: 'same', inputPerMillion: 1, outputPerMillion: 1 }
  ] })), /unique/);
  assert.throws(() => parseRuntimePricingCatalog(JSON.stringify({ priceVersion: 'v1', currency: 'USD', entries: [
    { connectionId: 'bad', inputPerMillion: -1, outputPerMillion: 1 }
  ] })), /RUNTIME_PRICING_CONFIG_INVALID/);
});

test('cost uses provider cache semantics and records an estimated price version', () => {
  const pricing = { priceVersion: 'v1', currency: 'USD' as const, inputPerMillion: 2, outputPerMillion: 8, cacheReadInputPerMillion: 0.5 };
  const result = estimateRuntimeUsageCost('openai-compatible', {
    inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000,
    cacheReadInputTokens: 900_000, measurement: 'actual'
  }, pricing);
  assert.deepEqual(result, { cost: 1.45, priceVersion: 'v1', costBasis: 'estimated' });
  assert.deepEqual(estimateRuntimeUsageCost('openai-compatible', {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, measurement: 'unknown'
  }, pricing), {});
});
