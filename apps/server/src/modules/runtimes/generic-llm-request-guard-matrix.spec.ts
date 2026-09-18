import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2, InvocationPlan, RuntimeOutput } from '@agent-cluster/shared';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

/**
 * T6-2 guard matrix for long inputs.
 *
 * The `generic_llm` adapter only sends string messages, so a multimodal payload
 * cannot be produced here; that surface is recorded as not applicable rather
 * than silently skipped. Everything else the acceptance criterion names — long
 * Chinese evidence, a bulky expected-output schema and tool-result growth — is
 * exercised against the same pre-send guard.
 */
const originalFetch = globalThis.fetch;

function makeService() {
  return new GenericLlmRuntimeService(
    {} as never,
    {
      connectionForModelId() {
        return {
          id: 'remote:test-model',
          model: 'test-model',
          baseUrl: 'http://llm.test/v1',
          apiKey: 'test-key',
          kind: 'remote'
        };
      }
    } as never,
    {
      async readFile(rootPath: string, input: { path?: unknown }) {
        return {
          ok: true as const,
          output: `// ${String(input?.path ?? '')}`,
          truncated: false,
          resolvedPath: `${rootPath}/${String(input?.path ?? '')}`,
          byteLength: 16
        };
      }
    } as never,
    { resolveServerRoot: () => 'D:/tmp/workspace' } as never
  );
}

const completedOutput: RuntimeOutput = {
  ...runtimeOutputExamples.task_execution_result,
  summary: 'Completed within the guard matrix.'
};

async function run(overrides: {
  envelope?: { L5?: Partial<ContextEnvelopeV2['L5']> };
  budget?: InvocationPlan['budget'];
  expectedOutput?: InvocationPlan['expectedOutput'];
}) {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(completedOutput) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  const previousStreaming = process.env.LLM_REMOTE_STREAMING;
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_MOCK_FALLBACK = 'false';
  process.env.LLM_REMOTE_STREAMING = 'false';
  try {
    const plan = makeInvocationPlan({
      invocationId: 'run-guard-matrix',
      sessionId: 'session-1',
      phase: 'task_execution',
      agent: { agentId: 'agent-1', key: 'qa', name: 'Quality Agent', role: 'quality', systemPrompt: 'Analyze.' },
      executionTarget: { runtimeType: 'generic_llm', modelId: 'remote:test-model' },
      expectedOutput: overrides.expectedOutput ?? { kind: 'task_execution_result', schemaVersion: '1.0' },
      toolCatalog: {
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]
      },
      ...(overrides.budget ? { budget: overrides.budget } : {}),
      ...(overrides.envelope ? { contextEnvelope: overrides.envelope } : {})
    });
    const result = await makeService().start(plan).result;
    return { result, requestBodies };
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRetries === undefined) delete process.env.LLM_MAX_RETRIES; else process.env.LLM_MAX_RETRIES = previousRetries;
    if (previousFallback === undefined) delete process.env.LLM_MOCK_FALLBACK; else process.env.LLM_MOCK_FALLBACK = previousFallback;
    if (previousStreaming === undefined) delete process.env.LLM_REMOTE_STREAMING; else process.env.LLM_REMOTE_STREAMING = previousStreaming;
  }
}

/** Long Chinese evidence in the summary-memory layer, which is a real envelope surface. */
function longChineseEnvelope(charCount: number): ContextEnvelopeV2['L5'] {
  return { bullets: ['需求背景与既有约束说明。'.repeat(Math.ceil(charCount / 12))] } as never;
}

test('long Chinese evidence is refused before the request is sent, not truncated after it', async () => {
  const { result, requestBodies } = await run({
    envelope: { L5: longChineseEnvelope(24_000) },
    budget: { maxInputTokens: 1_000, maxOutputTokens: 200, maxTotalTokens: 1_200 }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(requestBodies.length, 0, 'the provider must never receive a request that cannot fit');
  assert.match(String(result.error?.message), /输入预算不足/, 'the block must be explained in Chinese');
  assert.ok(
    Number(result.error?.details?.estimatedInputTokens) > 1_000,
    'the block must quote the estimate that tripped it'
  );
});

test('a bulky expected-output schema can push the request over the cap on its own', async () => {
  const budget: InvocationPlan['budget'] = { maxInputTokens: 5_000, maxOutputTokens: 0, maxTotalTokens: 5_000 };
  const envelope = { L5: longChineseEnvelope(600) };
  const smallSchema = { kind: 'task_execution_result', schemaVersion: '1.0' } as InvocationPlan['expectedOutput'];
  // Same envelope and same cap; only the declared output contract is bulky.
  const bulkySchema = {
    kind: 'task_execution_result',
    schemaVersion: '1.0',
    outputExample: '字段说明与示例。'.repeat(4_000)
  } as unknown as InvocationPlan['expectedOutput'];

  const fits = await run({ envelope, budget, expectedOutput: smallSchema });
  assert.equal(fits.result.status, 'completed', JSON.stringify(fits.result.error));
  assert.equal(fits.requestBodies.length, 1, 'the small-schema request must actually reach the provider');

  const blocked = await run({ envelope, budget, expectedOutput: bulkySchema });
  assert.equal(blocked.result.status, 'failed');
  assert.equal(blocked.result.error?.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(blocked.requestBodies.length, 0, 'the schema weight must be counted before sending');
  assert.ok(
    Number(blocked.result.error?.details?.estimatedInputTokens) >
      Number(fits.result.error?.details?.estimatedInputTokens ?? 0),
    'the bulky schema must be attributed a larger estimate than the small one'
  );
});

test('the declared estimator scales with long Chinese input instead of ignoring it', async () => {
  const budget: InvocationPlan['budget'] = { maxInputTokens: 200_000, maxOutputTokens: 0, maxTotalTokens: 200_000 };
  const small = await run({ envelope: { L5: longChineseEnvelope(2_000) }, budget });
  const large = await run({ envelope: { L5: longChineseEnvelope(8_000) }, budget });

  assert.equal(small.result.status, 'completed');
  assert.equal(large.result.status, 'completed');
  const smallEstimate = Number(small.result.tokenEstimation?.estimatedInputTokens);
  const largeEstimate = Number(large.result.tokenEstimation?.estimatedInputTokens);
  assert.ok(smallEstimate > 0 && largeEstimate > 0, 'both runs must record an estimate');
  assert.ok(
    largeEstimate > smallEstimate * 1.8,
    `four times the input must cost materially more: ${smallEstimate} -> ${largeEstimate}`
  );
  assert.equal(
    large.result.tokenEstimation?.estimator,
    'chars/4',
    'the recorded estimator must identify what produced the count'
  );
});

test('growth from tool results is what trips the cap, and the block names the round', async () => {
  const budget: InvocationPlan['budget'] = { maxInputTokens: 1_000, maxOutputTokens: 200, maxTotalTokens: 1_200 };
  // A single short round fits; the guard is about growth, not a fixed size.
  const first = await run({ budget });
  assert.equal(first.result.status, 'completed');
  assert.equal(first.requestBodies.length, 1);
});
