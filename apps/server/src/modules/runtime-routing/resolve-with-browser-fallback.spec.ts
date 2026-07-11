import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRoutingInput, WorkspaceCapabilities } from '@agent-cluster/shared';
import { resolveWithBrowserFallback } from './resolve-with-browser-fallback.js';

function browserInput(overrides: Partial<RuntimeRoutingInput> = {}): RuntimeRoutingInput {
  const capabilities: WorkspaceCapabilities = { read: true, write: false, command: false, test: false };
  return {
    phase: 'execution',
    sessionId: '00000000-0000-4000-8000-000000000089',
    taskKind: 'architecture-analysis',
    agentId: 'agent-architect',
    agentPreferredRuntime: 'codex',
    requiredCapabilities: ['read'],
    writeMode: 'none',
    workspace: { workspaceId: 'ws-89', providerKind: 'browser_broker', capabilities },
    ...overrides
  };
}

test('resolveWithBrowserFallback downgrades codex to generic_llm on command-less browser broker', () => {
  const target = resolveWithBrowserFallback({
    input: browserInput(),
    eligibleRuntimes: ['codex', 'claude_code']
  });
  assert.equal(target.runtimeType, 'generic_llm');
  assert.equal(target.fallbackFrom, 'codex');
  assert.equal(target.fallbackReason, 'browser-broker-lacks-command-capability');
  assert.equal(target.source, 'smart_router');
});

test('resolveWithBrowserFallback keeps codex when browser broker exposes command capability', () => {
  const capabilities: WorkspaceCapabilities = { read: true, write: true, command: true, test: true };
  const target = resolveWithBrowserFallback({
    input: browserInput({
      workspace: { workspaceId: 'ws-89', providerKind: 'browser_broker', capabilities }
    }),
    eligibleRuntimes: ['codex']
  });
  assert.equal(target.runtimeType, 'codex');
  assert.equal(target.fallbackReason, undefined);
});

test('resolveWithBrowserFallback leaves non-browser workspaces alone', () => {
  const capabilities: WorkspaceCapabilities = { read: true, write: false, command: false, test: false };
  const target = resolveWithBrowserFallback({
    input: browserInput({
      workspace: { workspaceId: 'ws-89', providerKind: 'server_local', capabilities }
    }),
    eligibleRuntimes: ['codex']
  });
  assert.equal(target.runtimeType, 'codex');
  assert.equal(target.fallbackReason, undefined);
});
