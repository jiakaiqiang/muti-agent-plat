import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter, RuntimeHealthStatus, RuntimeType } from '@agent-cluster/shared';
import { RuntimeSmartRouterService } from './runtime-smart-router.service.js';

function makeAdapter(
  type: RuntimeType,
  category: 'internal' | 'external',
  capabilityIds: string[],
  health: RuntimeHealthStatus | Error | undefined = { status: 'healthy', lastCheckAt: '2026-06-22T00:00:00.000Z' }
): AgentRuntimeAdapter {
  return {
    type,
    metadata: {
      name: type,
      version: '0.1.0',
      category,
      provider: category === 'internal' ? 'self-hosted' : 'external',
      capabilityIds
    },
    async healthCheck() {
      if (health instanceof Error) {
        throw health;
      }
      return health ?? { status: 'healthy', lastCheckAt: '2026-06-22T00:00:00.000Z' };
    },
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      return {
        runId: input.runId,
        runtimeType: type,
        status: 'completed',
        output: { kind: 'agent_message', messageKind: 'summary', content: 'ok' },
        events: [],
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    }
  };
}

function makeRegistry(adapters: AgentRuntimeAdapter[]) {
  return {
    getAdapter(type: RuntimeType) {
      return adapters.find((adapter) => adapter.type === type);
    },
    listByCategory(category: 'internal' | 'external') {
      return adapters.filter((adapter) => adapter.metadata?.category === category);
    }
  };
}

test('selects a healthy preferred runtime without fallback', async () => {
  const preferred = makeAdapter('codex', 'external', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([preferred]) as never);

  const selected = await service.selectRuntime(['cap-file-read'], { preferredRuntimeType: 'codex' });

  assert.equal(selected.adapter, preferred);
  assert.equal(selected.fallbackUsed, false);
  assert.match(selected.reason, /preferred/);
});

test('throws when preferred runtime is unavailable and fallback is disabled', async () => {
  const preferred = makeAdapter('codex', 'external', ['cap-file-read'], {
    status: 'unhealthy',
    lastCheckAt: '2026-06-22T00:00:00.000Z'
  });
  const service = new RuntimeSmartRouterService(makeRegistry([preferred]) as never);

  await assert.rejects(
    () => service.selectRuntime(['cap-file-read'], { preferredRuntimeType: 'codex', allowFallback: false }),
    /Preferred runtime unavailable: codex/
  );
});

test('selects healthy internal runtime before external runtime', async () => {
  const internal = makeAdapter('code_reader', 'internal', ['cap-file-read']);
  const external = makeAdapter('codex', 'external', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([external, internal]) as never);

  const selected = await service.selectRuntime(['cap-file-read']);

  assert.equal(selected.adapter, internal);
  assert.equal(selected.fallbackUsed, true);
  assert.match(selected.reason, /internal/);
});

test('falls back to external runtime when internal is unhealthy', async () => {
  const internal = makeAdapter('code_reader', 'internal', ['cap-file-read'], {
    status: 'unhealthy',
    lastCheckAt: '2026-06-22T00:00:00.000Z'
  });
  const external = makeAdapter('codex', 'external', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([internal, external]) as never);

  const selected = await service.selectRuntime(['cap-file-read']);

  assert.equal(selected.adapter, external);
  assert.match(selected.reason, /external/);
});

test('falls back to generic_llm when no candidate matches capabilities', async () => {
  const internal = makeAdapter('code_reader', 'internal', ['cap-file-read']);
  const generic = makeAdapter('generic_llm', 'external', []);
  const service = new RuntimeSmartRouterService(makeRegistry([internal, generic]) as never);

  const selected = await service.selectRuntime(['cap-nonexistent']);

  assert.equal(selected.adapter, generic);
  assert.match(selected.reason, /generic_llm/);
});

test('skips excluded runtimes while selecting candidates', async () => {
  const first = makeAdapter('code_reader', 'internal', ['cap-file-read']);
  const second = makeAdapter('mock', 'internal', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([first, second]) as never);

  const selected = await service.selectRuntime(['cap-file-read'], { excludeRuntimeTypes: ['code_reader'] });

  assert.equal(selected.adapter, second);
});

test('does not prefer internal runtime when preferInternal is false', async () => {
  const internal = makeAdapter('code_reader', 'internal', ['cap-file-read']);
  const external = makeAdapter('codex', 'external', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([internal, external]) as never);

  const selected = await service.selectRuntime(['cap-file-read'], { preferInternal: false });

  assert.equal(selected.adapter, external);
});

test('skips runtime when healthCheck throws', async () => {
  const broken = makeAdapter('code_reader', 'internal', ['cap-file-read'], new Error('boom'));
  const healthy = makeAdapter('mock', 'internal', ['cap-file-read']);
  const service = new RuntimeSmartRouterService(makeRegistry([broken, healthy]) as never);

  const selected = await service.selectRuntime(['cap-file-read']);

  assert.equal(selected.adapter, healthy);
});

test('throws when no candidate and generic_llm fallback is missing', async () => {
  const service = new RuntimeSmartRouterService(makeRegistry([]) as never);

  await assert.rejects(() => service.selectRuntime(['cap-file-read']), /No runtime available/);
});
