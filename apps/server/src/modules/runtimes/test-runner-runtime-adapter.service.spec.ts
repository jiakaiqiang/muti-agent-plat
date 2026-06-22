import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput } from '@agent-cluster/shared';
import { isRuntimeType, runtimeModeLabel } from '../../common/runtime-config.js';
import type { TestRunnerOutput } from '../tools/builtin/test-runner.tool.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tools/tool.interface.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';

function makeRunTestTool(results: ToolResult[]) {
  const calls: Array<{ params: unknown; context: ToolExecutionContext }> = [];
  const tool: Tool = {
    name: 'run_test',
    description: 'Run tests',
    category: 'test',
    riskLevel: 'high',
    inputSchema: { type: 'object', properties: { script: { type: 'string' } } },
    async execute(params, context) {
      calls.push({ params, context });
      return results[Math.min(calls.length - 1, results.length - 1)];
    }
  };
  return { tool, calls };
}

function makeRegistry(tool?: Tool) {
  return {
    getTool(name: string) {
      return name === 'run_test' ? tool : undefined;
    }
  };
}

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    phase: 'execute_task',
    agent: {
      id: 'agent-1',
      key: 'test-runner',
      name: 'Test Runner',
      role: 'validator',
      systemPrompt: '',
      runtimeType: 'test_runner',
      capabilityIds: ['cap-test-report', 'cap-command-run']
    },
    contextPack: {
      workingDirectory: { path: 'D:/workspace' },
      taskContext: { testScript: 'test:unit' }
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
    budget: { maxTokens: 1000 },
    ...overrides
  } as unknown as AgentRunInput;
}

function testOutput(overrides: Partial<TestRunnerOutput> = {}): TestRunnerOutput {
  return {
    script: 'test:unit',
    duration: 123,
    summary: { total: 3, passed: 3, failed: 0, skipped: 0 },
    failures: [],
    exitCode: 0,
    stdout: '3 tests passed',
    stderr: '',
    timedOut: false,
    aborted: false,
    ...overrides
  };
}

function toolSuccess(output: TestRunnerOutput = testOutput()): ToolResult {
  return {
    success: true,
    output
  };
}

test('test_runner is a recognized RuntimeType with a label', () => {
  assert.equal(isRuntimeType('test_runner'), true);
  assert.equal(runtimeModeLabel('test_runner'), 'Test Runner');
});

test('exposes internal self-hosted metadata', () => {
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never);

  assert.equal(runtime.type, 'test_runner');
  assert.equal(runtime.metadata.category, 'internal');
  assert.equal(runtime.metadata.provider, 'self-hosted');
  assert.equal(runtime.metadata.capabilityIds.includes('cap-test-report'), true);
  assert.equal(runtime.metadata.capabilityIds.includes('cap-command-run'), true);
});

test('checkAvailability returns available', async () => {
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never);

  assert.deepEqual(await runtime.checkAvailability(), { available: true });
});

test('executes run_test from taskContext testScript', async () => {
  const { tool, calls } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never);
  const signal = new AbortController().signal;

  const result = await runtime.run(makeInput(), signal);

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], {
    params: { script: 'test:unit' },
    context: { workingDirectory: 'D:/workspace', sessionId: 'session-1', agentId: 'agent-1', signal }
  });
});

test('defaults to npm test when taskContext has no testScript', async () => {
  const { tool, calls } = makeRunTestTool([toolSuccess(testOutput({ script: 'test' }))]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never);

  await runtime.run(makeInput({ contextPack: { workingDirectory: { path: 'D:/workspace' }, taskContext: {} } } as unknown as AgentRunInput));

  assert.deepEqual(calls[0]?.params, { script: 'test' });
});

test('summarizes successful test output as task execution result', async () => {
  const { tool } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.match(result.output.summary, /3\/3 tests passed/);
  assert.equal(result.events.some((event) => event.type === 'runtime_completed'), true);
});

test('creates a test_report artifact with structured metadata', async () => {
  const { tool } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.type, 'test_report');
  assert.equal(result.artifacts[0]?.title, 'Test Report');
  assert.deepEqual(result.artifacts[0]?.metadata?.summary, { total: 3, passed: 3, failed: 0, skipped: 0 });
});

test('returns failed when run_test tool is missing', async () => {
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('run_test tool not found'), true);
  assert.equal(result.events.some((event) => event.type === 'runtime_failed'), true);
});

test('returns failed and preserves run_test failure reason', async () => {
  const { tool } = makeRunTestTool([{ success: false, output: null, error: 'CAPABILITY_REQUIRES_CONFIRMATION' }]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('CAPABILITY_REQUIRES_CONFIRMATION'), true);
});
