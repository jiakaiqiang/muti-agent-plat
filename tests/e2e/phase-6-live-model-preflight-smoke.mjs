import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhase6LiveModelPreflight } from '../../scripts/phase-6-live-model-preflight.mjs';

const readyEnv = {
  PHASE_6_LIVE_MODEL_APPROVAL_ID: 'approval-private-value',
  PHASE_6_LIVE_MODEL_DATA_SCOPE: 'synthetic_fixture_only',
  PHASE_6_LIVE_MODEL_MAX_CALLS: '4',
  PHASE_6_LIVE_MODEL_MAX_COST_USD: '1.50',
  PHASE_6_LIVE_MODEL_CONNECTION_ID: 'remote:openai-compatible:server:provider-example-v1:model-a',
  LLM_PROVIDER: 'openai-compatible',
  LLM_BASE_URL: 'https://provider.example/v1',
  LLM_API_KEY: 'secret-api-key',
  LLM_MODEL: 'model-a',
  LLM_MOCK_FALLBACK: 'false',
  AGENT_CLUSTER_RUNTIME_PRICING_JSON: JSON.stringify({
    priceVersion: 'pricing-v1',
    currency: 'USD',
    entries: [{
      connectionId: 'remote:openai-compatible:server:provider-example-v1:model-a',
      inputPerMillion: 1,
      outputPerMillion: 2
    }]
  })
};

test('live-model preflight fails closed without approval and spending boundaries', () => {
  const report = buildPhase6LiveModelPreflight({
    env: {
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://provider.example/v1',
      LLM_API_KEY: 'secret-api-key',
      LLM_MODEL: 'model-a'
    }
  });

  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('live_model_authorization_recorded'));
  assert.ok(report.blockers.includes('synthetic_data_scope_only'));
  assert.ok(report.blockers.includes('call_limit_configured'));
  assert.ok(report.blockers.includes('cost_limit_configured'));
  assert.ok(report.blockers.includes('exact_pricing_configured'));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('secret-api-key'), false);
  assert.equal(serialized.includes('provider.example'), false);
  assert.equal(serialized.includes('model-a'), false);
});

test('live-model preflight is ready only with exact pricing and all explicit boundaries', () => {
  const report = buildPhase6LiveModelPreflight({ env: readyEnv });
  assert.equal(report.result, 'ready');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.gates.every((item) => item.status === 'passed'), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('approval-private-value'), false);
  assert.equal(serialized.includes('secret-api-key'), false);
  assert.equal(serialized.includes(readyEnv.PHASE_6_LIVE_MODEL_CONNECTION_ID), false);
  assert.equal(serialized.includes(readyEnv.AGENT_CLUSTER_RUNTIME_PRICING_JSON), false);
});

test('live-model preflight rejects business data, mock fallback, and non-exact pricing', () => {
  const report = buildPhase6LiveModelPreflight({
    env: {
      ...readyEnv,
      PHASE_6_LIVE_MODEL_DATA_SCOPE: 'business_database',
      PHASE_6_LIVE_MODEL_CONNECTION_ID: 'another-connection',
      LLM_MOCK_FALLBACK: 'true'
    }
  });

  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('synthetic_data_scope_only'));
  assert.ok(report.blockers.includes('mock_fallback_disabled'));
  assert.ok(report.blockers.includes('exact_pricing_configured'));
  assert.equal(report.effectiveConfig.dataScope, 'invalid');
});

test('live-model preflight rejects malformed limits and pricing without echoing values', () => {
  const report = buildPhase6LiveModelPreflight({
    env: {
      ...readyEnv,
      PHASE_6_LIVE_MODEL_MAX_CALLS: '1.5',
      PHASE_6_LIVE_MODEL_MAX_COST_USD: '0',
      AGENT_CLUSTER_RUNTIME_PRICING_JSON: '{"apiKey":"must-not-leak"}'
    }
  });

  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('call_limit_configured'));
  assert.ok(report.blockers.includes('cost_limit_configured'));
  assert.ok(report.blockers.includes('exact_pricing_configured'));
  assert.equal(JSON.stringify(report).includes('must-not-leak'), false);
});

test('live-model preflight rejects provider protocols the evaluation runner cannot execute', () => {
  const report = buildPhase6LiveModelPreflight({
    env: { ...readyEnv, LLM_PROVIDER: 'anthropic-compatible' }
  });
  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('provider_protocol_supported'));
});
