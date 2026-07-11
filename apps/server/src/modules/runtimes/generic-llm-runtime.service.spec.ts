import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

async function runWithService(
  kind: ExpectedRuntimeOutput['kind'],
  makeRuntime: () => GenericLlmRuntimeService,
  configureInput?: (input: AgentRunInput) => void
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
    return await makeRuntime().run(input);
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
      kind: 'task_execution_result',
      status: 'completed',
      summary,
      completedItems: ['Analyzed the requirement.'],
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: []
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

test('normalizes legacy GLM Artifacts before schema validation and orchestration', async () => {
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

  assert.equal(result.status, 'completed');
  assert.equal(requestCount, 1);
  assert.equal(result.output.kind, 'task_execution_result');
  if (result.output.kind !== 'task_execution_result') return;
  assert.deepEqual(result.output.changedArtifacts, [
    {
      type: 'markdown',
      title: '项目架构分析报告',
      content: '# 项目架构\n\n旧格式正文',
      metadata: { reportKind: 'project_architecture_analysis' }
    }
  ]);
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

test('regresses the captured GLM architecture Artifact anomaly fixture', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    loadJsonFixture('glm-architecture-artifact-anomaly.json')
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  if (result.output.kind !== 'task_execution_result') return;
  const report = result.output.changedArtifacts[0];
  assert.equal(report?.type, 'markdown');
  assert.equal(report?.title, '项目架构分析报告');
  assert.match(report?.content ?? '', /# 项目架构分析报告/);
  assert.equal(report?.metadata?.reportKind, 'project_architecture_analysis');
  assert.equal('content' in (report?.metadata ?? {}), false);
});

test('emits token estimation diagnostics when actual GLM input usage exceeds the error threshold', async () => {
  const response = completedTaskExecutionContent();
  response.usage = { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 };
  const result = await runWithService(
    'task_execution_result',
    () => makeService(response),
    (input) => {
      input.estimatedInputTokens = 100;
    }
  );

  const diagnostic = result.events.find((event) => event.metadata?.code === 'TOKEN_ESTIMATION_DRIFT');
  assert.ok(diagnostic);
  assert.deepEqual(
    {
      model: diagnostic.metadata?.model,
      estimated: diagnostic.metadata?.estimated,
      actual: diagnostic.metadata?.actual,
      ratio: diagnostic.metadata?.ratio
    },
    { model: 'test-model', estimated: 100, actual: 150, ratio: 1.5 }
  );
});

test('does not emit token estimation diagnostics within the error threshold', async () => {
  const response = completedTaskExecutionContent();
  response.usage = { prompt_tokens: 110, completion_tokens: 10, total_tokens: 120 };
  const result = await runWithService(
    'task_execution_result',
    () => makeService(response),
    (input) => {
      input.estimatedInputTokens = 100;
    }
  );

  assert.equal(result.events.some((event) => event.metadata?.code === 'TOKEN_ESTIMATION_DRIFT'), false);
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
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            'data: {"choices":[{"delta":{"content":"{\\"kind\\":\\"task_execution_result\\",\\"status\\":\\"completed\\","}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"\\"summary\\":\\"Streamed output\\",\\"changedArtifacts\\":[]}"}}]}\n\n',
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
  assert.equal(result.error?.code, 'OUTPUT_SCHEMA_INVALID');
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

test('returns OUTPUT_SCHEMA_INVALID when Artifact schema repair still fails', async () => {
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
  assert.equal(result.error?.code, 'OUTPUT_SCHEMA_INVALID');
  assert.equal(result.error?.details?.parseState, 'schema_invalid');
  assert.equal(result.error?.details?.repairAttempts, 1);
  assert.match(
    JSON.stringify(result.error?.details?.validationErrors ?? []),
    /changedArtifacts|enum|type/
  );
});

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

test('normalizes non-canonical status in explicit-kind task_execution_result JSON', async () => {
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

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'completed');
  assert.equal(result.output.summary, '已完成项目架构与技术栈分析。');
});

test('defaults missing status in explicit-kind task_execution_result JSON to completed', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        kind: 'task_execution_result',
        summary: '已完成项目架构与技术栈分析。'
      })
    )
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'completed');
});

test('keeps canonical non-completed status in explicit-kind task_execution_result JSON', async () => {
  const result = await runWithResponse(
    'task_execution_result',
    chatContent(
      JSON.stringify({
        kind: 'task_execution_result',
        status: 'blocked',
        summary: '缺少可验证的需求证据。'
      })
    )
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'blocked');
});

test('repairs raw control characters inside JSON string literals', async () => {
  const rawJson = `{"kind":"task_execution_result","status":"completed","summary":"第一段分析结论。
第二段包含	制表符与换行。"}`;
  const result = await runWithResponse('task_execution_result', chatContent(rawJson));

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.status, 'completed');
  assert.equal(result.output.summary, '第一段分析结论。\n第二段包含\t制表符与换行。');
});

test('control-char repair honors escaped quotes inside string literals', async () => {
  const rawJson = `{"kind":"task_execution_result","status":"completed","summary":"引用 \\" 之后
仍在字符串内"}`;
  const result = await runWithResponse('task_execution_result', chatContent(rawJson));

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.equal(result.output.summary, '引用 " 之后\n仍在字符串内');
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
  const contextPack = input.contextPack as Record<string, unknown>;
  contextPack.availableTools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
  contextPack.workingDirectory = { kind: 'server_local', path: 'D:/tmp/workspace' };

  try {
    const result = await service.run(input);

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
