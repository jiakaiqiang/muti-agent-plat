import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeOutput } from '@agent-cluster/shared';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

const originalFetch = globalThis.fetch;

const completedOutput: RuntimeOutput = {
  ...runtimeOutputExamples.task_execution_result,
  summary: 'Completed with usage accounting.'
};

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
      // Bulkier than a trivial file so one tool round visibly moves the
      // conversation, and deterministic so it never touches the real filesystem.
      async readFile(rootPath: string, input: { path?: unknown }) {
        return {
          ok: true as const,
          output: `// ${String(input?.path ?? '')}\n${'const line = 1;\n'.repeat(140)}`,
          truncated: false,
          resolvedPath: `${rootPath}/${String(input?.path ?? '')}`,
          byteLength: 2_000
        };
      }
    } as never,
    { resolveServerRoot: () => 'D:/tmp/workspace' } as never
  );
}

const TOOL_CALL = [
  '<<TOOL_CALL>>',
  '{"name":"read_file","input":{"path":"src/main.ts"}}',
  '<<END_TOOL_CALL>>'
].join('\n');

/**
 * Drives one invocation against a stubbed provider. `promptTokensPerRound` is
 * the provider-reported input usage per round — the measurement the estimator
 * error has to be computed against.
 */
async function runInvocation(overrides: {
  responses: string[];
  promptTokensPerRound?: number[];
  budget?: { maxInputTokens: number; maxOutputTokens: number; maxTotalTokens: number };
}) {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    const index = requestBodies.length;
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = index < overrides.responses.length
      ? overrides.responses[index]
      : JSON.stringify(completedOutput);
    const promptTokens = overrides.promptTokensPerRound?.[index] ?? 10;
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 }
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
      invocationId: 'run-token-estimation',
      sessionId: 'session-1',
      phase: 'task_execution',
      agent: { agentId: 'agent-1', key: 'qa', name: 'Quality Agent', role: 'quality', systemPrompt: 'Analyze.' },
      executionTarget: { runtimeType: 'generic_llm', modelId: 'remote:test-model' },
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      toolCatalog: {
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]
      },
      ...(overrides.budget ? { budget: overrides.budget } : {})
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

test('request counting attributes every budget surface the adapter sends', async () => {
  // No tool call: exactly one send, so tool history must be attributed as zero
  // instead of being folded into the remaining surfaces.
  const { result } = await runInvocation({ responses: [] });

  assert.equal(result.status, 'completed');
  const estimation = result.tokenEstimation;
  assert.ok(estimation, 'the run must record a token estimation diagnostic');
  assert.equal(estimation.estimator, 'chars/4', 'the estimator identity must be recorded');

  const breakdown = estimation.breakdown;
  assert.ok(breakdown.systemPromptTokens > 0, 'system prompt must be counted');
  assert.ok(breakdown.toolDefinitionTokens > 0, 'tool definitions must be counted');
  assert.ok(breakdown.contextEnvelopeTokens > 0, 'context envelope evidence must be counted');
  assert.ok(breakdown.expectedOutputTokens > 0, 'expected output/schema must be counted');
  assert.equal(breakdown.toolHistoryTokens, 0, 'a single send carries no tool history');

  const summed =
    breakdown.systemPromptTokens +
    breakdown.toolDefinitionTokens +
    breakdown.contextEnvelopeTokens +
    breakdown.expectedOutputTokens +
    breakdown.toolHistoryTokens;
  assert.ok(
    estimation.estimatedInputTokens >= summed,
    'the recorded estimate must not be smaller than the sum of the attributed surfaces'
  );
  assert.ok(estimation.outputReservationTokens > 0, 'the output/reasoning reservation must be recorded');
  assert.equal(estimation.rounds, 1, 'every counted round must be recorded');
});

test('tool history is attributed on the rounds that actually carry it', async () => {
  const { result } = await runInvocation({ responses: [TOOL_CALL] });

  const estimation = result.tokenEstimation;
  assert.ok(estimation);
  assert.equal(estimation.rounds, 2, 'the tool round must be counted as its own send');
  assert.ok(
    estimation.breakdown.toolHistoryTokens > 0,
    'the tool call/result turns must be attributed rather than folded into the system prompt'
  );
});

test('estimation error is measured against provider-reported usage', async () => {
  const { result } = await runInvocation({
    responses: [TOOL_CALL],
    // The provider reports far more input than chars/4 predicts for this
    // payload, so the error is material and must be surfaced.
    promptTokensPerRound: [900, 1_800]
  });

  assert.equal(result.status, 'completed');
  const estimation = result.tokenEstimation;
  assert.ok(estimation);
  assert.equal(
    estimation.actualInputTokens,
    2_700,
    'the tool loop must accumulate provider usage across rounds instead of discarding it'
  );
  assert.ok(estimation.drift, 'a material estimation error must be recorded');
  assert.equal(estimation.drift.actual, 2_700);
  assert.equal(estimation.drift.estimated, estimation.estimatedInputTokens);
  assert.ok(estimation.drift.ratio > 1.2, 'the drift ratio must come from the provider measurement');
});

test('zero reported usage records no drift instead of a fabricated one', async () => {
  const { result } = await runInvocation({ responses: [TOOL_CALL], promptTokensPerRound: [0, 0] });

  const estimation = result.tokenEstimation;
  assert.ok(estimation);
  assert.equal(estimation.actualInputTokens, 0, 'reported-zero usage stays zero, not undefined');
  assert.equal(estimation.drift, undefined, 'missing usage must not be reported as a measured error');
  assert.equal(estimation.estimator, 'chars/4', 'the estimator identity is recorded even without usage');
});

test('a capacity block still records the estimation diagnostic', async () => {
  const { result } = await runInvocation({
    // First send fits; the tool round pushes the next send past the cap.
    responses: [TOOL_CALL],
    budget: { maxInputTokens: 1_000, maxOutputTokens: 500, maxTotalTokens: 1_500 }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TOKEN_BUDGET_EXCEEDED');
  const estimation = result.tokenEstimation;
  assert.ok(estimation, 'a blocked run must still explain what was counted');
  assert.equal(estimation.estimator, 'chars/4');
  assert.equal(estimation.maxInputTokens, 1_000, 'the configured cap must be recorded');
  assert.ok(estimation.effectiveMaxInputTokens !== undefined, 'the effective cap must be recorded');
  assert.ok(estimation.safetyMarginTokens > 0, 'the safety margin must be recorded');
  assert.ok(estimation.rounds >= 1, 'the rounds already counted must be recorded');
});
