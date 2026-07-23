import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { MockRuntimeService } from './mock-runtime.service.js';

async function runScenario(scenario: string) {
  const previous = process.env.MOCK_RUNTIME_ENABLED;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  try {
    const service = new MockRuntimeService();
    const plan = makeInvocationPlan({
      invocationId: `invocation-${scenario}`,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      contextEnvelope: { L5: { bullets: [`Smoke scenario: ${scenario}`], turnCount: 0 } }
    });
    return await service.start(plan).result;
  } finally {
    if (previous === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previous;
  }
}

test('task_failed smoke scenario returns a failed result', async () => {
  assert.equal((await runScenario('task_failed')).status, 'failed');
});

test('task_failed smoke scenario returns MODEL_ERROR', async () => {
  assert.equal((await runScenario('task_failed')).error?.code, 'MODEL_ERROR');
});

test('task_failed smoke scenario is not retryable', async () => {
  assert.equal((await runScenario('task_failed')).error?.retryable, false);
});

test('task_failed smoke scenario emits runtime_failed', async () => {
  assert.equal((await runScenario('task_failed')).events.at(-1)?.type, 'runtime_failed');
});

test('task_failed smoke scenario preserves the invocation id', async () => {
  assert.equal((await runScenario('task_failed')).invocationId, 'invocation-task_failed');
});

test('task_failed smoke scenario produces no artifacts', async () => {
  assert.deepEqual((await runScenario('task_failed')).artifacts, []);
});

test('happy_path smoke scenario remains completed', async () => {
  assert.equal((await runScenario('happy_path')).status, 'completed');
});

test('an unrelated ContextEnvelope bullet does not force failure', async () => {
  assert.equal((await runScenario('ordinary_execution')).status, 'completed');
});
