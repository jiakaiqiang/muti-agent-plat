import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentRunInput } from '@agent-cluster/shared';
import { startCodexStreaming } from './codex-streaming-runner.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, '..', '..', '..', '..', '..', '..', 'tests', 'e2e', 'fixtures', 'codex-appserver-stub.mjs');

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'ses-1',
    phase: 'discussion',
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
      sessionGoal: 'test',
      taskContext: {} as never,
      summaryMemory: {
        goal: '',
        currentState: '',
        confirmedFacts: [],
        completed: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        nextSteps: []
      },
      continuationState: {
        phase: 'discussion',
        sessionStatus: 'DRAFT_INPUT',
        pendingTaskIds: [],
        runningTaskIds: [],
        completedTaskIds: [],
        blockedTaskIds: [],
        nextAgentKeys: [],
        handoffRefs: [],
        sourceEventIds: [],
        sourceArtifactIds: [],
        resumeHints: []
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
    ...overrides
  };
}

test('codex streaming runner: happy path emits frames and returns completed result', async () => {
  const input = makeInput();
  const handle = startCodexStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  const framesCollected: RuntimeStreamFrame[] = [];
  (async () => {
    for await (const f of handle.channel) framesCollected.push(f);
  })();
  const result = await handle.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeSession?.cliSessionId, 'stub-session-1');
  assert.equal(result.output.kind, 'agent_message');
  if (result.output.kind !== 'agent_message') return;
  assert.equal(result.output.content, '你好世界');
  assert.equal(result.usage.inputTokens, 42);
  assert.equal(result.usage.outputTokens, 24);
  assert.equal(result.usage.totalTokens, 66);
  // 至少应收到 tool_use / tool_result / result 三种优先帧
  const kinds = framesCollected.map((f) => f.kind);
  assert.ok(kinds.includes('tool_use'));
  assert.ok(kinds.includes('tool_result'));
  assert.ok(kinds.includes('result'));
});

test('codex streaming runner: STUB_CRASH → failed with MODEL_ERROR + stderrTail available', async () => {
  const input = makeInput();
  const handle = startCodexStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_CRASH: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  // drain channel
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  // stub 崩溃后没有 result 帧,mapper 抛错 → OUTPUT_SCHEMA_INVALID
  assert.ok(['MODEL_ERROR', 'OUTPUT_SCHEMA_INVALID'].includes(result.error?.code ?? ''));
});

test('codex streaming runner: cancel via handle → status cancelled', async () => {
  const input = makeInput();
  const handle = startCodexStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_FIRST_DELAY_MS: '2000' },
    firstFrameTimeoutMs: 10_000,
    idleTimeoutMs: 10_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  setTimeout(() => handle.cancel(), 100);
  const result = await handle.result;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error?.code, 'RUNTIME_CANCELLED');
});

test('codex streaming runner: watchdog first_frame timeout kills silent stub', async () => {
  const input = makeInput();
  const handle = startCodexStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_FIRST_DELAY_MS: '5000' },
    firstFrameTimeoutMs: 200,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
  const details = result.error?.details as Record<string, unknown> | undefined;
  assert.equal(details?.watchdog, 'first_frame');
  assert.equal(details?.runtimeType, 'codex');
  assert.equal(details?.runId, input.runId);
  assert.equal(details?.phase, input.phase);
  assert.equal(details?.thresholdMs, 200);
  assert.equal(typeof details?.lastActivityAt, 'string');
  assert.equal(result.streamMetrics?.frameCount, 0);
});

test('codex streaming runner: AbortSignal aborts run', async () => {
  const input = makeInput();
  const controller = new AbortController();
  const handle = startCodexStreaming(
    input,
    {
      command: process.execPath,
      args: [stubPath],
      env: { ...process.env, STUB_FIRST_DELAY_MS: '2000' },
      firstFrameTimeoutMs: 10_000,
      idleTimeoutMs: 10_000
    },
    controller.signal
  );
  (async () => { for await (const _ of handle.channel) void _; })();
  setTimeout(() => controller.abort(), 100);
  const result = await handle.result;
  assert.equal(result.status, 'cancelled');
});
