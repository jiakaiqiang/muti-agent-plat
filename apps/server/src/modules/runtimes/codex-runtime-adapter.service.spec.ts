import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentMessageOutput,
  RUNTIME_OUTPUT_KINDS,
  runtimeOutputExamples
} from '@agent-cluster/shared';
import {
  buildCodexExecArgs,
  codexBufferedTimeoutMs,
  CodexRuntimeAdapterService,
  parseCodexExecOutput,
  pickCodexRunMode
} from './codex-runtime-adapter.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

function withStreaming(value: string | undefined, fn: () => void) {
  const previous = process.env.RUNTIME_STREAMING;
  if (value === undefined) delete process.env.RUNTIME_STREAMING;
  else process.env.RUNTIME_STREAMING = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previous;
  }
}

async function codexAvailability(value?: string) {
  const previous = process.env.CODEX_RUNTIME_ENABLED;
  if (value === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
  else process.env.CODEX_RUNTIME_ENABLED = value;
  try {
    return await new CodexRuntimeAdapterService({ resolveServerRoot: () => undefined } as never).checkAvailability();
  } finally {
    if (previous === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
    else process.env.CODEX_RUNTIME_ENABLED = previous;
  }
}

test('Codex registration is unavailable when its enable flag is absent', async () => {
  assert.equal((await codexAvailability()).available, false);
});

test('Codex unavailable result explains the required enable flag', async () => {
  assert.match((await codexAvailability('false')).reason ?? '', /CODEX_RUNTIME_ENABLED=true/);
});

test('Codex enable flag is fail-closed and case sensitive', async () => {
  assert.equal((await codexAvailability('TRUE')).available, false);
});

test('Codex registration is available only when explicitly enabled', async () => {
  assert.deepEqual(await codexAvailability('true'), { available: true });
});

test('Codex uses buffered mode when streaming is not configured', () => {
  withStreaming(undefined, () => assert.equal(pickCodexRunMode(), 'buffered'));
});

test('Codex uses buffered mode when streaming is off', () => {
  withStreaming('off', () => assert.equal(pickCodexRunMode(), 'buffered'));
});

test('Codex uses streaming mode for codex', () => {
  withStreaming('codex', () => assert.equal(pickCodexRunMode(), 'streaming'));
});

test('Codex uses streaming mode for all', () => {
  withStreaming('all', () => assert.equal(pickCodexRunMode(), 'streaming'));
});

test('Codex rejects unknown streaming modes to buffered', () => {
  withStreaming('bogus', () => assert.equal(pickCodexRunMode(), 'buffered'));
});

test('Codex buffered timeout cannot exceed the independent absolute deadline', () => {
  const previousTimeout = process.env.CODEX_RUNTIME_TIMEOUT_MS;
  const previousAbsoluteTimeout = process.env.CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS;
  try {
    process.env.CODEX_RUNTIME_TIMEOUT_MS = '2400000';
    process.env.CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS = '1800000';
    assert.equal(codexBufferedTimeoutMs(), 1_800_000);

    process.env.CODEX_RUNTIME_TIMEOUT_MS = '600000';
    assert.equal(codexBufferedTimeoutMs(), 600_000);
  } finally {
    if (previousTimeout === undefined) delete process.env.CODEX_RUNTIME_TIMEOUT_MS;
    else process.env.CODEX_RUNTIME_TIMEOUT_MS = previousTimeout;
    if (previousAbsoluteTimeout === undefined) delete process.env.CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS;
    else process.env.CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS = previousAbsoluteTimeout;
  }
});

test('Codex exec arguments match the current CLI and preserve sandbox authority', () => {
  const args = buildCodexExecArgs(
    makeInvocationPlan({ executionTarget: { runtimeType: 'codex', writeMode: 'none' } })
  );
  assert.deepEqual(args, ['exec', '--json', '--sandbox', 'read-only', '-']);
  assert.equal(args.includes('--ask-for-approval'), false);
  assert.equal(args.includes('analyze only'), false);
});

test('Codex buffered output extracts the final agent message from JSONL', () => {
  const message = createAgentMessageOutput({ messageKind: 'summary', content: 'done' });
  const output = parseCodexExecOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'agent_message',
        text: JSON.stringify(message)
      }
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
  ].join('\n'), 'agent_message');
  assert.deepEqual(output, message);
});

test('Codex buffered output rejects fenced JSON in the final agent message', () => {
  const message = createAgentMessageOutput({ messageKind: 'summary', content: 'done' });
  assert.throws(() => parseCodexExecOutput(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: `\`\`\`json\n${JSON.stringify(message)}\n\`\`\``
      }
    }), 'agent_message'), SyntaxError);
});

test('Codex buffered output rejects provider-specific string wrappers', () => {
  const message = JSON.stringify(createAgentMessageOutput({ messageKind: 'summary', content: 'done' }));
  for (const wrapper of ['result', 'output', 'final_output']) {
    assert.throws(
      () => parseCodexExecOutput(JSON.stringify({ [wrapper]: message }), 'agent_message'),
      /did not contain a RuntimeOutput kind/
    );
  }
});

test('Codex buffered output rejects a fake completed-item envelope', () => {
  const message = createAgentMessageOutput({ messageKind: 'summary', content: 'done' });
  assert.throws(
    () => parseCodexExecOutput(JSON.stringify({
      type: 'not-item-completed',
      item: { type: 'agent_message', text: JSON.stringify(message) }
    }), 'agent_message'),
    /did not contain a RuntimeOutput kind/
  );
});

test('Codex buffered JSONL fails closed on non-JSON lines', () => {
  const message = createAgentMessageOutput({ messageKind: 'summary', content: 'done' });
  const completed = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(message) }
  });
  assert.throws(() => parseCodexExecOutput(`garbage\n${completed}`, 'agent_message'), SyntaxError);
  assert.throws(() => parseCodexExecOutput(`${completed}\ngarbage`, 'agent_message'), SyntaxError);
});

test('Codex buffered output accepts every registered Runtime output through the shared validator', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    assert.deepEqual(parseCodexExecOutput(JSON.stringify(runtimeOutputExamples[kind]), kind), runtimeOutputExamples[kind]);
  }
});

test('Codex buffered output rejects the removed message alias', () => {
  assert.throws(
    () => parseCodexExecOutput(JSON.stringify({
      kind: 'agent_message',
      schemaVersion: '1.0',
      message: '需求契约草案'
    }), 'agent_message'),
    /RUNTIME_OUTPUT_CONTRACT_VIOLATION/
  );
});

test('Codex buffered output rejects an empty agent message', () => {
  assert.throws(
    () => parseCodexExecOutput(JSON.stringify({ kind: 'agent_message', messageKind: 'summary' }), 'agent_message'),
    /RUNTIME_OUTPUT_CONTRACT_VIOLATION.*content/i
  );
});

test('Codex buffered output rejects an unexpected output kind', () => {
  assert.throws(
    () => parseCodexExecOutput(JSON.stringify({ kind: 'task_execution_result' }), 'agent_message'),
    /RUNTIME_OUTPUT_CONTRACT_VIOLATION/i
  );
});

test('Codex buffered run preserves Runtime output contract violations as non-retryable', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-buffered-contract-'));
  const previousEnabled = process.env.CODEX_RUNTIME_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  process.env.CODEX_RUNTIME_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  try {
    const adapter = new CodexRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
    Object.defineProperty(adapter, 'runBufferedCommand', {
      value: async () => ({
        stdout: JSON.stringify({ kind: 'agent_message', schemaVersion: '1.0', messageKind: 'summary' }),
        stderr: ''
      })
    });

    const result = await adapter.start(makeInvocationPlan({
      executionTarget: { runtimeType: 'codex' }
    })).result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
    assert.equal(result.error?.retryable, false);
    assert.deepEqual(result.error?.details, { provider: 'codex', expectedKind: 'agent_message' });
    assert.equal(result.events[0]?.metadata?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  } finally {
    if (previousEnabled === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
    else process.env.CODEX_RUNTIME_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Codex rejects resume when its asserted workDir differs from the workspace binding', async () => {
  const previousEnabled = process.env.CODEX_RUNTIME_ENABLED;
  process.env.CODEX_RUNTIME_ENABLED = 'true';
  try {
    const root = join(process.cwd(), 'workspace-a');
    const adapter = new CodexRuntimeAdapterService({ resolveServerRoot: () => root } as never);
    const result = await adapter.start(makeInvocationPlan({
      executionTarget: { runtimeType: 'codex' },
      resume: { cliSessionId: 'session-a', workDir: join(process.cwd(), 'workspace-b') }
    })).result;
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /does not match the current workspace binding/);
  } finally {
    if (previousEnabled === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
    else process.env.CODEX_RUNTIME_ENABLED = previousEnabled;
  }
});
