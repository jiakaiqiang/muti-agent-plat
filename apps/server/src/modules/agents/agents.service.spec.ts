import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentDefinition } from '@agent-cluster/shared';
import { AgentsService } from './agents.service.js';
import { SystemAgentRegistryService } from './system-agent-registry.service.js';

function createService(persistedAgents: AgentDefinition[] = []) {
  let persisted = structuredClone(persistedAgents);
  const persistence = {
    getCollection<T>(_key: string, fallback: T): T {
      return (persisted.length ? structuredClone(persisted) : fallback) as T;
    },
    setCollection(_key: string, value: AgentDefinition[]) {
      persisted = structuredClone(value);
    }
  };
  const registry = new SystemAgentRegistryService();
  return {
    service: new AgentsService(persistence as never, registry, undefined),
    persisted: () => persisted
  };
}

test('system Agents are management-only and omitted from default chat selection', () => {
  const { service } = createService();
  const managementKeys = service.listForSurface('management').map((agent) => agent.key);
  const chatKeys = service.listForSurface('chat').map((agent) => agent.key);

  assert.ok(managementKeys.includes('coordinator'));
  assert.ok(managementKeys.includes('system-intent-router'));
  assert.equal(chatKeys.includes('coordinator'), false);
  assert.equal(chatKeys.includes('system-intent-router'), false);
  assert.deepEqual(service.resolveIds(), service.listForSurface('chat').map((agent) => agent.id));
  assert.throws(() => service.resolveIds(['coordinator']), /not available on chat/i);
});

test('system Agent protected fields cannot be changed while profile fields remain editable', () => {
  const { service } = createService();
  const coordinator = service.resolveSystemRole('coordinator');

  assert.throws(
    () => service.update(coordinator.id, { status: 'disabled' }),
    (error: unknown) => (error as { response?: { code?: string } }).response?.code === 'SYSTEM_AGENT_PROTECTED_FIELD'
  );
  const updated = service.update(coordinator.id, {
    name: '系统协调者',
    profileMarkdown: '# 系统协调者\n\n只负责任务编排。'
  });
  assert.equal(updated.name, '系统协调者');
  assert.equal(updated.status, 'active');
  assert.equal(updated.management?.systemRole, 'coordinator');
});

test('registry self-heals persisted attempts to expose or disable a system Agent', () => {
  const seed = createService().service.resolveSystemRole('intent_router');
  const contaminated: AgentDefinition = {
    ...seed,
    status: 'disabled',
    key: 'system-intent-router',
    management: {
      owner: 'user',
      protected: false,
      allowedSurfaces: ['management', 'chat', 'workflow', 'mention'],
      editableFields: ['name', 'description', 'profileMarkdown']
    }
  };
  const { service } = createService([contaminated]);
  const router = service.resolveSystemRole('intent_router');

  assert.equal(router.status, 'active');
  assert.equal(router.management?.owner, 'system');
  assert.deepEqual(router.management?.allowedSurfaces, ['management']);
  assert.equal(service.listForSurface('chat').some((agent) => agent.id === router.id), false);
});
