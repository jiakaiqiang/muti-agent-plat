import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';

const originalFetch = globalThis.fetch;

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

const agentsStub = { list: () => [] };

const ENV_KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;

function withRemoteEnv() {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_BASE_URL = 'https://relay.test/v1';
  process.env.LLM_API_KEY = 'sk-test';
  process.env.LLM_MODEL = 'test-remote-model';
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test('env-configured remote model is listed and survives local discovery', async () => {
  const restoreEnv = withRemoteEnv();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;

  try {
    const service = new RuntimeModelConfigService(makePersistence() as never, agentsStub as never);
    const config = await service.getConfig();

    const envModel = config.availableModels.find(
      (model) => model.kind === 'remote' && model.model === 'test-remote-model'
    );
    assert.ok(envModel, 'env-configured remote model should appear in availableModels');
    assert.equal(envModel.source, 'env');
    assert.equal(envModel.hasApiKey, true);

    const discoveredLocal = config.availableModels.find((model) => model.model === 'qwen2.5:7b');
    assert.ok(discoveredLocal, 'discovered local model should still be listed');

    assert.equal(config.currentModelId, envModel.id, 'current model must not be hijacked by discovered local models');
    assert.equal(config.currentModelOption.kind, 'remote');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('persisted user-added model keeps priority over env entry with the same id', async () => {
  const restoreEnv = withRemoteEnv();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;

  try {
    const service = new RuntimeModelConfigService(makePersistence() as never, agentsStub as never);
    await service.addModel({
      kind: 'remote',
      model: 'test-remote-model',
      baseUrl: 'https://relay.test/v1',
      apiKey: 'sk-user-added',
      label: '用户添加的中转站'
    });

    const config = await service.getConfig();
    const entries = config.availableModels.filter((model) => model.model === 'test-remote-model');
    assert.equal(entries.length, 1, 'same endpoint+model must not be listed twice');
    assert.equal(entries[0].label, '用户添加的中转站');
    assert.equal(config.currentModelId, entries[0].id);

    const connection = service.connectionForModelId(entries[0].id);
    assert.equal(connection.apiKey, 'sk-user-added', 'persisted apiKey wins over env key');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
