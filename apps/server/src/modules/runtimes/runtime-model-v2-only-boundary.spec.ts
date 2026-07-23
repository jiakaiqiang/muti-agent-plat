import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';

type Seed = Record<string, unknown>;

function persistence(seed: Seed = {}) {
  const collections = new Map<string, unknown>(Object.entries(seed));
  return {
    getCollection<T>(name: string, fallback: T): T {
      return (collections.get(name) as T | undefined) ?? fallback;
    },
    setCollection(name: string, value: unknown) {
      collections.set(name, value);
    },
    read(name: string) {
      return collections.get(name);
    }
  };
}

const serviceSource = readFileSync(new URL('./runtime-model-config.service.ts', import.meta.url), 'utf8');
const sharedSource = readFileSync(
  new URL('../../../../../packages/shared/src/contracts.ts', import.meta.url),
  'utf8'
);

test('RuntimeModelConfigService has no AgentsService dependency', () => {
  assert.doesNotMatch(serviceSource, /AgentsService|agents\.service/);
});

test('RuntimeModelConfigService constructor accepts persistence only', () => {
  assert.equal(RuntimeModelConfigService.length, 1);
});

test('RuntimeModelOption contract has no Agent binding field', () => {
  const start = sharedSource.indexOf('export type RuntimeModelOption');
  const block = sharedSource.slice(start, sharedSource.indexOf('\n};', start) + 3);
  assert.ok(start >= 0);
  assert.doesNotMatch(block, /agents|agentIds|agentKeys/);
});

test('Runtime model responses never expose Agent bindings', () => {
  const service = new RuntimeModelConfigService(persistence() as never);
  for (const option of service.getConfigSnapshot().availableModels) {
    assert.equal('agents' in option, false);
  }
});

test('legacy currentModel storage is rejected at startup', () => {
  assert.throws(
    () => new RuntimeModelConfigService(persistence({ runtimeModelConfig: { currentModel: 'legacy' } }) as never),
    /CUTOVER_REQUIRED/
  );
});

test('legacy customModels storage is rejected at startup', () => {
  assert.throws(
    () => new RuntimeModelConfigService(persistence({ runtimeModelConfig: { customModels: [] } }) as never),
    /CUTOVER_REQUIRED/
  );
});

test('legacy model-level Agent bindings are rejected at startup', () => {
  assert.throws(
    () => new RuntimeModelConfigService(persistence({
      runtimeModelConfig: {
        models: [{
          id: 'remote:legacy:model',
          label: 'legacy',
          provider: 'openai-compatible',
          source: 'remote',
          kind: 'remote',
          model: 'model',
          agents: ['agent-1'],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z'
        }]
      }
    }) as never),
    /CUTOVER_REQUIRED/
  );
});

test('v2 persisted model records remain model-only after startup', () => {
  const store = persistence({
    runtimeModelConfig: {
      currentModelId: 'local:local:qwen',
      models: [{
        id: 'local:local:qwen',
        label: 'qwen',
        provider: 'ollama',
        source: 'local',
        kind: 'local',
        model: 'qwen',
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z'
      }]
    }
  });
  new RuntimeModelConfigService(store as never);
  const saved = store.read('runtimeModelConfig') as { models: Array<Record<string, unknown>> };
  assert.equal(saved.models.length, 1);
  assert.equal('agents' in saved.models[0], false);
});
