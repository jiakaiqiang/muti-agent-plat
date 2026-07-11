import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRoutingInput, WorkspaceCapabilities } from '@agent-cluster/shared';
import { resolveCodingRuntimes } from './resolve-coding-runtimes.js';

function buildInput(overrides: Partial<RuntimeRoutingInput> = {}): RuntimeRoutingInput {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: true, test: true };
  return {
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000083',
    taskKind: 'implementation',
    agentId: 'agent-implementer',
    requiredCapabilities: [],
    writeMode: 'propose_changes',
    workspace: { workspaceId: 'ws-83', providerKind: 'server_local', capabilities },
    ...overrides
  };
}

test('resolveCodingRuntimes returns codex and claude_code on a fully capable server workspace', () => {
  const runtimes = resolveCodingRuntimes(buildInput());
  assert.deepEqual(runtimes.slice().sort(), ['claude_code', 'codex']);
});

test('resolveCodingRuntimes excludes browser_broker workspaces from command-heavy coding tasks', () => {
  const runtimes = resolveCodingRuntimes(
    buildInput({
      workspace: {
        workspaceId: 'ws-83',
        providerKind: 'browser_broker',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    })
  );
  assert.deepEqual(runtimes, []);
});

test('resolveCodingRuntimes still returns coding runtimes when only read+write is required', () => {
  const runtimes = resolveCodingRuntimes(
    buildInput({
      requiredCapabilities: ['read', 'write'],
      workspace: {
        workspaceId: 'ws-83',
        providerKind: 'browser_broker',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    })
  );
  assert.deepEqual(runtimes.slice().sort(), ['claude_code', 'codex']);
});
