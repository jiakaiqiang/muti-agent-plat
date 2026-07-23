import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';

const ENV_KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'AGENT_CLUSTER_SECRET_KEY'] as const;

function withRemoteEnv() {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_BASE_URL = 'https://relay.test/v1';
  process.env.LLM_API_KEY = 'sk-env-should-not-persist';
  process.env.LLM_MODEL = 'test-remote-model';
  process.env.AGENT_CLUSTER_SECRET_KEY = 'runtime-model-persistence-test-master-key';
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makePersistence() {
  const collections = new Map<string, unknown>();
  return {
    getCollection<T>(name: string, fallback: T): T {
      return (collections.get(name) as T | undefined) ?? fallback;
    },
    setCollection(name: string, value: unknown) {
      collections.set(name, value);
    },
    dump() {
      return collections;
    }
  };
}

test('addModel persists the runtime state without the plaintext apiKey', async () => {
  const restoreEnv = withRemoteEnv();
  const persistence = makePersistence();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
  try {
    const service = new RuntimeModelConfigService(persistence as never);
    await service.addModel({
      kind: 'remote',
      model: 'my-remote-model',
      label: 'my model',
      baseUrl: 'https://relay.test/v1',
      apiKey: 'sk-user-plaintext-abcdef'
    });

    const raw = JSON.stringify(Array.from(persistence.dump().entries()));
    assert.equal(raw.includes('sk-user-plaintext-abcdef'), false, 'plaintext user key must not appear on disk');

    const connection = service.currentConnection();
    assert.equal(connection.apiKey, 'sk-user-plaintext-abcdef', 'runtime access still returns plaintext for outbound calls');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
