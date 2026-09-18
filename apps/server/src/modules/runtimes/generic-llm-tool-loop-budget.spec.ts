import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2, InvocationPlan, RuntimeOutput } from '@agent-cluster/shared';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

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
      // Deterministic stand-in so the loop never touches the real filesystem.
      // The payload is bulkier than a trivial file so one tool round visibly
      // moves the conversation past the input cap.
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

const completedOutput: RuntimeOutput = {
  ...runtimeOutputExamples.task_execution_result,
  summary: 'Completed within the tool loop.'
};

function runToolLoop(overrides: {
  envelope?: Partial<ContextEnvelopeV2>;
  budget?: InvocationPlan['budget'];
  responses: string[];
}) {
  let requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = requestBodies.length <= overrides.responses.length
      ? overrides.responses[requestBodies.length - 1]
      : JSON.stringify(completedOutput);
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const plan = makeInvocationPlan({
    invocationId: 'run-tool-loop-budget',
    sessionId: 'session-1',
    phase: 'task_execution',
    agent: { agentId: 'agent-1', key: 'qa', name: 'Quality Agent', role: 'quality', systemPrompt: 'Analyze.' },
    executionTarget: { runtimeType: 'generic_llm', modelId: 'remote:test-model' },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    // Non-empty catalog is what routes the invocation into the tool loop at all.
    toolCatalog: {
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]
    },
    ...(overrides.budget ? { budget: overrides.budget } : {}),
    ...(overrides.envelope ? { contextEnvelope: overrides.envelope } : {})
  });
  return { plan, requestBodies };
}

async function runWithToolLoop(overrides: Parameters<typeof runToolLoop>[0]) {
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  const previousStreaming = process.env.LLM_REMOTE_STREAMING;
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_MOCK_FALLBACK = 'false';
  process.env.LLM_REMOTE_STREAMING = 'false';
  try {
    const harness = runToolLoop(overrides);
    const result = await makeService().start(harness.plan).result;
    return { ...harness, result };
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRetries === undefined) delete process.env.LLM_MAX_RETRIES; else process.env.LLM_MAX_RETRIES = previousRetries;
    if (previousFallback === undefined) delete process.env.LLM_MOCK_FALLBACK; else process.env.LLM_MOCK_FALLBACK = previousFallback;
    if (previousStreaming === undefined) delete process.env.LLM_REMOTE_STREAMING; else process.env.LLM_REMOTE_STREAMING = previousStreaming;
  }
}

const TOOL_CALL = [
  '<<TOOL_CALL>>',
  '{"name":"read_file","input":{"path":"src/main.ts"}}',
  '<<END_TOOL_CALL>>'
].join('\n');

test('tool loop counts every round and fails with a clear capacity code when input exceeds budget', async () => {
  const { result, requestBodies } = await runWithToolLoop({
    // The initial request fits; the tool round that follows pushes the conversation
    // past the cap, so the guard must block the NEXT send rather than truncate it.
    budget: { maxInputTokens: 1_000, maxOutputTokens: 500, maxTotalTokens: 1_500 },
    responses: [TOOL_CALL, TOOL_CALL]
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(
    requestBodies.length,
    1,
    'the over-budget round must be blocked before it is sent, not truncated after'
  );
  // User-facing copy stays Chinese: tests/e2e/chinese-visible-copy-smoke.mjs
  // forbids English wording such as "Token budget exceeded" from surfacing.
  assert.match(String(result.error?.message), /输入预算不足/, 'the capacity block must be explained in Chinese');
  const details = result.error?.details as Record<string, unknown> | undefined;
  assert.equal(details?.estimator, 'chars/4', 'the estimator identity must be recorded');
  assert.ok(Number(details?.round ?? 0) >= 1, 'the failing round must be recorded');
  assert.ok(
    typeof details?.estimatedInputTokens === 'number' && typeof details?.maxInputTokens === 'number',
    'estimate and cap must both be recorded'
  );
  assert.ok(
    String(result.error?.message).includes(String(details?.estimatedInputTokens)),
    'the surfaced message must quote the estimate that triggered the block'
  );
});

test('tool loop re-counts after each round and keeps tool calls paired with results', async () => {
  const { result, requestBodies } = await runWithToolLoop({
    responses: [TOOL_CALL]
  });

  assert.equal(result.status, 'completed');
  const toolRound = requestBodies[1];
  assert.ok(toolRound, 'the tool round must be sent');
  const messages = toolRound?.messages as Array<{ role: string; content: string }>;
  const assistant = messages.find((message) => message.role === 'assistant');
  const toolResult = messages.find((message) => message.role === 'user' && message.content.includes('<<TOOL_RESULT'));
  assert.ok(assistant, 'the assistant tool-call turn must be preserved');
  assert.ok(toolResult, 'the tool result turn must be preserved');
  assert.ok(
    toolResult?.content.includes('<<END_TOOL_RESULT>>'),
    'tool results stay paired with their call inside one message'
  );
});

test('older tool output is reference-compacted while the newest call/result pair stays complete', async () => {
  const toolCall = (path: string) => [
    '<<TOOL_CALL>>',
    JSON.stringify({ name: 'read_file', input: { path } }),
    '<<END_TOOL_CALL>>'
  ].join('\n');
  const { result, requestBodies } = await runWithToolLoop({
    responses: [toolCall('src/first.ts'), toolCall('src/second.ts')]
  });

  assert.equal(result.status, 'completed');
  const thirdRequest = requestBodies[2];
  assert.ok(thirdRequest, 'two tool rounds must produce a third provider request');
  const messages = thirdRequest.messages as Array<{ role: string; content: string }>;
  const firstAssistantIndex = messages.findIndex((message) =>
    message.role === 'assistant' && message.content.includes('src/first.ts')
  );
  const secondAssistantIndex = messages.findIndex((message) =>
    message.role === 'assistant' && message.content.includes('src/second.ts')
  );
  assert.ok(firstAssistantIndex >= 0 && secondAssistantIndex > firstAssistantIndex);

  const firstResult = messages[firstAssistantIndex + 1];
  assert.equal(firstResult?.role, 'user', 'the first result remains paired with its assistant tool call');
  assert.match(
    firstResult?.content ?? '',
    /<<TOOL_RESULT_REFERENCE name="read_file" path="src\/first\.ts" sha256="[a-f0-9]{64}" chars="\d+" truncated="false">>/,
    'the older result must preserve path, hash and size metadata'
  );
  assert.doesNotMatch(firstResult?.content ?? '', /const line = 1;/, 'the old file body must not be resent');

  const secondResult = messages[secondAssistantIndex + 1];
  assert.equal(secondResult?.role, 'user', 'the newest result remains paired with its assistant tool call');
  assert.match(secondResult?.content ?? '', /<<TOOL_RESULT name="read_file" path="src\/second\.ts"/);
  assert.match(secondResult?.content ?? '', /const line = 1;/, 'the newest file body stays available to the model');
});
