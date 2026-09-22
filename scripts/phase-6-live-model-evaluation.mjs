import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPhase6LiveModelPreflight } from './phase-6-live-model-preflight.mjs';
import { parseRuntimePricingCatalog, pricingForConnection } from '../apps/server/src/modules/runtimes/runtime-pricing.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvidencePath = resolve(root, '.cache/agent-cluster/phase-6/live-model-evidence.json');
const scenarioCount = 5;
const inputLimit = 4_096;
const outputLimit = 256;

export function buildPhase6LiveModelScenarios() {
  const agent = {
    agentId: '00000000-0000-4000-8000-000000006001',
    key: 'phase-6-evaluator',
    name: 'Phase 6 Synthetic Evaluator',
    role: 'quality',
    systemPrompt: [
      'This is an authorized synthetic evaluation. Use only the supplied synthetic context.',
      'Return the exact required marker in the agent_message content and follow the structured output contract.',
      'Do not infer or request business data.'
    ].join(' ')
  };
  const common = {
    phase: 'discussion',
    agent,
    executionTarget: { runtimeType: 'generic_llm' },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    budget: { maxInputTokens: inputLimit, maxOutputTokens: outputLimit, maxTotalTokens: inputLimit + outputLimit }
  };

  return [
    {
      id: 'early_requirement_recall',
      plan: {
        ...common,
        sessionId: '00000000-0000-4000-8000-000000006011',
        contextEnvelope: {
          L1: { sessionGoal: 'Return the historical confirmed marker EARLY-REQ-ALPHA.', phase: 'discussion' },
          L5: { bullets: ['Synthetic historical confirmed requirement marker: EARLY-REQ-ALPHA.'], turnCount: 1 }
        }
      },
      assess: (content) => content.includes('EARLY-REQ-ALPHA')
    },
    {
      id: 'same_name_ambiguity',
      plan: {
        ...common,
        sessionId: '00000000-0000-4000-8000-000000006012',
        contextEnvelope: {
          L1: {
            sessionGoal: 'Two synthetic WorkItems share the name Export. Return CLARIFICATION_REQUIRED instead of choosing one.',
            phase: 'discussion'
          },
          L5: { bullets: ['Export A is active.', 'Export B is active.', 'No disambiguating identifier was supplied.'], turnCount: 2 }
        }
      },
      assess: (content) => content.includes('CLARIFICATION_REQUIRED')
    },
    {
      id: 'revised_constraint',
      plan: {
        ...common,
        sessionId: '00000000-0000-4000-8000-000000006013',
        contextEnvelope: {
          L1: { sessionGoal: 'Return ACTIVE_FORMAT_JSON only. Do not repeat superseded formats.', phase: 'discussion' },
          L5: {
            bullets: ['Revision 1 requested CSV and is superseded.', 'Revision 2 is confirmed: active format marker ACTIVE_FORMAT_JSON.'],
            turnCount: 2
          }
        }
      },
      assess: (content) => content.includes('ACTIVE_FORMAT_JSON') && !content.includes('CSV')
    },
    {
      id: 'cache_cold',
      plan: {
        ...common,
        sessionId: '00000000-0000-4000-8000-000000006014',
        contextEnvelope: {
          L1: { sessionGoal: 'Return CACHE-PROBE-OMEGA only.', phase: 'discussion' },
          L5: { bullets: ['Synthetic cache marker: CACHE-PROBE-OMEGA.'], turnCount: 1 }
        }
      },
      assess: (content) => content.includes('CACHE-PROBE-OMEGA')
    },
    {
      id: 'cache_hot',
      plan: {
        ...common,
        sessionId: '00000000-0000-4000-8000-000000006014',
        contextEnvelope: {
          L1: { sessionGoal: 'Return CACHE-PROBE-OMEGA only.', phase: 'discussion' },
          L5: { bullets: ['Synthetic cache marker: CACHE-PROBE-OMEGA.'], turnCount: 1 }
        }
      },
      assess: (content) => content.includes('CACHE-PROBE-OMEGA')
    }
  ];
}

export function calculateWorstCaseCost({ pricing, calls = scenarioCount, maxInputTokens = inputLimit, maxOutputTokens = outputLimit }) {
  const promptRate = Math.max(pricing.inputPerMillion, pricing.cacheReadInputPerMillion ?? 0);
  const cacheWriteRate = pricing.cacheWriteInputPerMillion ?? 0;
  const perCall = (maxInputTokens * (promptRate + cacheWriteRate) + maxOutputTokens * pricing.outputPerMillion) / 1_000_000;
  return { calls, maxInputTokens, maxOutputTokens, perCall, total: perCall * calls };
}

export function buildPhase6LiveModelEvidence({ startedAt, completedAt, worstCase, results, providerRequestCount }) {
  const completed = results.filter((item) => item.status === 'completed');
  const totalCostUsd = completed.reduce((sum, item) => sum + item.usage.cost, 0);
  const totalInputTokens = completed.reduce((sum, item) => sum + item.usage.inputTokens, 0);
  const totalOutputTokens = completed.reduce((sum, item) => sum + item.usage.outputTokens, 0);
  const cacheReadTokens = sumReportedTokens(completed, 'cacheReadInputTokens');
  const cacheWriteTokens = sumReportedTokens(completed, 'cacheWriteInputTokens');
  const ttftValues = completed.map((item) => item.streamMetrics.firstFrameLatencyMs).filter(Number.isFinite);
  const durationValues = completed.map((item) => item.streamMetrics.durationMs).filter(Number.isFinite);
  const passed = completed.filter((item) => item.assessmentPassed).length;
  return {
    schemaVersion: 'phase-6-live-model-evidence-v1',
    status: results.length === scenarioCount && results.every((item) => item.status === 'completed') ? 'completed' : 'failed',
    dataScope: 'synthetic_fixture_only',
    authorizationConfigured: true,
    startedAt,
    completedAt,
    providerRequestCount,
    scenarioCount,
    worstCaseCostUsd: roundMoney(worstCase.total),
    aggregate: {
      completedCalls: completed.length,
      failedCalls: scenarioCount - completed.length,
      failureRate: (scenarioCount - completed.length) / scenarioCount,
      qualityPassed: passed,
      qualityTotal: scenarioCount,
      totalInputTokens,
      totalOutputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalCostUsd: roundMoney(totalCostUsd),
      averageTtftMs: average(ttftValues),
      averageDurationMs: average(durationValues)
    },
    indexPreparation: {
      status: 'not_applicable',
      durationMs: null,
      reason: 'The approved fixture is synthetic and does not read or build a workspace index.'
    },
    scenarios: results
  };
}

export async function runPhase6LiveModelEvaluation({ env = process.env, evidencePath = env.PHASE_6_LIVE_MODEL_EVIDENCE_PATH || defaultEvidencePath } = {}) {
  const preflight = buildPhase6LiveModelPreflight({ env });
  if (preflight.result !== 'ready') return { result: 'blocked', preflight };

  const scenarios = buildPhase6LiveModelScenarios();
  const maxCalls = parsePositiveInteger(env.PHASE_6_LIVE_MODEL_MAX_CALLS);
  const maxCostUsd = parsePositiveNumber(env.PHASE_6_LIVE_MODEL_MAX_COST_USD);
  if (maxCalls < scenarios.length) return blocked('approved_call_limit_below_required_scenarios');

  const catalog = parseRuntimePricingCatalog(env.AGENT_CLUSTER_RUNTIME_PRICING_JSON);
  const configuredConnectionId = env.PHASE_6_LIVE_MODEL_CONNECTION_ID.trim();
  if (configuredConnectionId !== expectedConnectionId(env)) return blocked('approved_connection_does_not_match_provider');
  const pricing = pricingForConnection(catalog, configuredConnectionId);
  if (!pricing) return blocked('exact_pricing_unavailable');
  const worstCase = calculateWorstCaseCost({ pricing, calls: scenarios.length });
  if (worstCase.total > maxCostUsd) return blocked('worst_case_cost_exceeds_approved_limit', {
    approvedMaxCostUsd: maxCostUsd,
    worstCaseCostUsd: roundMoney(worstCase.total)
  });

  const isolatedStatePath = resolve(root, '.cache/agent-cluster/phase-6', `live-model-state-${randomUUID()}.json`);
  const previous = applyEvaluationEnvironment(env, isolatedStatePath);
  const originalFetch = globalThis.fetch;
  let providerRequestCount = 0;
  let application;
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    await mkdir(dirname(isolatedStatePath), { recursive: true });
    await writeFile(isolatedStatePath, JSON.stringify({
      systemDataMetadata: {
        dataSchemaVersion: 3,
        dataEpoch: randomUUID(),
        pipelineVersion: 'v2',
        cutoverAt: startedAt,
        cutoverAuditId: `phase-6-evaluation:${randomUUID()}`
      }
    }), 'utf8');
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const allowedBase = env.LLM_BASE_URL.trim().replace(/\/$/, '');
      if (!url.startsWith(`${allowedBase}/`)) throw evaluationError('unexpected_outbound_request');
      if (url === `${allowedBase}/chat/completions`) {
        providerRequestCount += 1;
        if (providerRequestCount > maxCalls) throw evaluationError('approved_call_limit_exceeded');
      } else if (url !== `${allowedBase}/models`) {
        throw evaluationError('unexpected_provider_endpoint');
      }
      return originalFetch(input, { ...init, redirect: 'error' });
    };

    const [{ Module }, { NestFactory }, { PersistenceModule }, { LocalRuntimeModule }, { RuntimeModule }, { RuntimeService }, { RuntimeModelConfigService }, { makeInvocationPlan }] = await Promise.all([
      import('@nestjs/common'),
      import('@nestjs/core'),
      import('../apps/server/dist/apps/server/src/modules/persistence/persistence.module.js'),
      import('../apps/server/dist/apps/server/src/modules/local-runtime/local-runtime.module.js'),
      import('../apps/server/dist/apps/server/src/modules/runtimes/runtime.module.js'),
      import('../apps/server/dist/apps/server/src/modules/runtimes/runtime.service.js'),
      import('../apps/server/dist/apps/server/src/modules/runtimes/runtime-model-config.service.js'),
      import('../apps/server/dist/apps/server/src/modules/runtimes/invocation-plan.fixture.js')
    ]);
    class Phase6EvaluationModule {}
    Module({ imports: [PersistenceModule, LocalRuntimeModule, RuntimeModule] })(Phase6EvaluationModule);
    application = await NestFactory.createApplicationContext(Phase6EvaluationModule, { logger: false, abortOnError: false });
    const runtime = application.get(RuntimeService);
    const modelConfig = application.get(RuntimeModelConfigService);
    const connection = modelConfig.currentConnection();
    if (connection.id !== configuredConnectionId || connection.pricing?.priceVersion !== pricing.priceVersion) {
      throw evaluationError('selected_connection_does_not_match_approved_pricing');
    }

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const invocationId = `00000000-0000-4000-8000-${String(6020 + index).padStart(12, '0')}`;
      const plan = makeInvocationPlan({ ...scenario.plan, invocationId, executionTarget: {
        ...scenario.plan.executionTarget,
        modelId: connection.id
      } });
      const result = await runtime.run(plan);
      if (result.status !== 'completed' || result.output.kind !== 'agent_message') {
        throw evaluationError('runtime_call_failed', result.error?.code);
      }
      assertReportableUsage(result.usage, pricing.priceVersion);
      if (!result.streamMetrics || result.streamMetrics.firstFrameLatencyMs === undefined) {
        throw evaluationError('stream_metrics_missing');
      }
      const content = result.output.content;
      results.push({
        id: scenario.id,
        status: 'completed',
        assessmentPassed: scenario.assess(content),
        outputHash: createHash('sha256').update(content).digest('hex'),
        usage: sanitizeUsage(result.usage),
        streamMetrics: sanitizeStreamMetrics(result.streamMetrics)
      });
      const spent = results.reduce((sum, item) => sum + item.usage.cost, 0);
      if (spent > maxCostUsd) throw evaluationError('observed_cost_exceeds_approved_limit');
    }

    const evidence = buildPhase6LiveModelEvidence({
      startedAt,
      completedAt: new Date().toISOString(),
      worstCase,
      results,
      providerRequestCount
    });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return { result: 'completed', evidencePath, evidence };
  } catch (error) {
    const evidence = buildPhase6LiveModelEvidence({
      startedAt,
      completedAt: new Date().toISOString(),
      worstCase,
      results,
      providerRequestCount
    });
    evidence.status = 'failed';
    evidence.aggregate.costComplete = false;
    evidence.failureCode = safeFailureCode(error);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return { result: 'failed', evidencePath, evidence };
  } finally {
    globalThis.fetch = originalFetch;
    await application?.close().catch(() => undefined);
    await rm(isolatedStatePath, { force: true }).catch(() => undefined);
    restoreEnvironment(previous);
  }
}

function applyEvaluationEnvironment(env, isolatedStatePath) {
  const values = {
    AGENT_CLUSTER_PERSISTENCE: 'true',
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_DATA_FILE: isolatedStatePath,
    ENABLE_BULLMQ: 'false',
    LLM_PROVIDER: env.LLM_PROVIDER,
    LLM_BASE_URL: env.LLM_BASE_URL,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_MODEL: env.LLM_MODEL,
    LLM_MOCK_FALLBACK: 'false',
    LLM_MAX_RETRIES: '0',
    LLM_SCHEMA_REPAIR_ATTEMPTS: '0',
    LLM_REMOTE_STREAMING: 'true',
    LLM_STRUCTURED_OUTPUT_MODE: 'json_object',
    LLM_REMOTE_MAX_OUTPUT_TOKENS: String(outputLimit),
    AGENT_CLUSTER_RUNTIME_PRICING_JSON: env.AGENT_CLUSTER_RUNTIME_PRICING_JSON
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return previous;
}

function restoreEnvironment(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertReportableUsage(usage, priceVersion) {
  if (usage?.measurement !== 'actual') throw evaluationError('provider_usage_missing');
  if (!Number.isFinite(usage.cost) || usage.cost < 0) throw evaluationError('provider_cost_missing');
  if (usage.priceVersion !== priceVersion || usage.costBasis !== 'estimated') {
    throw evaluationError('price_version_mismatch');
  }
}

function sanitizeUsage(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    cost: roundMoney(usage.cost),
    priceVersion: usage.priceVersion,
    costBasis: usage.costBasis,
    measurement: usage.measurement
  };
}

function sanitizeStreamMetrics(metrics) {
  return {
    durationMs: metrics.durationMs,
    frameCount: metrics.frameCount,
    firstFrameLatencyMs: metrics.firstFrameLatencyMs,
    maxInterFrameGapMs: metrics.maxInterFrameGapMs
  };
}

function blocked(reason, detail = {}) {
  return { result: 'blocked', reason, ...detail };
}

function evaluationError(code, providerCode) {
  return Object.assign(new Error(code), { evaluationCode: code, providerCode });
}

function safeFailureCode(error) {
  if (typeof error?.evaluationCode === 'string') return error.evaluationCode;
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return 'module_not_found';
  if (error?.code === 'MODULE_NOT_FOUND') return 'module_not_found';
  if (error?.name === 'TypeError') return 'type_error';
  if (error?.name === 'Error') return 'runtime_error';
  if (typeof error?.constructor?.name === 'string' && error.constructor.name !== 'Object') {
    return `evaluation_${error.constructor.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
  }
  return 'evaluation_failed';
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function expectedConnectionId(env) {
  const slug = (value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `remote:${env.LLM_PROVIDER}:server:${slug(env.LLM_BASE_URL.replace(/\/$/, ''))}:${slug(env.LLM_MODEL)}`;
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sumReportedTokens(results, field) {
  return results.length && results.every((item) => Number.isFinite(item.usage[field]))
    ? results.reduce((sum, item) => sum + item.usage[field], 0)
    : null;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

async function main() {
  const outcome = await runPhase6LiveModelEvaluation();
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.result === 'blocked') process.exitCode = 2;
  else if (outcome.result !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(JSON.stringify({ result: 'failed', reason: safeFailureCode(error) }));
    process.exitCode = 1;
  });
}
