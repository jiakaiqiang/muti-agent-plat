import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRoutingInput, WorkspaceCapabilities } from '@agent-cluster/shared';
import { resolveArchitectureRuntimes } from './resolve-architecture-runtimes.js';

function buildInput(overrides: Partial<RuntimeRoutingInput> = {}): RuntimeRoutingInput {
  const capabilities: WorkspaceCapabilities = { read: true, write: false, command: false, test: false };
  return {
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000082',
    taskKind: 'architecture-analysis',
    agentId: 'agent-architect',
    requiredCapabilities: ['read'],
    writeMode: 'none',
    workspace: { workspaceId: 'ws-82', providerKind: 'server_local', capabilities },
    ...overrides
  };
}

test('resolveArchitectureRuntimes returns the full read-eligible set when only read is required', () => {
  const runtimes = resolveArchitectureRuntimes(buildInput());
  assert.deepEqual(runtimes.slice().sort(), ['claude_code', 'code_reader', 'codex', 'generic_llm']);
});

test('resolveArchitectureRuntimes filters runtimes lacking required write capability', () => {
  const runtimes = resolveArchitectureRuntimes(
    buildInput({
      requiredCapabilities: ['read', 'write'],
      workspace: {
        workspaceId: 'ws-82',
        providerKind: 'server_local',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    })
  );
  assert.deepEqual(runtimes.slice().sort(), ['claude_code', 'codex']);
});

test('resolveArchitectureRuntimes returns empty when workspace cannot satisfy required capability', () => {
  const runtimes = resolveArchitectureRuntimes(
    buildInput({
      requiredCapabilities: ['read', 'write'],
      workspace: {
        workspaceId: 'ws-82',
        providerKind: 'browser_broker',
        capabilities: { read: true, write: false, command: false, test: false }
      }
    })
  );
  assert.deepEqual(runtimes, []);
});
