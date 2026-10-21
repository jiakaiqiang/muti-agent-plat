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

test('a bound test invocation selects its exact script and returns audit evidence without publishing artifacts', async () => {
  const { tool, calls } = makeRunTestTool([{ success: true, output: testOutput() }]);
  const adapter = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const input = makeInput(); const hash = 'a'.repeat(64), workspaceId = input.contextEnvelope.workspaceId;
  input.intentTestBinding = { runnerId: 'docker-npm-tests-v1', imageId: `sha256:${hash}`, script: 'test:unit',
    bindingHash: hash, workspaceBindingHash: hash, workspaceId, resourceId: `test-runner:${hash}` };
  input.effectScope = { effects: [{ kind: 'run_tests', target: { kind: 'test_runner', refId: input.intentTestBinding.resourceId }, evidenceRefs: ['request'] }],
    grantIds: ['grant'], prohibitions: [], scopeHash: 'scope' };
  input.executionBinding = { routingId: 'route', intentRevision: 1, requirementRevision: 1, executionEpoch: 1, sessionGeneration: 1, effectScopeHash: 'scope', decisionSetHash: 'decisions' };
  Object.assign(input, { admissionClass: 'business', dataEpoch: 'epoch', intentStepId: 'step', workItemId: 'work', operation: { id: 'operation' } });
  input.agent.capabilityIds = ['cap-isolated-test']; input.executionTarget.requiredCapabilities = ['test'];
  input.toolCatalog.tools = [{ name: 'run_test', description: 'isolated test', inputSchema: { type: 'object' } }];
  const result = await adapter.start(input).result;
  assert.equal(result.status, 'completed'); assert.deepEqual(calls[0].params, { script: 'test:unit' });
  assert.deepEqual(calls[0].context.intentTestBinding, input.intentTestBinding); assert.equal(calls[0].context.requireTestIsolation, true);
  assert.deepEqual(result.artifacts, []); assert.deepEqual((result.output as { changedArtifacts: unknown[] }).changedArtifacts, []);
  for (const alter of [(plan: InvocationPlan) => { plan.executionTarget.requiredCapabilities = ['test', 'command']; },
    (plan: InvocationPlan) => { plan.intentTestBinding!.resourceId = 'forged'; }, (plan: InvocationPlan) => { delete plan.executionBinding; },
    (plan: InvocationPlan) => { plan.executionTarget.writeMode = 'propose_changes'; }]) {
    const forged = structuredClone(input); alter(forged); assert.throws(() => adapter.start(forged), /INTENT_TEST_INVOCATION_INVALID/);
  }
  assert.equal(calls.length, 1);
});

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

test('adapter forwards the server operation identity separately from model tool arguments', async () => {
  const { tool, calls } = makeRunTestTool([toolSuccess()]);
  const adapter = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const input = makeInput({ dataEpoch: 'epoch', operation: { id: 'operation' } as never });
  await adapter.start(input).result;
  assert.deepEqual(calls[0].context.testExecution, { sessionId: 'session-1', dataEpoch: 'epoch', operationId: 'operation', invocationId: 'run-1' });
  assert.deepEqual(calls[0].params, { script: 'test' });
});

test('unconfirmed container stop is nonretryable and remains unknown to Runtime supervision', async () => {
  const { tool } = makeRunTestTool([{ success: false, output: null, error: 'ISOLATED_TEST_STOP_UNCONFIRMED' }]);
  const adapter = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const result = await adapter.start(makeInput()).result;
  assert.equal(result.status, 'failed'); assert.equal(result.error?.retryable, false);
  assert.equal(result.error?.details?.stopUnconfirmed, true);
});

test('direct adapter invocation cannot bypass the still-disabled new-contract test scope', () => {
  const { tool, calls } = makeRunTestTool([toolSuccess()]);
  const adapter = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const input = makeInput(); input.effectScope = { effects: [{ kind: 'run_tests', target: { kind: 'test_runner', refId: 'docker-npm-tests-v1' }, evidenceRefs: ['request'] }],
    prohibitions: [], grantIds: ['untrusted-grant'], scopeHash: 'hash' };
  assert.throws(() => adapter.start(input), /INTENT_TEST_INVOCATION_INVALID|INTENT_EFFECT_SCOPE_UNSUPPORTED/); assert.equal(calls.length, 0);
});

test('adapter cancellation reaches the actual test signal', async () => {
  let observed = false;
  const { tool } = makeRunTestTool([]);
  tool.execute = async (_params, context) => { await new Promise<void>(resolve => {
    context.signal!.addEventListener('abort', () => { observed = true; resolve(); }, { once: true });
  }); return { success: false, output: null, error: 'ISOLATED_TEST_ABORTED' }; };
  const adapter = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);
  const handle = adapter.start(makeInput()); await handle.cancel(); await handle.result;
  assert.equal(observed, true);
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
  assert.match(result.output.summary, /测试通过 3\/3 项/);
  assert.equal(result.events.some((event) => event.type === 'runtime_completed'), true);
});

test('creates a test_report artifact with structured metadata', async () => {
  const { tool } = makeRunTestTool([toolSuccess()]);
  const runtime = new TestRunnerRuntimeAdapterService(makeRegistry(tool) as never, workspaceBindings as never);

  const result = await runtime.start(makeInput()).result;

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.type, 'test_report');
  assert.equal(result.artifacts[0]?.title, '测试报告');
  assert.match(result.artifacts[0]?.content ?? '', /通过：3/);
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
