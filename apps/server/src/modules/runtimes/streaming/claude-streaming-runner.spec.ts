import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startClaudeStreaming } from './claude-streaming-runner.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';
import { makeInvocationPlan } from '../invocation-plan.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, '..', '..', '..', '..', '..', '..', 'tests', 'e2e', 'fixtures', 'claude-stream-json-stub.mjs');

function makeInput(overrides: Parameters<typeof makeInvocationPlan>[0] = {}) {
  return makeInvocationPlan({
    invocationId: 'run-c-1',
    sessionId: 'ses-c-1',
    phase: 'discussion',
    agent: {
      agentId: 'agent-c-1',
      key: 'coder',
      name: 'Coder',
      role: 'coder',
      systemPrompt: ''
    },
    executionTarget: { runtimeType: 'claude_code' },
    contextEnvelope: { L1: { sessionGoal: 'test', phase: 'discussion' } },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    ...overrides
  });
}

test('claude streaming runner: happy path emits frames and returns completed', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
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
  assert.equal(result.runtimeSession?.cliSessionId, 'stub-claude-session-1');
  const kinds = framesCollected.map((f) => f.kind);
  assert.ok(kinds.includes('assistant_text'));
  assert.ok(kinds.includes('result'));
});

test('claude streaming runner: one-shot mode closes stdin after the prompt', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_SKIP_CONTROL: '1' },
    closeStdinAfterPrompt: true,
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeSession?.cliSessionId, 'stub-claude-session-1');
});

test('claude streaming runner: STUB_CRASH → failed', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_CRASH: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_ERROR');
});

test('claude streaming runner: provider 524 preserves retryable timeout semantics', async () => {
  const input = makeInput({ invocationId: 'stream-provider-524' });
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_PROVIDER_524: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.details?.httpStatus, 524);
  assert.equal(result.error?.details?.retryAfterMs, 120_000);
  assert.equal(result.runtimeDiagnostics?.stderrTail?.includes('API Error: 524'), true);
});

test('claude streaming runner: close(0) without result is a model error', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_EXIT_WITHOUT_RESULT: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_ERROR');
});

test('claude streaming runner: CLI result error is a model error', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_RESULT_ERROR: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_ERROR');
  assert.match(result.error?.message ?? '', /stub execution error/);
});

test('claude streaming runner: cancel via handle → cancelled', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
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
});

test('claude streaming runner: first_frame watchdog kills silent stub', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
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
  assert.equal(details?.runtimeType, 'claude_code');
  assert.equal(details?.invocationId, input.invocationId);
  assert.equal(details?.phase, input.phase);
  assert.equal(details?.thresholdMs, 200);
  assert.equal(typeof details?.lastActivityAt, 'string');
  assert.equal(result.streamMetrics?.frameCount, 0);
});

test('claude streaming runner: control_request 被平台应答', async () => {
  const input = makeInput();
  const handle = startClaudeStreaming(input, {
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, STUB_CONTROL_REQUEST: '1' },
    firstFrameTimeoutMs: 5_000,
    idleTimeoutMs: 5_000
  });
  (async () => { for await (const _ of handle.channel) void _; })();
  const result = await handle.result;
  assert.equal(result.status, 'completed');
});

test('claude streaming runner: AbortSignal aborts', async () => {
  const input = makeInput();
  const controller = new AbortController();
  const handle = startClaudeStreaming(
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
