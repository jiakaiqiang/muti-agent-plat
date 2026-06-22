import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { RuntimeService } from './runtime.service.js';

function makeResult(runtimeType: RuntimeType, runId = 'run-1'): AgentRunResult {
  return {
    runId,
    runtimeType,
    status: 'completed',
    output: {
      kind: 'agent_message',
      messageKind: 'summary',
      content: `${runtimeType} completed`
    },
    events: [],
    artifacts: [],
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
      capabilityIds: ['cap-test']
    },
    async checkAvailability() {
      return options.available === false
        ? { available: false, reason: `${type} unavailable` }
        : { available: true };
    },
    async run(input) {
      return options.runResult ?? makeResult(type, input.runId);
    }
  };
}

function makeRunInput(runtimeType: RuntimeType): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    phase: 'execute_task',
    agent: {
      id: 'agent-1',
      key: 'agent',
      name: 'Agent',
      role: 'worker',
      profileMarkdown: '',
      systemPrompt: '',
      runtimeType,
      capabilityIds: []
    },
    contextPack: {},
    expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
    budget: { maxTokens: 1000 }
  } as unknown as AgentRunInput;
}

function makePersistence() {
  const collections = new Map<string, unknown>();
  return {
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
  await registry.registerAdapter(mock);

  const service = new RuntimeService(
    makePersistence() as never,
    registry,
    mock as never,
    generic as never,
    codex as never,
    claude as never
  );

  const result = await service.run(makeRunInput('mock'));

  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeType, 'mock');
  assert.equal(service.listInvocations('session-1').length, 1);
});
