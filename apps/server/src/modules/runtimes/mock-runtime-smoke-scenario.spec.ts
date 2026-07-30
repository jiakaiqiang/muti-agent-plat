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

test('file revision execution proposes the complete user draft for the revised source path', async () => {
  const previous = process.env.MOCK_RUNTIME_ENABLED;
  process.env.MOCK_RUNTIME_ENABLED = 'true';
  try {
    const plan = makeInvocationPlan({
      invocationId: 'invocation-file-revision',
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      contextEnvelope: {
        L3: {
          fileRevisions: [{
            chainId: 'chain-revision',
            revisionId: 'revision-1',
            iteration: 1,
            filePath: 'docs/result.md',
            baseKind: 'workspace_baseline',
            base: {
              hash: { algorithm: 'sha256', value: 'a'.repeat(64) },
              contentRef: 'content:base',
              content: 'W0\n',
              byteLength: 3
            },
            userDraft: {
              hash: { algorithm: 'sha256', value: 'b'.repeat(64) },
              contentRef: 'content:draft',
              content: 'U1 complete\n',
              byteLength: 12
            },
            diff: {
              hash: { algorithm: 'sha256', value: 'c'.repeat(64) },
              contentRef: 'content:diff',
              hunks: [],
              summary: { addedLines: 1, removedLines: 1, unchangedLines: 0, hunkCount: 1 }
            },
            evidenceHash: 'evidence-revision-1',
            complete: true,
            truncated: false
          }],
          totalByteLength: 15
        }
      }
    });

    const result = await new MockRuntimeService().start(plan).result;
    assert.equal(result.status, 'completed');
    const change = result.artifacts[0]?.metadata.fileChanges?.[0];
    assert.deepEqual(change, {
      path: 'docs/result.md',
      operation: 'update',
      content: 'U1 complete\n',
      previousContent: 'W0\n',
      encoding: 'utf-8',
      source: 'runtime_proposed_change'
    });
  } finally {
    if (previous === undefined) delete process.env.MOCK_RUNTIME_ENABLED;
    else process.env.MOCK_RUNTIME_ENABLED = previous;
  }
});
