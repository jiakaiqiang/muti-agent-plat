import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRoutingInput, WorkspaceCapabilities } from '@agent-cluster/shared';
import { evaluateCommandAvailability } from './evaluate-command-availability.js';

function input(overrides: Partial<RuntimeRoutingInput> = {}): RuntimeRoutingInput {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: false, test: false };
  return {
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000090',
    taskKind: 'implementation',
    agentId: 'agent-implementer',
    requiredCapabilities: ['read', 'write', 'command'],
    writeMode: 'propose_changes',
    workspace: { workspaceId: 'ws-90', providerKind: 'browser_broker', capabilities },
    ...overrides
  };
}

test('evaluateCommandAvailability blocks browser broker for command tasks', () => {
  const decision = evaluateCommandAvailability(input());
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.reason, 'command-workspace-unavailable');
  assert.match(decision.hint, /server_local|local_bridge/);
});

test('evaluateCommandAvailability passes on server_local workspaces with command capability', () => {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: true, test: true };
  const decision = evaluateCommandAvailability(
    input({ workspace: { workspaceId: 'ws-90', providerKind: 'server_local', capabilities } })
  );
  assert.equal(decision.ok, true);
});

test('evaluateCommandAvailability passes when task does not need command capability', () => {
  const decision = evaluateCommandAvailability(
    input({ requiredCapabilities: ['read'], writeMode: 'none' })
  );
  assert.equal(decision.ok, true);
});

test('evaluateCommandAvailability blocks direct_audited writeMode on non-command workspaces', () => {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: false, test: false };
  const decision = evaluateCommandAvailability(
    input({
      requiredCapabilities: ['read', 'write'],
      writeMode: 'direct_audited',
      workspace: { workspaceId: 'ws-90', providerKind: 'browser_broker', capabilities }
    })
  );
  assert.equal(decision.ok, false);
});
