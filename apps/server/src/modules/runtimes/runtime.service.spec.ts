import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle
} from '@agent-cluster/shared';
import { RuntimeService } from './runtime.service.js';

function makeInput(): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    phase: 'task_execution',
    agent: {
      id: 'agent-1',
      key: 'coder',
      name: 'Coder',
      role: 'coder',
      systemPrompt: '',
      runtimeType: 'codex',
      capabilityIds: []
    },
    contextPack: {
      systemRules: [],
      sessionGoal: 'test resume',
      taskContext: {} as never,
      summaryMemory: {} as never,
      continuationState: {} as never,
      workingDirectory: {
        id: 'workdir-1',
        name: 'test workdir',
        kind: 'server_local',
        path: process.cwd(),
        selectedAt: new Date().toISOString()
      },
      agentProfile: {} as never,
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets: [],
      artifacts: [],
      capabilities: [],
      constraints: [],
      budget: {}
    },
    expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
    budget: {},
    options: { resume: { cliSessionId: 'old-session', workDir: process.cwd() } }
  };
}

function result(status: AgentRunResult['status'], cliSessionId?: string): AgentRunResult {
  return {
    runId: 'run-1',
    runtimeType: 'codex',
    status,
    output: { kind: 'agent_message', messageKind: status === 'completed' ? 'summary' : 'risk', content: status },
    events: [],
    artifacts: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    runtimeSession: cliSessionId ? { cliSessionId, workDir: process.cwd() } : undefined,
    error:
      status === 'failed'
        ? { code: 'MODEL_ERROR', message: 'thread/resume failed', retryable: true }
        : undefined
  };
}

function handle(runResult: AgentRunResult, events: AgentRuntimeEvent[] = []): AgentRuntimeRunHandle {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      }
    },
    result: Promise.resolve(runResult),
    cancel: async () => {}
  };
}

function createService(adapter: AgentRuntimeAdapter) {
  const persisted = {} as Record<string, unknown>;
  const persistence = {
    getCollection: (_name: string, fallback: unknown) => fallback,
    setCollection: (name: string, value: unknown) => {
      persisted[name] = value;
    }
  };
  const registry = {
    registerAdapter: async () => {},
    getAdapter: () => adapter
  };
  const service = new RuntimeService(
    persistence as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  return { service, persisted };
}

test('RuntimeService retries a failed resume once and emits RESUME_FALLBACK', async () => {
  const previous = process.env.ENGINEERING_RUNTIME_STREAMING;
  process.env.ENGINEERING_RUNTIME_STREAMING = 'codex';
  try {
    const inputs: AgentRunInput[] = [];
    const adapter: AgentRuntimeAdapter = {
      type: 'codex',
      run: async () => result('failed'),
      start: (input) => {
        inputs.push(input);
        return inputs.length === 1 ? handle(result('failed')) : handle(result('completed', 'new-session'));
      }
    };
    const { service } = createService(adapter);
    const execution = service.start(makeInput());
    const events: AgentRuntimeEvent[] = [];
    const consume = (async () => {
      for await (const event of execution.events) events.push(event);
    })();
    const resolved = await execution.result;
    await consume;

    assert.equal(resolved.status, 'completed');
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1].options?.resume, undefined);
    assert.ok(events.some((event) => event.metadata?.code === 'RESUME_FALLBACK'));
  } finally {
    process.env.ENGINEERING_RUNTIME_STREAMING = previous;
  }
});

test('RuntimeService keeps a successful matching resumed session', async () => {
  let starts = 0;
  const adapter: AgentRuntimeAdapter = {
    type: 'codex',
    run: async () => result('completed', 'old-session'),
    start: () => {
      starts += 1;
      return handle(result('completed', 'old-session'));
    }
  };
  const { service } = createService(adapter);
  const resolved = await service.start(makeInput()).result;
  assert.equal(resolved.runtimeSession?.cliSessionId, 'old-session');
  assert.equal(starts, 1);
});

test('RuntimeService falls back when resume returns a different session id', async () => {
  let starts = 0;
  const adapter: AgentRuntimeAdapter = {
    type: 'codex',
    run: async () => result('completed', 'unexpected'),
    start: () => {
      starts += 1;
      return handle(result('completed', starts === 1 ? 'unexpected' : 'fresh'));
    }
  };
  const { service } = createService(adapter);
  const resolved = await service.start(makeInput()).result;
  assert.equal(resolved.runtimeSession?.cliSessionId, 'fresh');
  assert.equal(starts, 2);
});

test('RuntimeService persists stream metrics for watchdog baseline analysis', async () => {
  const completed = result('completed', 'old-session');
  completed.streamMetrics = {
    startedAt: '2026-07-10T00:00:00.000Z',
    completedAt: '2026-07-10T00:02:30.000Z',
    durationMs: 150_000,
    frameCount: 4,
    firstFrameAt: '2026-07-10T00:00:02.000Z',
    firstFrameLatencyMs: 2_000,
    lastActivityAt: '2026-07-10T00:02:20.000Z',
    maxInterFrameGapMs: 60_000
  };
  const adapter: AgentRuntimeAdapter = {
    type: 'codex',
    run: async () => completed,
    start: () => handle(completed)
  };
  const { service } = createService(adapter);
  await service.start(makeInput()).result;
  const [invocation] = service.listInvocations('session-1');
  assert.equal(invocation.streamMetrics?.durationMs, 150_000);
  assert.equal(invocation.streamMetrics?.maxInterFrameGapMs, 60_000);
});

test('RuntimeService persists queryable input token estimation error', async () => {
  const completed = result('completed', 'old-session');
  completed.usage.inputTokens = 125;
  const adapter: AgentRuntimeAdapter = {
    type: 'codex',
    run: async () => completed,
    start: () => handle(completed)
  };
  const { service, persisted } = createService(adapter);
  const input = makeInput();
  input.estimatedInputTokens = 100;

  await service.start(input).result;

  const [invocation] = service.listInvocations('session-1') as Array<{
    inputTokenEstimation?: { estimated: number; actual: number; ratio: number };
  }>;
  assert.deepEqual(invocation.inputTokenEstimation, {
    estimated: 100,
    actual: 125,
    ratio: 1.25
  });
  const stored = persisted.runtimeInvocationsBySession as Record<
    string,
    Array<{ inputTokenEstimation?: { estimated: number; actual: number; ratio: number } }>
  >;
  assert.deepEqual(stored['session-1'][0].inputTokenEstimation, invocation.inputTokenEstimation);
});

test('RuntimeService uses executionTarget from input when provided', async () => {
  const mockResult: AgentRunResult = {
    runId: 'run-1',
    runtimeType: 'mock',
    status: 'completed',
    output: { kind: 'agent_message', messageKind: 'summary', content: 'completed' },
    events: [],
    artifacts: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    runtimeSession: { cliSessionId: 'mock-session', workDir: process.cwd() }
  };

  const mockAdapter: AgentRuntimeAdapter = {
    type: 'mock',
    run: async () => mockResult,
    start: () => handle(mockResult)
  };

  const registry = {
    registerAdapter: async () => {},
    getAdapter: (type: string) => (type === 'mock' ? mockAdapter : null)
  };

  const persistence = {
    getCollection: (_name: string, fallback: unknown) => fallback,
    setCollection: () => {}
  };

  const service = new RuntimeService(
    persistence as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );

  const input = makeInput();
  input.executionTarget = {
    runtimeType: 'mock'
  };

  const resolved = await service.start(input).result;
  assert.equal(resolved.status, 'completed');
  assert.equal(resolved.runtimeType, 'mock');
});
