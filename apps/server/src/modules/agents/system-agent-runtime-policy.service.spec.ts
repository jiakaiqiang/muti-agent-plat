import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemAgentRuntimePolicy } from '@agent-cluster/shared';
import { SystemAgentRegistryService } from './system-agent-registry.service.js';
import { SystemAgentRuntimePolicyService } from './system-agent-runtime-policy.service.js';

function fixture() {
  let stored: Record<string, SystemAgentRuntimePolicy> = {};
  const persistence = {
    getCollection<T>(_key: string, fallback: T): T {
      return (Object.keys(stored).length ? structuredClone(stored) : fallback) as T;
    },
    setCollection(_key: string, value: Record<string, SystemAgentRuntimePolicy>) {
      stored = structuredClone(value);
    }
  };
  return {
    service: new SystemAgentRuntimePolicyService(
      persistence as never,
      new SystemAgentRegistryService()
    ),
    stored: () => stored
  };
}

test('system Agent Runtime policy is persisted separately from Agent identity', async () => {
  const setup = fixture();
  const updated = await setup.service.update('intent_router', {
    preferredRuntimeType: 'generic_llm',
    preferredModelId: 'intent-model',
    allowedRuntimeTypes: ['generic_llm', 'codex']
  });

  assert.deepEqual(updated, {
    role: 'intent_router',
    preferredRuntimeType: 'generic_llm',
    preferredModelId: 'intent-model',
    allowedRuntimeTypes: ['generic_llm', 'codex'],
    updatedAt: updated.updatedAt
  });
  assert.equal(setup.stored().intent_router?.preferredModelId, 'intent-model');
});

test('system Agent Runtime policy rejects unsupported or inconsistent routing', async () => {
  const setup = fixture();
  await assert.rejects(
    setup.service.update('coordinator', { allowedRuntimeTypes: ['unsupported' as never] }),
    /unsupported Runtime type/
  );
  await assert.rejects(
    setup.service.update('coordinator', {
      preferredRuntimeType: 'codex',
      allowedRuntimeTypes: ['generic_llm']
    }),
    /Preferred Runtime/
  );
});

test('system Agent Runtime policy can clear preferred Runtime and model without mutating the protected Agent', async () => {
  const setup = fixture();
  await setup.service.update('coordinator', {
    preferredRuntimeType: 'codex',
    preferredModelId: 'model-1',
    allowedRuntimeTypes: ['codex', 'generic_llm']
  });
  const cleared = await setup.service.update('coordinator', {
    preferredRuntimeType: null,
    preferredModelId: null
  });

  assert.equal(cleared.role, 'coordinator');
  assert.equal(cleared.preferredRuntimeType, undefined);
  assert.equal(cleared.preferredModelId, undefined);
  assert.deepEqual(cleared.allowedRuntimeTypes, ['codex', 'generic_llm']);
});
