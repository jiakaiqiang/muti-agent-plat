import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ExpectedRuntimeOutput, InvocationPlan, RuntimeOutput } from '@agent-cluster/shared';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

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
    {} as never,
    { resolveServerRoot: () => 'D:/tmp/workspace' } as never
  );
}

test('Generic LLM preflight accepts a complete selected model configuration', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  try {
    assert.deepEqual(await makeServiceWithCurrentFetch().checkAvailability(), { available: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Generic LLM reports the configured hard structured-output limit', () => {
  const previous = process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS;
  process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS = '3072';
  try {
    assert.equal(makeServiceWithCurrentFetch().maxStructuredOutputTokens({ modelId: 'remote:test-model' }), 3_072);
  } finally {
    if (previous === undefined) delete process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS;
    else process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS = previous;
  }
});

test('Generic LLM preflight rejects an incomplete selected model configuration', async () => {
  const service = new GenericLlmRuntimeService(
    {} as never,
    {
      connectionForModelId() {
        return { id: 'remote:missing', model: '', baseUrl: '', apiKey: '', kind: 'remote' };
      }
    } as never,
    {} as never,
    { resolveServerRoot: () => undefined } as never
  );
  const result = await service.checkAvailability();
  assert.equal(result.available, false);
  assert.match(result.reason ?? '', /model|baseUrl|apiKey/i);
});

test('Generic LLM rejects an Anthropic-compatible connection before any outbound request', async () => {
  let requested = false;
  globalThis.fetch = (async () => {
    requested = true;
    return new Response('', { status: 200 });
  }) as typeof fetch;
  try {
    const service = new GenericLlmRuntimeService(
      {} as never,
      {
        connectionForModelId() {
          return {
            id: 'anthropic:test',
            model: 'claude-model',
            baseUrl: 'https://anthropic.test',
            apiKey: 'test-key',
            kind: 'remote',
            provider: 'anthropic-compatible',
            credentialLocation: 'server'
          };
        }
      } as never,
      {} as never,
      { resolveServerRoot: () => undefined } as never
    );
    const result = await service.checkAvailability();
    assert.equal(result.available, false);
    assert.match(result.reason ?? '', /incompatible/i);
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Generic LLM preflight rejects provider rate limiting before Agent fan-out', async () => {
  globalThis.fetch = async () => new Response('', { status: 429 });
  try {
    const result = await makeServiceWithCurrentFetch().checkAvailability();
    assert.equal(result.available, false);
    assert.match(result.reason ?? '', /HTTP 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Generic LLM preflight tolerates gateways without a models endpoint', async () => {
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    assert.deepEqual(await makeServiceWithCurrentFetch().checkAvailability(), { available: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeInput(kind: ExpectedRuntimeOutput['kind']): InvocationPlan {
  return makeInvocationPlan({
    invocationId: `run-${kind}`,
    sessionId: 'session-1',
    phase: 'discussion',
    agent: {
      agentId: 'agent-1',
      key: 'qa',
      name: 'Quality Agent',
      role: 'quality',
      systemPrompt: 'Analyze requirements.'
    },
    executionTarget: { runtimeType: 'generic_llm', modelId: 'remote:test-model' },
    contextEnvelope: { L1: { sessionGoal: 'Analyze the project requirement.', phase: 'discussion' } },
    expectedOutput: { kind, schemaVersion: '1.0' },
    budget: { maxOutputTokens: 500 }
  });
}

async function runWithResponse(kind: ExpectedRuntimeOutput['kind'], responseBody: unknown) {
  return runWithService(kind, () => makeService(responseBody));
}

async function runWithFetch(kind: ExpectedRuntimeOutput['kind'], fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl;
  return runWithService(kind, makeServiceWithCurrentFetch);
}

async function runWithService(
  kind: ExpectedRuntimeOutput['kind'],
  makeRuntime: () => GenericLlmRuntimeService,
  configureInput?: (input: InvocationPlan) => void
) {
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  const previousStructuredOutputMode = process.env.LLM_STRUCTURED_OUTPUT_MODE;
  const previousSchemaRepairAttempts = process.env.LLM_SCHEMA_REPAIR_ATTEMPTS;
  const previousRemoteMaxOutputTokens = process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS;
  const previousRemoteStreaming = process.env.LLM_REMOTE_STREAMING;
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_MOCK_FALLBACK = 'false';
  process.env.LLM_STRUCTURED_OUTPUT_MODE = 'auto';
  process.env.LLM_SCHEMA_REPAIR_ATTEMPTS = '1';
  process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS = process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS ?? '4096';
  process.env.LLM_REMOTE_STREAMING = 'true';
  try {
    const input = makeInput(kind);
    configureInput?.(input);
    return await makeRuntime().start(input).result;
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
    if (previousStructuredOutputMode === undefined) {
      delete process.env.LLM_STRUCTURED_OUTPUT_MODE;
    } else {
      process.env.LLM_STRUCTURED_OUTPUT_MODE = previousStructuredOutputMode;
    }
    if (previousSchemaRepairAttempts === undefined) {
      delete process.env.LLM_SCHEMA_REPAIR_ATTEMPTS;
    } else {
      process.env.LLM_SCHEMA_REPAIR_ATTEMPTS = previousSchemaRepairAttempts;
    }
    if (previousRemoteMaxOutputTokens === undefined) {
      delete process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS;
    } else {
      process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS = previousRemoteMaxOutputTokens;
    }
    if (previousRemoteStreaming === undefined) {
      delete process.env.LLM_REMOTE_STREAMING;
    } else {
      process.env.LLM_REMOTE_STREAMING = previousRemoteStreaming;
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

function completedTaskExecutionContent(summary = 'Completed the requested analysis.') {
  return chatContent(
    JSON.stringify({
      ...runtimeOutputExamples.task_execution_result,
      summary,
      completedItems: ['Analyzed the requirement.']
    })
  );
}

function loadJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

test('requests strict json_schema output for remote models in auto mode', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await runWithFetch('task_execution_result', (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(completedTaskExecutionContent()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'completed');
  const responseFormat = requestBody?.response_format as Record<string, unknown> | undefined;
  assert.equal(responseFormat?.type, 'json_schema');
  const jsonSchema = responseFormat?.json_schema as Record<string, unknown> | undefined;
  assert.equal(jsonSchema?.name, 'runtime_output_task_execution_result');
  const schema = jsonSchema?.schema as { properties?: { kind?: { const?: string } } } | undefined;
  assert.equal(schema?.properties?.kind?.const, 'task_execution_result');
  assert.equal(requestBody?.stream, true);
  assert.equal(requestBody?.max_tokens, 500);
});

test('rejects legacy GLM Artifacts instead of normalizing them', async () => {
  let requestCount = 0;
  const result = await runWithFetch('task_execution_result', (async () => {
    requestCount += 1;
    return new Response(
      JSON.stringify(
        chatContent(
          JSON.stringify({
            kind: 'task_execution_result',
            status: 'completed',
            summary: 'Architecture analysis completed.',
            completedItems: ['Analyzed architecture.'],
            changedArtifacts: [
              {
                type: 'architecture_analysis',
                title: '项目架构分析报告',
                metadata: {
                  content: '# 项目架构\n\n旧格式正文',
                  reportKind: 'project_architecture_analysis'
                }
              }
            ],
            nextSuggestedActions: [],
            risks: []
          })
        )
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(requestCount, 2);
});

test('preserves traceable workspace-context actions from Post Review output', async () => {
  const actions = [
    {
      action: 'request_workspace_context' as const,
      reason: 'Review needs the implementation source before it can verify completion.',
      missingPaths: ['src/feature.ts']
    }
  ];
  const result = await runWithResponse(
    'post_review_report',
    chatContent(
      JSON.stringify({
        schemaVersion: '1.0',
        kind: 'post_review_report',
        isConsistentWithBrief: false,
        matchedItems: [],
        mismatchedItems: [],
        missingItems: ['Missing source evidence for src/feature.ts.'],
        outOfScopeChanges: [],
        testResults: [],
        recommendation: 'ask_user',
        actions
      })
    )
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'post_review_report');
  if (result.output.kind !== 'post_review_report') return;
  assert.deepEqual(result.output.actions, actions);
});

test('rejects the captured GLM architecture Artifact anomaly fixture', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    loadJsonFixture('glm-architecture-artifact-anomaly.json')
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('caps remote max_tokens by LLM_REMOTE_MAX_OUTPUT_TOKENS', async () => {
  process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS = '128';
  let requestBody: Record<string, unknown> | undefined;
  const result = await runWithFetch('task_execution_result', (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(completedTaskExecutionContent()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'completed');
  assert.equal(requestBody?.max_tokens, 128);
});

test('aggregates OpenAI-compatible streaming chunks before runtime output parsing', async () => {
  const encoder = new TextEncoder();
  let requestBody: Record<string, unknown> | undefined;
  const serialized = JSON.stringify({
    ...runtimeOutputExamples.task_execution_result,
    summary: 'Streamed output'
  });
  const splitAt = Math.floor(serialized.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: serialized.slice(0, splitAt) } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: serialized.slice(splitAt) } }] })}\n\n`,
            'data: [DONE]\n\n'
          ].join('')
        )
      );
      controller.close();
    }
  });

  const result = await runWithFetch('task_execution_result', (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as typeof fetch);

  assert.equal(requestBody?.stream, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.summary, 'Streamed output');
});

test('falls back to json_object when the gateway rejects json_schema', async () => {
  const responseFormats: string[] = [];
  let requestCount = 0;
  const result = await runWithFetch('task_execution_result', (async (_url, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
    responseFormats.push(body.response_format?.type ?? 'missing');
    if (requestCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'response_format json_schema is not supported' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(completedTaskExecutionContent()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'completed');
  assert.equal(requestCount, 2);
  assert.deepEqual(responseFormats, ['json_schema', 'json_object']);
});

test('repairs an invalid RuntimeOutput once with a compact schema repair request', async () => {
  let requestCount = 0;
  const requestBodies: Array<{ messages?: Array<{ content?: string }> }> = [];
  const result = await runWithFetch('task_execution_result', (async (_url, init) => {
    requestCount += 1;
    requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> });
    const response =
      requestCount === 1
        ? chatContent(
            JSON.stringify({
              kind: 'task_brief',
              goal: 'Produce a requirement and implementation plan.',
              scope: [],
              outOfScope: [],
              constraints: [],
              acceptanceCriteria: [],
              risks: [],
              openQuestions: [],
              suggestedTasks: []
            })
          )
        : completedTaskExecutionContent('Repaired into the requested runtime output.');
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.summary, 'Repaired into the requested runtime output.');
  assert.equal(requestCount, 2);
  assert.match(requestBodies[1]?.messages?.map((message) => message.content).join('\n') ?? '', /schema repair/i);
  assert.deepEqual(result.usage, {
    inputTokens: 2,
    outputTokens: 2,
    totalTokens: 4,
    model: 'test-model'
  });
});

test('reports sanitized schema diagnostics after the repair attempt fails', async () => {
  let requestCount = 0;
  const invalidContent = JSON.stringify({
    kind: 'task_brief',
    goal: 'Authorization: Bearer sk-super-secret',
    apiKey: 'sk-another-secret',
    scope: []
  });
  const result = await runWithFetch('task_execution_result', (async () => {
    requestCount += 1;
    return new Response(JSON.stringify(chatContent(invalidContent)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(requestCount, 2);
  assert.equal(result.error?.details?.detectedKind, 'task_brief');
  assert.equal(result.error?.details?.parseState, 'wrong_kind');
  assert.equal(result.error?.details?.repairAttempts, 1);
  assert.equal(result.error?.details?.contentLength, invalidContent.length);
  assert.match(String(result.error?.details?.contentHash), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(String(result.error?.details?.sanitizedPreview), /sk-super-secret|sk-another-secret/);
  assert.match(String(result.error?.details?.sanitizedPreview), /\[REDACTED\]/);
  assert.match(result.error?.message ?? '', /Expected task_execution_result, detected task_brief/);
});

test('returns RUNTIME_OUTPUT_CONTRACT_VIOLATION when Artifact schema repair still fails', async () => {
  let requestCount = 0;
  const invalidArtifactOutput = chatContent(
    JSON.stringify({
      kind: 'task_execution_result',
      status: 'completed',
      summary: 'Claims success with an invalid Artifact.',
      completedItems: ['Generated a report.'],
      changedArtifacts: [
        { type: 'mystery_report', title: 'Unknown report', content: 'Unsupported Artifact type.' }
      ],
      nextSuggestedActions: [],
      risks: []
    })
  );
  const result = await runWithFetch('task_execution_result', (async () => {
    requestCount += 1;
    return new Response(JSON.stringify(invalidArtifactOutput), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  assert.equal(requestCount, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(result.error?.details?.parseState, 'schema_invalid');
  assert.equal(result.error?.details?.repairAttempts, 1);
  assert.match(
    JSON.stringify(result.error?.details?.validationErrors ?? []),
    /changedArtifacts|enum|type/
  );
});

test('rejects plain text discussion output instead of wrapping it', async () => {
  const result = await runWithResponse('agent_message', chatContent('需求分析可以继续，但需要先补齐验收标准。'));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects missing-kind agent_message JSON', async () => {
  const result = await runWithResponse(
    'agent_message',
    chatContent(JSON.stringify({ messageKind: 'risk', content: '当前需求缺少异常路径说明。' }))
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects missing-kind task_execution_result JSON', async () => {
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

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects non-canonical status in explicit-kind task_execution_result JSON', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        kind: 'task_execution_result',
        status: 'success',
        summary: '已完成项目架构与技术栈分析。'
      })
    )
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects missing status in explicit-kind task_execution_result JSON', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        kind: 'task_execution_result',
        summary: '已完成项目架构与技术栈分析。'
      })
    )
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('keeps canonical non-completed status in explicit-kind task_execution_result JSON', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        ...runtimeOutputExamples.task_execution_result,
        status: 'blocked',
        summary: '缺少可验证的需求证据。'
      })
    )
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'blocked');
});

test('rejects raw control characters instead of repairing legacy JSON', async () => {
  const rawJson = JSON.stringify({
    ...runtimeOutputExamples.task_execution_result,
    summary: '第一段分析结论。__RAW_CONTROL__第二段包含制表符与换行。'
  }).replace('__RAW_CONTROL__', '\n\t');
  const result = await runWithResponse('task_execution_result', chatContent(rawJson));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects control-char JSON even when it contains escaped quotes', async () => {
  const rawJson = JSON.stringify({
    ...runtimeOutputExamples.task_execution_result,
    summary: '引用 " 之后__RAW_NEWLINE__仍在字符串内'
  }).replace('__RAW_NEWLINE__', '\n');
  const result = await runWithResponse('task_execution_result', chatContent(rawJson));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
});

test('rejects fenced and prose-surrounded JSON instead of extracting a local candidate', async () => {
  const valid = JSON.stringify(runtimeOutputExamples.task_execution_result);
  for (const content of [`\`\`\`json\n${valid}\n\`\`\``, `Model result follows:\n${valid}\nEnd result.`]) {
    const result = await runWithResponse('task_execution_result', chatContent(content));
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  }
});

test('rejects model-content result/output/final_output wrappers instead of recursively unwrapping them', async () => {
  const valid = JSON.stringify(runtimeOutputExamples.task_execution_result);
  for (const wrapper of ['result', 'output', 'final_output']) {
    const result = await runWithResponse(
      'task_execution_result',
      chatContent(JSON.stringify({ [wrapper]: valid }))
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  }
});

test('rejects top-level result/output/final_output object wrappers as non-provider contracts', async () => {
  for (const wrapper of ['result', 'output', 'final_output']) {
    const result = await runWithResponse('task_execution_result', {
      [wrapper]: runtimeOutputExamples.task_execution_result
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  }
});

test('does not wrap explicit wrong-kind JSON as agent_message', async () => {
  const wrongKind = {
    schemaVersion: '1.0',
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
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
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
      headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '120' }
    })) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
  assert.match(result.error?.message ?? '', /运行时执行超时/);
  assert.doesNotMatch(result.error?.message ?? '', /<!DOCTYPE html>/i);
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.details?.httpStatus, 524);
  assert.equal(result.error?.details?.providerFailure, true);
  assert.equal(result.error?.details?.stage, 'provider_response');
  assert.equal(result.error?.details?.retryAfterMs, 120_000);
  assert.equal(result.termination?.kind, 'runtime_timeout');
});

test('maps HTTP 401 to a non-retryable model error', async () => {
  const result = await runWithFetch('task_execution_result', (async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid token' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_ERROR');
  assert.match(result.error?.message ?? '', /HTTP 401/);
  assert.equal(result.error?.retryable, false);
  assert.equal(result.error?.details?.httpStatus, 401);
});

test('tool-loop aborts a hung LLM request after LLM_TIMEOUT_MS', async () => {
  const previousTimeout = process.env.LLM_TIMEOUT_MS;
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_TIMEOUT_MS = '80';
  process.env.LLM_MAX_RETRIES = '0';
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
    {} as never,
    { resolveServerRoot: () => 'D:/tmp/workspace' } as never
  );

  const input = makeInput('agent_message');
  input.toolCatalog.tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];

  try {
    const result = await service.start(input).result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
    assert.match(result.error?.message ?? '', /运行时执行超时/);
    assert.equal(result.termination?.kind, 'runtime_timeout');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) {
      delete process.env.LLM_TIMEOUT_MS;
    } else {
      process.env.LLM_TIMEOUT_MS = previousTimeout;
    }
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
});

test('tool-loop retries HTTP 429 provider responses', async () => {
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_MAX_RETRIES = '1';
  process.env.LLM_MOCK_FALLBACK = 'false';
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(completedTaskExecutionContent('Retried after provider rate limit.')), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const service = makeServiceWithCurrentFetch();
  const input = makeInput('task_execution_result');
  input.toolCatalog.tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];

  try {
    const result = await service.start(input).result;

    assert.equal(result.status, 'completed');
    assert.equal(result.output.kind, 'task_execution_result');
    assert.equal(result.output.summary, 'Retried after provider rate limit.');
    assert.equal(requestCount, 2);
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
});

test('tool-loop classifies HTTP 524 provider responses as runtime timeouts', async () => {
  const previousRetries = process.env.LLM_MAX_RETRIES;
  const previousFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_MOCK_FALLBACK = 'false';
  globalThis.fetch = (async () =>
    new Response('<!DOCTYPE html><html><body>Gateway timeout</body></html>', {
      status: 524,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })) as typeof fetch;

  const service = makeServiceWithCurrentFetch();
  const input = makeInput('task_execution_result');
  input.toolCatalog.tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];

  try {
    const result = await service.start(input).result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
    assert.match(result.error?.message ?? '', /运行时执行超时/);
    assert.doesNotMatch(result.error?.message ?? '', /<!DOCTYPE html>/i);
    assert.equal(result.error?.details?.httpStatus, 524);
    assert.equal(result.termination?.kind, 'runtime_timeout');
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
});
