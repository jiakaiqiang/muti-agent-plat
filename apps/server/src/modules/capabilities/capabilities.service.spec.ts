import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesService } from './capabilities.service.js';

function setup() {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const agents = {
    list: () => []
  };
  const service = new CapabilitiesService(persistence as never, agents as never);
  return { service, collections, agents };
}

test('CapabilitiesService prevents deletion of referenced capabilities', () => {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const service = new CapabilitiesService(persistence as never, { list: () => [] } as never);
  const capability = service.createDefinition({
    key: 'test-tool',
    name: 'Test Tool',
    riskLevel: 'low'
  });

  // Now inject agents that reference this capability
  const agentsWithRef = {
    list: () => [
      { id: 'agent-1', key: 'test-agent', name: 'Test Agent', capabilityIds: [capability.id] }
    ]
  };
  (service as any).agents = agentsWithRef;

  assert.throws(
    () => service.removeDefinition(capability.id),
    /Cannot delete capability.*referenced by 1 agent/
  );
});

test('CapabilitiesService prevents deletion of system capabilities', () => {
  const { service } = setup();
  const systemCap = service.listDefinitions().find((c) => c.systemOwned);
  assert.ok(systemCap, 'Should have at least one system capability');
  assert.throws(
    () => service.removeDefinition(systemCap.id),
    /System capability cannot be deleted/
  );
});

test('CapabilitiesService allows deletion of unreferenced custom capabilities', () => {
  const { service } = setup();
  const capability = service.createDefinition({
    key: 'custom-tool',
    name: 'Custom Tool',
    riskLevel: 'medium'
  });
  const result = service.removeDefinition(capability.id);
  assert.equal(result.removed, true);
  assert.equal(result.capability.id, capability.id);
});

test('CapabilitiesService grants a batch before notifying listeners and ignores duplicate approvals', async () => {
  const { service, collections } = setup();
  const listenerCalls: string[] = [];

  service.registerApprovalListener(({ sessionId, capabilityId, agentId }) => {
    listenerCalls.push(capabilityId);
    assert.equal(service.checkInvocation('cap-command-run', { sessionId, agentId }).allowed, true);
    assert.equal(service.checkInvocation('cap-file-write', { sessionId, agentId }).allowed, true);
  });

  const input = { sessionId: 'session-1', agentId: 'agent-1' };
  const first = await service.approveMany(['cap-command-run', 'cap-file-write', 'cap-command-run'], input);

  assert.deepEqual(first.map((result) => result.capability.id), ['cap-command-run', 'cap-file-write']);
  assert.deepEqual(first.map((result) => result.newlyApproved), [true, true]);
  assert.deepEqual(listenerCalls, ['cap-command-run', 'cap-file-write']);

  const second = await service.approveMany(['cap-command-run', 'cap-file-write'], input);
  assert.deepEqual(second.map((result) => result.newlyApproved), [false, false]);
  assert.deepEqual(listenerCalls, ['cap-command-run', 'cap-file-write']);

  const persisted = collections.get('capabilities') as { approvals: string[] };
  assert.equal(persisted.approvals.filter((key) => key.startsWith('session-1:agent-1:')).length, 2);
});
