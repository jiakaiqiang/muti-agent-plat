import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimePricingCatalog } from '../apps/server/src/modules/runtimes/runtime-pricing.ts';

const truthy = new Set(['1', 'true', 'yes', 'on']);
const allowedDataScopes = new Set(['synthetic_fixture_only']);

export function buildPhase6LiveModelPreflight({ env = process.env } = {}) {
  const approvalRecorded = present(env.PHASE_6_LIVE_MODEL_APPROVAL_ID);
  const dataScope = env.PHASE_6_LIVE_MODEL_DATA_SCOPE?.trim() || 'missing';
  const dataScopeAllowed = allowedDataScopes.has(dataScope);
  const maxCalls = positiveInteger(env.PHASE_6_LIVE_MODEL_MAX_CALLS);
  const maxCostUsd = positiveNumber(env.PHASE_6_LIVE_MODEL_MAX_COST_USD);
  const providerConfigured = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']
    .every((key) => present(env[key]));
  const providerProtocolAllowed = env.LLM_PROVIDER?.trim() === 'openai-compatible';
  const mockFallbackDisabled = !flag(env.LLM_MOCK_FALLBACK);
  const pricing = pricingStatus(env.AGENT_CLUSTER_RUNTIME_PRICING_JSON, env.PHASE_6_LIVE_MODEL_CONNECTION_ID);

  const gates = [
    gate('live_model_authorization_recorded', approvalRecorded, approvalRecorded
      ? 'a live-model approval record id is configured'
      : 'PHASE_6_LIVE_MODEL_APPROVAL_ID is missing'),
    gate('synthetic_data_scope_only', dataScopeAllowed, dataScopeAllowed
      ? 'the approved data scope is synthetic_fixture_only'
      : 'PHASE_6_LIVE_MODEL_DATA_SCOPE must equal synthetic_fixture_only'),
    gate('provider_connection_configured', providerConfigured, providerConfigured
      ? 'the provider connection fields are configured'
      : 'one or more provider connection fields are missing'),
    gate('provider_protocol_supported', providerProtocolAllowed, providerProtocolAllowed
      ? 'the provider uses the approved OpenAI-compatible protocol'
      : 'LLM_PROVIDER must equal openai-compatible for this evaluation runner'),
    gate('mock_fallback_disabled', mockFallbackDisabled, mockFallbackDisabled
      ? 'mock fallback is disabled'
      : 'LLM_MOCK_FALLBACK must be disabled for real-model evidence'),
    gate('call_limit_configured', maxCalls !== undefined, maxCalls !== undefined
      ? 'a positive maximum call count is configured'
      : 'PHASE_6_LIVE_MODEL_MAX_CALLS must be a positive integer'),
    gate('cost_limit_configured', maxCostUsd !== undefined, maxCostUsd !== undefined
      ? 'a positive USD cost limit is configured'
      : 'PHASE_6_LIVE_MODEL_MAX_COST_USD must be a positive number'),
    gate('exact_pricing_configured', pricing.valid && pricing.matched, pricing.detail)
  ];
  const blockers = gates.filter((item) => item.status === 'blocked').map((item) => item.id);

  return {
    schemaVersion: 'phase-6-live-model-preflight-v1',
    result: blockers.length === 0 ? 'ready' : 'blocked',
    effectiveConfig: {
      approvalConfigured: approvalRecorded,
      dataScope: dataScopeAllowed ? dataScope : 'invalid',
      providerConfigured,
      providerProtocolAllowed,
      mockFallbackDisabled,
      maxCallsConfigured: maxCalls !== undefined,
      maxCostConfigured: maxCostUsd !== undefined,
      runtimePricingConfigured: pricing.configured,
      runtimePricingValid: pricing.valid,
      exactPricingMatched: pricing.matched
    },
    gates,
    blockers
  };
}

function pricingStatus(raw, connectionIdRaw) {
  if (!present(raw)) {
    return {
      configured: false,
      valid: false,
      matched: false,
      detail: 'AGENT_CLUSTER_RUNTIME_PRICING_JSON is missing'
    };
  }
  try {
    const catalog = parseRuntimePricingCatalog(raw);
    const connectionId = connectionIdRaw?.trim();
    if (!connectionId) {
      return {
        configured: true,
        valid: true,
        matched: false,
        detail: 'PHASE_6_LIVE_MODEL_CONNECTION_ID is missing'
      };
    }
    const matched = Boolean(catalog?.entries.some((entry) => entry.connectionId === connectionId));
    return {
      configured: true,
      valid: true,
      matched,
      detail: matched
        ? 'the versioned pricing catalog contains an exact connection match'
        : 'the versioned pricing catalog has no exact connection match'
    };
  } catch {
    return {
      configured: true,
      valid: false,
      matched: false,
      detail: 'AGENT_CLUSTER_RUNTIME_PRICING_JSON is invalid'
    };
  }
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function flag(value) {
  return typeof value === 'string' && truthy.has(value.trim().toLowerCase());
}

function positiveInteger(value) {
  if (!present(value) || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumber(value) {
  if (!present(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function gate(id, passed, detail) {
  return { id, status: passed ? 'passed' : 'blocked', detail };
}

async function main() {
  const report = buildPhase6LiveModelPreflight();
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'ready') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
