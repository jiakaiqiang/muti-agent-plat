import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunResult } from '@agent-cluster/shared';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { MockRuntimeService } from './mock-runtime.service.js';

const navigation = {
  entries: [
    { path: 'package.json', kind: 'file' as const, generated: false, sensitive: false },
    { path: 'src/config.ts', kind: 'file' as const, generated: false, sensitive: false },
    { path: 'src/index.ts', kind: 'file' as const, generated: false, sensitive: false },
    { path: 'src/utils.ts', kind: 'file' as const, generated: false, sensitive: false }
  ],
  truncated: false
};

async function runSequence(sessionId = 'context-retry-session') {
  const previousEnabled = process.env.MOCK_RUNTIME_ENABLED;
  const previousTimes = process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = '3';
  try {
    const service = new MockRuntimeService();
    const invoke = (invocationId: string, id = sessionId) => service.start(makeInvocationPlan({
      invocationId,
      sessionId: id,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      contextEnvelope: { L1: { navigation } }
    })).result;
    return { service, invoke, results: [await invoke('retry-1'), await invoke('retry-2'), await invoke('retry-3')] };
  } finally {
    if (previousEnabled === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previousEnabled;
    if (previousTimes === undefined) delete process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
    else process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = previousTimes;
  }
}

const pathsOf = (result: AgentRunResult) =>
  result.error?.requestedContext?.requestedPaths ?? [];

test('first context failure requests exactly one file path', async () => {
  assert.equal(pathsOf((await runSequence()).results[0]).length, 1);
});

test('second context failure requests a different path', async () => {
  const { results } = await runSequence();
  assert.notEqual(pathsOf(results[0])[0], pathsOf(results[1])[0]);
});

test('third context failure requests a third distinct path', async () => {
  const { results } = await runSequence();
  assert.equal(new Set(results.flatMap(pathsOf)).size, 3);
});

test('context retries prioritize source paths over package metadata', async () => {
  const { results } = await runSequence();
  assert.ok(results.flatMap(pathsOf).every((path) => path.startsWith('src/')));
});

test('configured failure count is followed by successful completion', async () => {
  const previousEnabled = process.env.MOCK_RUNTIME_ENABLED;
  const previousTimes = process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = '3';
  try {
    const service = new MockRuntimeService();
    const plan = (id: string) => makeInvocationPlan({ invocationId: id, sessionId: 'four-attempts', contextEnvelope: { L1: { navigation } } });
    await service.start(plan('attempt-1')).result;
    await service.start(plan('attempt-2')).result;
    await service.start(plan('attempt-3')).result;
    assert.equal((await service.start(plan('attempt-4')).result).status, 'completed');
  } finally {
    if (previousEnabled === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previousEnabled;
    if (previousTimes === undefined) delete process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
    else process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = previousTimes;
  }
});

test('file context failures do not fabricate requestedRefs', async () => {
  assert.deepEqual((await runSequence()).results[0].error?.requestedContext?.requestedRefs, []);
});

test('context failure includes a follow-up instruction', async () => {
  assert.ok((await runSequence()).results[0].error?.requestedContext?.followUpInstruction);
});

test('context failure counters are isolated by Session', async () => {
  const previousEnabled = process.env.MOCK_RUNTIME_ENABLED;
  const previousTimes = process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = '3';
  try {
    const service = new MockRuntimeService();
    const plan = (sessionId: string, invocationId: string) => makeInvocationPlan({
      invocationId,
      sessionId,
      contextEnvelope: { L1: { navigation } }
    });
    const firstA = await service.start(plan('session-a', 'a-1')).result;
    await service.start(plan('session-a', 'a-2')).result;
    const firstB = await service.start(plan('session-b', 'b-1')).result;
    assert.equal(pathsOf(firstA)[0], pathsOf(firstB)[0]);
  } finally {
    if (previousEnabled === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previousEnabled;
    if (previousTimes === undefined) delete process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
    else process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES = previousTimes;
  }
});
