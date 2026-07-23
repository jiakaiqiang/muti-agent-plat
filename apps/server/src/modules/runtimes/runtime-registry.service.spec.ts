import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunResult, AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { RuntimeService } from './runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

function makeResult(runtimeType: RuntimeType, invocationId = 'run-1'): AgentRunResult {
  return {
    invocationId,
    runtimeType,
    status: 'completed',
    output: createAgentMessageOutput({ messageKind: 'summary', content: `${runtimeType} completed` }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(invocationId),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  };
}

function makeAdapter(
  type: RuntimeType,
  category: 'external' | 'internal',
  options: {
    available?: boolean;
    provider?: string;
    runResult?: AgentRunResult;
  } = {}
): AgentRuntimeAdapter {
  return {
    type,
    metadata: {
      name: type,
      version: '0.1.0',
      category,
      provider: options.provider ?? 'test',
      capabilityIds: ['cap-test'],
      supportedWorkspaceCapabilities: ['read'],
      supportedToolNames: []
    },
    async checkAvailability() {
      return options.available === false
        ? { available: false, reason: `${type} unavailable` }
        : { available: true };
    },
    start(input) {
      return {
        events: (async function* () {})(),
        result: Promise.resolve(options.runResult ?? makeResult(type, input.invocationId)),
        async cancel() {}
      };
    }
  };
}

function makePersistence() {
  const collections = new Map<string, unknown>();
  return {
    currentDataEpoch() {
      return 'epoch-test';
    },
    getCollection<T>(name: string, fallback: T): T {
      return (collections.get(name) as T | undefined) ?? fallback;
    },
    setCollection(name: string, value: unknown) {
      collections.set(name, value);
    }
  };
}

test('registers an available external runtime', async () => {
  const registry = new RuntimeRegistryService();
  const adapter = makeAdapter('codex', 'external');

  await registry.registerAdapter(adapter);

  assert.equal(registry.getAdapter('codex'), adapter);
});

test('registers an adapter without availability hook', async () => {
  const registry = new RuntimeRegistryService();
  const adapter = makeAdapter('mock', 'internal');
  delete adapter.checkAvailability;

  await registry.registerAdapter(adapter);

  assert.equal(registry.getAdapter('mock'), adapter);
});

test('does not register unavailable adapters', async () => {
  const registry = new RuntimeRegistryService();

  await registry.registerAdapter(makeAdapter('codex', 'external', { available: false }));

  assert.equal(registry.getAdapter('codex'), undefined);
});

test('refresh removes an unhealthy Adapter and restores it after recovery', async () => {
  const registry = new RuntimeRegistryService();
  let available = true;
  const adapter = makeAdapter('generic_llm', 'external');
  adapter.checkAvailability = async () => available
    ? { available: true }
    : { available: false, reason: 'provider offline' };

  await registry.refreshAdapter(adapter);
  assert.equal(registry.getAdapter('generic_llm'), adapter);

  available = false;
  await registry.refreshAdapter(adapter);
  assert.equal(registry.getAdapter('generic_llm'), undefined);

  available = true;
  await registry.refreshAdapter(adapter);
  assert.equal(registry.getAdapter('generic_llm'), adapter);
});

test('lists runtimes by category', async () => {
  const registry = new RuntimeRegistryService();
  const external = makeAdapter('codex', 'external');
  const internal = makeAdapter('mock', 'internal');

  await registry.registerAdapter(external);
  await registry.registerAdapter(internal);

  assert.deepEqual(registry.listByCategory('external'), [external]);
  assert.deepEqual(registry.listByCategory('internal'), [internal]);
});

test('lists all registered runtimes', async () => {
  const registry = new RuntimeRegistryService();
  const mock = makeAdapter('mock', 'internal');
  const generic = makeAdapter('generic_llm', 'external');

  await registry.registerAdapter(mock);
  await registry.registerAdapter(generic);

  assert.deepEqual(registry.listAll(), [mock, generic]);
});

test('overwrites duplicate runtime registrations by type', async () => {
  const registry = new RuntimeRegistryService();
  const first = makeAdapter('mock', 'internal', { provider: 'first' });
  const second = makeAdapter('mock', 'internal', { provider: 'second' });

  await registry.registerAdapter(first);
  await registry.registerAdapter(second);

  assert.equal(registry.getAdapter('mock'), second);
  assert.equal(registry.listAll().length, 1);
});

test('unregister removes an existing runtime', async () => {
  const registry = new RuntimeRegistryService();
  await registry.registerAdapter(makeAdapter('mock', 'internal'));

  assert.equal(registry.unregister('mock'), true);
  assert.equal(registry.getAdapter('mock'), undefined);
});

test('unregister returns false for unknown runtime', () => {
  const registry = new RuntimeRegistryService();

  assert.equal(registry.unregister('mock'), false);
});

test('RuntimeService resolves adapters through RuntimeRegistryService', async () => {
  const registry = new RuntimeRegistryService();
  const mock = makeAdapter('mock', 'internal', { runResult: makeResult('mock') });
  const generic = makeAdapter('generic_llm', 'external');
  const codex = makeAdapter('codex', 'external');
  const claude = makeAdapter('claude_code', 'external');
  const codeReader = makeAdapter('code_reader', 'internal');
  const testRunner = makeAdapter('test_runner', 'internal');
  await registry.registerAdapter(mock);

  const service = new RuntimeService(
    makePersistence() as never,
    registry,
    mock as never,
    generic as never,
    codex as never,
    claude as never,
    codeReader as never,
    testRunner as never
  );

  const result = await service.run(makeInvocationPlan({
    sessionId: 'session-1',
    executionTarget: { runtimeType: 'mock' }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeType, 'mock');
  assert.equal(service.listInvocations('session-1').length, 1);
});
