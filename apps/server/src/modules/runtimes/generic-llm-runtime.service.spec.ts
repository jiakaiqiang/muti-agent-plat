import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput, ExpectedRuntimeOutput, RuntimeOutput } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';

const originalFetch = globalThis.fetch;

function makeService(responseBody: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

  return makeServiceWithCurrentFetch();
}

function makeServiceWithCurrentFetch() {
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
    {} as never
  );
}

function makeInput(kind: ExpectedRuntimeOutput['kind']): AgentRunInput {
  return {
    runId: `run-${kind}`,
    sessionId: 'session-1',
    phase: 'discussion',
    agent: {
      id: 'agent-1',
      key: 'qa',
      name: 'Quality Agent',
      role: 'quality',
      systemPrompt: 'Analyze requirements.',
      runtimeType: 'generic_llm',
      capabilityIds: []
    },
    contextPack: {
      sessionGoal: 'Analyze the project requirement.',
      taskContext: {
        currentStage: 'discussion'
      },
      summaryMemory: {},
      continuationState: {},
      agentProfile: {},
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets: [],
      artifacts: [],
      capabilities: [],
      constraints: []
    },
    expectedOutput: { kind, schemaVersion: '0.1' },
    budget: { maxOutputTokens: 500 }
  } as unknown as AgentRunInput;
}

async function runWithResponse(kind: ExpectedRuntimeOutput['kind'], responseBody: unknown) {
  return runWithService(kind, () => makeService(responseBody));
}

async function runWithFetch(kind: ExpectedRuntimeOutput['kind'], fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl;
  return runWithService(kind, makeServiceWithCurrentFetch);
}

async function runWithService(kind: ExpectedRuntimeOutput['kind'], makeRuntime: () => GenericLlmRuntimeService) {
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_MOCK_FALLBACK = 'false';
  try {
    return await makeRuntime().run(makeInput(kind));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRetries === undefined) {
      delete process.env.LLM_MAX_RETRIES;
    } else {
      process.env.LLM_MAX_RETRIES = previousRetries;
    }
    if (previousFallback === undefined) {
      delete process.env.LLM_MOCK_FALLBACK;
    } else {
      process.env.LLM_MOCK_FALLBACK = previousFallback;
    }
  }
}

function chatContent(content: unknown) {
  return {
    choices: [
      {
        message: { content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}

test('wraps plain text discussion output as agent_message', async () => {
  const result = await runWithResponse('agent_message', chatContent('需求分析可以继续，但需要先补齐验收标准。'));

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'agent_message');
  assert.equal(result.output.content, '需求分析可以继续，但需要先补齐验收标准。');
});

test('coerces missing-kind agent_message JSON without losing messageKind', async () => {
  const result = await runWithResponse(
    'agent_message',
    chatContent(JSON.stringify({ messageKind: 'risk', content: '当前需求缺少异常路径说明。' }))
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, {
    kind: 'agent_message',
    messageKind: 'risk',
    content: '当前需求缺少异常路径说明。',
    targetAgentIds: undefined,
    targetAgentKeys: undefined,
    mentionedAgentIds: undefined,
    relatedTaskIds: undefined
  });
});

test('coerces missing-kind task_execution_result JSON', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        status: 'blocked',
        summary: '缺少可验证的需求证据。',
        completedItems: ['已检查上下文'],
        nextSuggestedActions: ['请求用户补充截图上下文'],
        risks: ['无法确认真实失败路径']
      })
    )
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'blocked');
  assert.equal(result.output.summary, '缺少可验证的需求证据。');
});

test('does not wrap explicit wrong-kind JSON as agent_message', async () => {
  const wrongKind = {
    kind: 'task_brief',
    goal: 'Wrong output kind',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    suggestedTasks: []
  } satisfies RuntimeOutput;

  const result = await runWithResponse('agent_message', chatContent(JSON.stringify(wrongKind)));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'OUTPUT_SCHEMA_INVALID');
});

test('reports HTML provider responses as model configuration errors', async () => {
  let requestCount = 0;
  const result = await runWithFetch('agent_message', (async () => {
    requestCount += 1;
    return new Response('<!doctype html><html><body>Not Found</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_ERROR');
  assert.match(result.error?.message ?? '', /non-JSON response/);
  assert.match(result.error?.message ?? '', /Base URL/);
  assert.equal(requestCount, 1, 'non-JSON HTML responses should not be retried');
});

test('classifies HTTP 524 provider responses as runtime timeouts without leaking HTML', async () => {
  const result = await runWithFetch('task_execution_result', (async () =>
    new Response('<!DOCTYPE html><html><body>Gateway timeout</body></html>', {
      status: 524,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
  assert.match(result.error?.message ?? '', /HTTP 524/);
  assert.doesNotMatch(result.error?.message ?? '', /<!DOCTYPE html>/i);
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.details?.httpStatus, 524);
});

test('tool-loop aborts a hung LLM request after LLM_TIMEOUT_MS', async () => {
  const previousTimeout = process.env.LLM_TIMEOUT_MS;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_TIMEOUT_MS = '80';
  process.env.LLM_MOCK_FALLBACK = 'false';
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      );
    })) as typeof fetch;

  const service = new GenericLlmRuntimeService(
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
    {} as never
  );

  const input = makeInput('agent_message');
  const contextPack = input.contextPack as Record<string, unknown>;
  contextPack.availableTools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
  contextPack.workingDirectory = { kind: 'server_local', path: 'D:/tmp/workspace' };

  try {
    const result = await service.run(input);

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
    assert.match(result.error?.message ?? '', /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) {
      delete process.env.LLM_TIMEOUT_MS;
    } else {
      process.env.LLM_TIMEOUT_MS = previousTimeout;
    }
    if (previousFallback === undefined) {
      delete process.env.LLM_MOCK_FALLBACK;
    } else {
      process.env.LLM_MOCK_FALLBACK = previousFallback;
    }
  }
});

test('tool-loop classifies HTTP 524 provider responses as runtime timeouts', async () => {
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_MOCK_FALLBACK = 'false';
  globalThis.fetch = (async () =>
    new Response('<!DOCTYPE html><html><body>Gateway timeout</body></html>', {
      status: 524,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })) as typeof fetch;

  const service = makeServiceWithCurrentFetch();
  const input = makeInput('task_execution_result');
  const contextPack = input.contextPack as Record<string, unknown>;
  contextPack.availableTools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
  contextPack.workingDirectory = { kind: 'server_local', path: 'D:/tmp/workspace' };

  try {
    const result = await service.run(input);

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
    assert.match(result.error?.message ?? '', /HTTP 524/);
    assert.doesNotMatch(result.error?.message ?? '', /<!DOCTYPE html>/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousFallback === undefined) {
      delete process.env.LLM_MOCK_FALLBACK;
    } else {
      process.env.LLM_MOCK_FALLBACK = previousFallback;
    }
  }
});
