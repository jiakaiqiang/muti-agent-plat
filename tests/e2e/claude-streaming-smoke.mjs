import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './smoke-server.mjs';

/**
 * Claude stream-json process-level smoke.
 *
 * The current router intentionally chooses Codex for code-changing tasks and
 * Generic LLM for non-execution phases. This smoke therefore exercises the
 * Claude provider boundary directly instead of mutating product routing rules
 * merely to force a full Session through Claude.
 */

await buildServer();

const { startClaudeStreaming } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/streaming/claude-streaming-runner.js'
);
const { makeInvocationPlan } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/invocation-plan.fixture.js'
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'fixtures', 'claude-stream-json-stub.mjs');
const input = makeInvocationPlan({
  invocationId: 'claude-streaming-smoke-invocation',
  sessionId: 'claude-streaming-smoke-session',
  phase: 'task_execution',
  executionTarget: { runtimeType: 'claude_code' },
  contextEnvelope: { L1: { sessionGoal: 'Validate Claude strict output', phase: 'task_execution' } },
  expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' }
});

const handle = startClaudeStreaming(input, {
  command: process.execPath,
  args: [stubPath],
  env: {
    ...process.env,
    STUB_KIND: 'task_execution_result',
    STUB_SKIP_CONTROL: '1'
  },
  closeStdinAfterPrompt: true,
  firstFrameTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  absoluteTimeoutMs: 15_000
});

const frames = [];
const consume = (async () => {
  for await (const frame of handle.channel) frames.push(frame);
})();
const result = await handle.result;
await consume;

assert.equal(result.status, 'completed');
assert.equal(result.runtimeType, 'claude_code');
assert.equal(result.output.schemaVersion, '1.0');
assert.equal(result.output.kind, 'task_execution_result');
assert.equal(result.runtimeSession?.cliSessionId, 'stub-claude-session-1');
assert.ok(frames.some((frame) => frame.kind === 'assistant_text'));
assert.ok(frames.some((frame) => frame.kind === 'tool_use'));
assert.ok(frames.some((frame) => frame.kind === 'tool_result'));
assert.ok(frames.some((frame) => frame.kind === 'result'));
assert.ok(
  result.runtimeDiagnostics?.providerNotifications.some(
    (notification) => notification.method === 'init' && notification.disposition === 'debug_only'
  )
);

console.log('claude streaming smoke ok');
