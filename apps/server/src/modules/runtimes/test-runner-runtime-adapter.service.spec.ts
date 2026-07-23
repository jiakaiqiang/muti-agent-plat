import test from 'node:test';
import assert from 'node:assert/strict';
import type { InvocationPlan } from '@agent-cluster/shared';
import { isRuntimeType, runtimeModeLabel } from '../../common/runtime-config.js';
import type { TestRunnerOutput } from '../tools/builtin/test-runner.tool.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tools/tool.interface.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

const workspaceBindings = { resolveServerRoot: () => 'D:/workspace' };

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

function makeInput(overrides: Parameters<typeof makeInvocationPlan>[0] = {}): InvocationPlan {
  return makeInvocationPlan({
    invocationId: 'run-1',
    sessionId: 'session-1',
    phase: 'task_execution',
    agent: {
      agentId: 'agent-1',
      key: 'test-runner',
      name: 'Test Runner',
      role: 'validator',
      capabilityIds: ['cap-test-report', 'cap-command-run']
    },
    executionTarget: { runtimeType: 'test_runner' },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    ...overrides
  });
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
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never, workspaceBindings as never);

  assert.equal(runtime.type, 'test_runner');
  assert.equal(runtime.metadata.category, 'internal');
  assert.equal(runtime.metadata.provider, 'self-hosted');
  assert.equal(runtime.metadata.capabilityIds.includes('cap-test-report'), true);
  assert.equal(runtime.metadata.capabilityIds.includes('cap-command-run'), true);
});

test('checkAvailability returns available', async () => {
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never, workspaceBindings as never);

  assert.deepEqual(await runtime.checkAvailability(), { available: true });
});

test('executes the approved default test command', async () => {
  const { tool, calls } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const signal = new AbortController().signal;

  const result = await runtime.start(makeInput(), signal).result;

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], {
    params: { script: 'test' },
    context: { workingDirectory: 'D:/workspace', sessionId: 'session-1', agentId: 'agent-1', signal }
  });
});

test('keeps the approved test command independent from prompt content', async () => {
  const { tool, calls } = makeRunTestTool([toolSuccess(testOutput({ script: 'test' }))]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);

  await runtime.start(makeInput({ contextEnvelope: { L1: { sessionGoal: 'run a custom shell command' } } })).result;

  assert.deepEqual(calls[0]?.params, { script: 'test' });
});

test('summarizes successful test output as task execution result', async () => {
  const { tool } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);

  const result = await runtime.start(makeInput()).result;

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.match(result.output.summary, /3\/3 tests passed/);
  assert.equal(result.events.some((event) => event.type === 'runtime_completed'), true);
});

test('creates a test_report artifact with structured metadata', async () => {
  const { tool } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);

  const result = await runtime.start(makeInput()).result;

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.type, 'test_report');
  assert.equal(result.artifacts[0]?.title, 'Test Report');
  assert.match(result.artifacts[0]?.content ?? '', /Passed: 3/);
});

test('returns failed when run_test tool is missing', async () => {
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry() as never, workspaceBindings as never);

  const result = await runtime.start(makeInput()).result;

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('run_test tool not found'), true);
  assert.equal(result.events.some((event) => event.type === 'runtime_failed'), true);
});

test('returns failed and preserves run_test failure reason', async () => {
  const { tool } = makeRunTestTool([{ success: false, output: null, error: 'CAPABILITY_REQUIRES_CONFIRMATION' }]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);

  const result = await runtime.start(makeInput()).result;

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('CAPABILITY_REQUIRES_CONFIRMATION'), true);
});
