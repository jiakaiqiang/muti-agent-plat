import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  CapabilityDefinition,
  CompiledAgentIdentity,
  WorkspaceCapabilities
} from '@agent-cluster/shared';
import { ToolAuthorityResolverService } from './tool-authority-resolver.service.js';

const definitions: CapabilityDefinition[] = [
  {
    id: 'cap-file-read',
    key: 'tool.file_read',
    kind: 'tool',
    name: 'Read files',
    riskLevel: 'low',
    status: 'active',
    systemOwned: true
  },
  {
    id: 'cap-file-write',
    key: 'tool.file_write',
    kind: 'tool',
    name: 'Write files',
    riskLevel: 'high',
    status: 'active',
    systemOwned: true
  },
  {
    id: 'cap-command-run',
    key: 'tool.command_run',
    kind: 'tool',
    name: 'Run tests',
    riskLevel: 'high',
    status: 'active',
    systemOwned: true
  }
];

const allWorkspaceCapabilities: WorkspaceCapabilities = {
  read: true,
  write: true,
  command: true,
  test: true
};

function identity(toolIds: string[], grants = toolIds): CompiledAgentIdentity {
  const keys = toolIds.map((id) => definitions.find((definition) => definition.id === id)?.key ?? id);
  return {
    agentId: 'agent-1',
    key: 'worker',
    name: 'Worker',
    role: 'Implement tasks',
    systemPrompt: 'Work carefully.',
    profileHash: 'profile-hash',
    profileRevision: 3,
    skillBindings: [],
    requestedToolIds: toolIds,
    requestedToolKeys: keys,
    capabilityIds: grants,
    knowledgeBaseIds: []
  };
}

function setup(options?: { approvalAllowed?: boolean; omitTool?: string; onCheckInvocation?: () => void }) {
  const approvalAllowed = options?.approvalAllowed ?? true;
  const capabilities = {
    findDefinitionById: (id: string) => definitions.find((definition) => definition.id === id),
    checkInvocation: (id: string) => {
      options?.onCheckInvocation?.();
      return {
        allowed: definitions.find((definition) => definition.id === id)?.riskLevel !== 'high' || approvalAllowed,
        approvalKey: `session-1:agent-1:${id}`,
        requiresUserConfirmation: !approvalAllowed
      };
    }
  };
  const descriptors = new Map([
    ['read_file', { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
    ['write_file', { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }],
    ['run_test', { name: 'run_test', description: 'Run tests', inputSchema: { type: 'object' } }]
  ]);
  if (options?.omitTool) descriptors.delete(options.omitTool);
  const registry = {
    getTool: (name: string) => {
      const descriptor = descriptors.get(name);
      return descriptor ? { ...descriptor, category: 'custom', riskLevel: 'low' } : undefined;
    }
  };
  return new ToolAuthorityResolverService(capabilities as never, registry as never);
}

function resolve(
  resolver: ToolAuthorityResolverService,
  agent: CompiledAgentIdentity,
  overrides: Partial<Parameters<ToolAuthorityResolverService['resolve']>[0]> = {}
) {
  return resolver.resolve({
    identity: agent,
    phase: 'task_execution',
    workspaceCapabilities: allWorkspaceCapabilities,
    runtimeSupportedToolNames: ['read_file', 'write_file', 'run_test'],
    sessionId: 'session-1',
    ...overrides
  });
}

test('allows a requested Tool only when the Agent capability grant exists', () => {
  const catalog = resolve(setup(), identity(['cap-file-read']));
  assert.deepEqual(catalog.tools.map((tool) => tool.name), ['read_file']);
  assert.equal(catalog.decisions[0]?.status, 'allowed');
});

test('never exposes a granted Tool that the Profile did not request', () => {
  const catalog = resolve(setup(), identity([], ['cap-file-read', 'cap-file-write']));
  assert.deepEqual(catalog.tools, []);
  assert.deepEqual(catalog.decisions, []);
});

test('blocks a requested Tool when the Agent grant is missing', () => {
  const catalog = resolve(setup(), identity(['cap-file-read'], []));
  assert.deepEqual(catalog.tools, []);
  assert.deepEqual(catalog.decisions[0]?.reasons, ['AGENT_CAPABILITY_MISSING']);
});

test('phase policy blocks write tools outside task execution', () => {
  let approvalChecks = 0;
  const catalog = resolve(
    setup({ approvalAllowed: false, onCheckInvocation: () => { approvalChecks += 1; } }),
    identity(['cap-file-write']),
    { phase: 'discussion' }
  );
  assert.deepEqual(catalog.tools, []);
  assert.deepEqual(catalog.decisions[0]?.reasons, ['PHASE_BLOCKED']);
  assert.equal(approvalChecks, 0);
});

test('workspace capability intersection blocks unsupported writes', () => {
  const catalog = resolve(setup(), identity(['cap-file-write']), {
    workspaceCapabilities: { ...allWorkspaceCapabilities, write: false }
  });
  assert.deepEqual(catalog.tools, []);
  assert.ok(catalog.decisions[0]?.reasons.includes('WORKSPACE_CAPABILITY_MISSING:write'));
});

test('runtime support intersection blocks tools the selected Adapter cannot enforce', () => {
  const catalog = resolve(setup(), identity(['cap-file-write']), {
    runtimeSupportedToolNames: ['read_file']
  });
  assert.deepEqual(catalog.tools, []);
  assert.ok(catalog.decisions[0]?.reasons.includes('RUNTIME_TOOL_UNSUPPORTED:write_file'));
});

test('high-risk tools remain blocked until human approval exists', () => {
  const catalog = resolve(setup({ approvalAllowed: false }), identity(['cap-command-run']));
  assert.deepEqual(catalog.tools, []);
  assert.equal(catalog.decisions[0]?.approvalId, 'session-1:agent-1:cap-command-run');
  assert.ok(catalog.decisions[0]?.reasons.includes('HUMAN_APPROVAL_REQUIRED'));
});

test('blocks a capability when a mapped executable Tool is not registered', () => {
  const catalog = resolve(setup({ omitTool: 'write_file' }), identity(['cap-file-write']));
  assert.deepEqual(catalog.tools, []);
  assert.ok(catalog.decisions[0]?.reasons.includes('TOOL_EXECUTOR_UNAVAILABLE:write_file'));
});

test('catalog ordering and hash are deterministic across request order', () => {
  const resolver = setup();
  const left = resolve(resolver, identity(['cap-file-write', 'cap-file-read']));
  const right = resolve(resolver, identity(['cap-file-read', 'cap-file-write']));
  assert.deepEqual(left.tools, right.tools);
  assert.deepEqual(left.decisions, right.decisions);
  assert.equal(left.catalogHash, right.catalogHash);
  assert.match(left.catalogHash, /^[a-f0-9]{64}$/);
});

test('each allowed decision records all six authority intersections', () => {
  const catalog = resolve(setup(), identity(['cap-file-read']));
  assert.deepEqual(catalog.decisions[0]?.reasons, [
    'PROFILE_REQUESTED',
    'AGENT_CAPABILITY_GRANTED',
    'PHASE_ALLOWED',
    'WORKSPACE_ALLOWED',
    'RUNTIME_SUPPORTED',
    'APPROVAL_SATISFIED'
  ]);
});
