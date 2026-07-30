import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentDefinition,
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  ResolvedToolCatalog,
  RuntimeType,
  WorkspaceCapabilities
} from '@agent-cluster/shared';
import {
  InvocationResolutionError,
  InvocationResolverService,
  type InvocationRuntimeCandidate
} from './invocation-resolver.service.js';

const agent: AgentDefinition = {
  id: 'agent-1',
  key: 'worker',
  name: 'Worker',
  role: 'Implement tasks',
  profileMarkdown: '# Worker',
  tags: [],
  status: 'active',
  capabilityIds: ['cap-file-read'],
  defaultKnowledgeBaseIds: [],
  profileRevision: 2,
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z'
};

const compiledIdentity: CompiledAgentIdentity = {
  agentId: agent.id,
  key: agent.key,
  name: agent.name,
  role: agent.role,
  systemPrompt: 'Read the workspace.',
  profileHash: 'profile-hash',
  profileRevision: agent.profileRevision,
  skillBindings: [],
  requestedToolIds: ['cap-file-read'],
  requestedToolKeys: ['tool.file_read'],
  capabilityIds: ['cap-file-read'],
  knowledgeBaseIds: []
};

const toolFreeIdentity: CompiledAgentIdentity = {
  ...compiledIdentity,
  requestedToolIds: [],
  requestedToolKeys: [],
  capabilityIds: []
};

const catalog: ResolvedToolCatalog = {
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
  decisions: [
    {
      toolId: 'cap-file-read',
      toolKey: 'tool.file_read',
      status: 'allowed',
      reasons: ['PROFILE_REQUESTED']
    }
  ],
  catalogHash: 'catalog-hash'
};

const workspaceCapabilities: WorkspaceCapabilities = {
  read: true,
  write: true,
  command: true,
  test: true
};

function candidate(
  runtimeType: RuntimeType,
  overrides: Partial<InvocationRuntimeCandidate> = {}
): InvocationRuntimeCandidate {
  return {
    runtimeType,
    available: true,
    supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'],
    supportedToolNames: ['read_file', 'write_file', 'run_test'],
    ...overrides
  };
}

function envelope(): ContextEnvelopeV2 {
  return {
    version: 'v2',
    createdAt: '2026-07-12T00:00:00.000Z',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    L0: {
      systemRules: [],
      agentId: 'agent-1',
      profileHash: 'profile-hash',
      profileRevision: 3,
      toolCatalogHash: 'catalog-hash',
      workspace: {
        workspaceId: 'workspace-1',
        rootName: 'repo',
        providerKind: 'server_local',
        revision: { id: 'rev-1', observedAt: '2026-07-12T00:00:00.000Z' }
      }
    },
    L1: { sessionGoal: 'Implement', phase: 'task_execution', navigation: { entries: [], truncated: false } },
    L2: { source: 'static', modules: [] },
    L3: { files: [], totalByteLength: 0, truncated: false },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 0, navigationTokens: 0, projectMapTokens: 0, evidenceTokens: 0 }
  };
}

function setup(options?: {
  blockedCatalog?: boolean;
  blockedReasons?: string[];
  runtimeCandidates?: InvocationRuntimeCandidate[];
  localRuntimeCandidates?: InvocationRuntimeCandidate[];
  compiledIdentity?: CompiledAgentIdentity;
}) {
  const calls: Array<{
    runtimeSupportedToolNames: readonly string[];
    workspaceCapabilities: WorkspaceCapabilities;
    allowedToolNames?: readonly string[];
  }> = [];
  const profileCompiler = {
    compileIdentity: () => options?.compiledIdentity ?? compiledIdentity
  };
  const toolAuthority = {
    resolve: (input: {
      runtimeSupportedToolNames: readonly string[];
      workspaceCapabilities: WorkspaceCapabilities;
      allowedToolNames?: readonly string[];
    }) => {
      calls.push(input);
      return options?.blockedCatalog
        ? {
            tools: [],
            decisions: [{
              toolId: 'cap-file-read',
              toolKey: 'tool.file_read',
              status: 'blocked',
              reasons: options.blockedReasons ?? ['blocked']
            }],
            catalogHash: 'blocked'
          }
        : catalog;
    }
  };
  const runtimeCandidates = options?.runtimeCandidates ?? [candidate('codex'), candidate('generic_llm')];
  const localRuntimeCandidateCalls: string[] = [];
  const registry = {
    listAll: () => runtimeCandidates.map((item) => ({
      type: item.runtimeType,
      metadata: {
        name: item.runtimeType,
        version: '2.0.0',
        category: 'external',
        provider: 'test',
        capabilityIds: [],
        supportedWorkspaceCapabilities: item.supportedWorkspaceCapabilities,
        supportedWorkspaceProviderKinds: item.supportedWorkspaceProviderKinds,
        supportedToolNames: item.supportedToolNames
      }
    }))
  };
  const localRuntime = {
    listRuntimeCandidates: (workspaceId: string) => {
      localRuntimeCandidateCalls.push(workspaceId);
      return options?.localRuntimeCandidates ?? [];
    }
  };
  return {
    resolver: new InvocationResolverService(
      profileCompiler as never,
      toolAuthority as never,
      registry as never,
      localRuntime as never
    ),
    calls,
    localRuntimeCandidateCalls
  };
}

function resolve(
  resolver: InvocationResolverService,
  overrides: Partial<Parameters<InvocationResolverService['resolve']>[0]> = {}
) {
  return resolver.resolve({
    invocationId: 'invocation-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    taskKind: 'implementation',
    phase: 'task_execution',
    agent,
    taskRequiresCodeChanges: false,
    workspace: {
      workspaceId: 'workspace-1',
      providerKind: 'server_local',
      capabilities: workspaceCapabilities
    },
    smartRouterPick: 'generic_llm',
    globalDefaultRuntime: 'codex',
    contextEnvelopeFactory: () => envelope(),
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    budget: { maxInputTokens: 4000 },
    ...overrides
  });
}

test('compiles an immutable Agent identity before producing the InvocationPlan', () => {
  const { resolver } = setup();
  const plan = resolve(resolver);
  assert.equal(plan.agent, compiledIdentity);
  assert.equal('runtimeType' in plan.agent, false);
});

test('proposal_only removes write, command, and test requirements before Runtime selection', () => {
  const proposalAgent = {
    ...agent,
    capabilityIds: ['cap-file-write', 'cap-command-run']
  };
  const proposalIdentity = {
    ...compiledIdentity,
    requestedToolIds: ['cap-file-write', 'cap-command-run'],
    requestedToolKeys: ['tool.file_write', 'tool.command_run'],
    capabilityIds: ['cap-file-write', 'cap-command-run']
  };
  const { resolver, calls } = setup({ compiledIdentity: proposalIdentity });
  const plan = resolve(resolver, {
    agent: proposalAgent,
    taskRequiresCodeChanges: true,
    writeModeOverride: 'proposal_only'
  });

  assert.equal(plan.executionTarget.writeMode, 'proposal_only');
  assert.deepEqual(plan.executionTarget.requiredCapabilities, ['read']);
  assert.deepEqual(calls[0]?.allowedToolNames, ['read_file', 'search_code']);
});

test('eligible task override has the highest routing priority', () => {
  const { resolver } = setup();
  const plan = resolve(resolver, { taskOverride: { runtimeType: 'codex', modelId: 'gpt-5' } });
  assert.equal(plan.executionTarget.runtimeType, 'codex');
  assert.equal(plan.executionTarget.modelId, 'gpt-5');
  assert.equal(plan.executionTarget.source, 'task_override');
});

test('ineligible task override falls through to an eligible session preference', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('generic_llm')] });
  const plan = resolve(resolver, {
    taskOverride: { runtimeType: 'codex' },
    sessionPreference: { preferredRuntimeType: 'generic_llm', preferredModelId: 'local-model' }
  });
  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.equal(plan.executionTarget.modelId, 'local-model');
  assert.equal(plan.executionTarget.source, 'session_preference');
});

test('session allowedRuntimeTypes constrains every lower-priority strategy', () => {
  const { resolver } = setup();
  const plan = resolve(resolver, {
    sessionPreference: { allowedRuntimeTypes: ['codex'] },
    smartRouterPick: 'generic_llm'
  });
  assert.equal(plan.executionTarget.runtimeType, 'codex');
});

test('project policy wins over smart router and global default', () => {
  const { resolver } = setup();
  const plan = resolve(resolver, { projectPolicyRuntime: 'codex' });
  assert.equal(plan.executionTarget.runtimeType, 'codex');
  assert.equal(plan.executionTarget.source, 'project_policy');
});

test('fails closed when no Runtime satisfies workspace and Tool requirements', () => {
  const { resolver } = setup({
    runtimeCandidates: [candidate('codex', { supportedToolNames: [] })]
  });
  assert.throws(
    () => resolve(resolver),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('Profile Tool requirements participate in Runtime eligibility', () => {
  const { resolver, calls } = setup({
    runtimeCandidates: [
      candidate('codex', { supportedToolNames: [] }),
      candidate('generic_llm', { supportedToolNames: ['read_file'] })
    ]
  });
  const plan = resolve(resolver, { smartRouterPick: 'codex' });
  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.deepEqual(plan.executionTarget.requiredToolIds, ['cap-file-read']);
  assert.deepEqual(calls[0]?.runtimeSupportedToolNames, ['read_file']);
});

test('Agent fields cannot supply a Runtime preference', () => {
  const { resolver } = setup();
  const contaminatedAgent = { ...agent, runtimeType: 'codex', modelId: 'forbidden' } as AgentDefinition;
  const plan = resolve(resolver, { agent: contaminatedAgent, smartRouterPick: 'generic_llm' });
  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.equal(plan.executionTarget.modelId, undefined);
});

test('strict session Runtime allowlist prevents fallback to another registered Runtime', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('generic_llm')] });
  assert.throws(
    () => resolve(resolver, {
      sessionPreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('explicit exclusions select the next eligible Runtime inside the session allowlist', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('claude_code'), candidate('codex'), candidate('generic_llm')] });
  const plan = resolve(resolver, {
    sessionPreference: {
      preferredRuntimeType: 'claude_code',
      allowedRuntimeTypes: ['claude_code', 'codex', 'generic_llm']
    },
    excludedRuntimeTypes: ['claude_code'],
    smartRouterPick: 'codex'
  });
  assert.equal(plan.executionTarget.runtimeType, 'codex');
  assert.equal(plan.executionTarget.source, 'smart_router');
});

test('explicit exclusions never bypass a strict session allowlist', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('claude_code'), candidate('codex')] });
  assert.throws(
    () => resolve(resolver, {
      sessionPreference: { preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['claude_code'] },
      excludedRuntimeTypes: ['claude_code']
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('server-local code changes continue to require command capability', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('mock')] });
  assert.throws(
    () => resolve(resolver, {
      taskRequiresCodeChanges: true,
      workspace: {
        workspaceId: 'server-workspace',
        providerKind: 'server_local',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('local bridge code changes continue to require command capability', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('mock')] });
  assert.throws(
    () => resolve(resolver, {
      taskRequiresCodeChanges: true,
      workspace: {
        workspaceId: 'bridge-workspace',
        providerKind: 'local_bridge',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('local bridge discussion selects candidates advertised by the connected Local Runtime', () => {
  const { resolver, localRuntimeCandidateCalls } = setup({
    runtimeCandidates: [candidate('codex', { supportedWorkspaceProviderKinds: ['server_local'] })],
    localRuntimeCandidates: [candidate('claude_code', {
      supportedWorkspaceCapabilities: [],
      supportedWorkspaceProviderKinds: ['local_bridge'],
      supportedToolNames: []
    })],
    compiledIdentity: toolFreeIdentity
  });

  const plan = resolve(resolver, {
    phase: 'discussion',
    taskRequiresCodeChanges: true,
    sessionPreference: {
      preferredRuntimeType: 'claude_code',
      allowedRuntimeTypes: ['claude_code', 'codex']
    },
    workspace: {
      workspaceId: 'local-workspace',
      providerKind: 'local_bridge',
      capabilities: { read: true, write: true, command: true, test: true }
    }
  });

  assert.equal(plan.executionTarget.runtimeType, 'claude_code');
  assert.equal(plan.executionTarget.executionLocation, 'local');
  assert.deepEqual(localRuntimeCandidateCalls, ['local-workspace']);
});

test('local bridge never falls back to a server Runtime when the Local Runtime has no candidate', () => {
  const { resolver } = setup({
    runtimeCandidates: [candidate('codex', { supportedWorkspaceProviderKinds: ['server_local'] })],
    localRuntimeCandidates: [],
    compiledIdentity: toolFreeIdentity
  });

  assert.throws(
    () => resolve(resolver, {
      phase: 'discussion',
      sessionPreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] },
      workspace: {
        workspaceId: 'offline-local-workspace',
        providerKind: 'local_bridge',
        capabilities: { read: true, write: true, command: true, test: true }
      }
    }),
    (error: unknown) =>
      error instanceof InvocationResolutionError &&
      error.code === 'NO_ELIGIBLE_RUNTIME' &&
      error.message.includes('providerKind=local_bridge') &&
      error.message.includes('requiredTools=none')
  );
});

test('server workspace ignores Local Runtime candidates', () => {
  const { resolver, localRuntimeCandidateCalls } = setup({
    runtimeCandidates: [candidate('generic_llm', { supportedWorkspaceProviderKinds: ['server_local'] })],
    localRuntimeCandidates: [candidate('codex', { supportedWorkspaceProviderKinds: ['local_bridge'] })],
    compiledIdentity: toolFreeIdentity
  });

  const plan = resolve(resolver, {
    phase: 'discussion',
    smartRouterPick: 'codex',
    workspace: {
      workspaceId: 'server-workspace',
      providerKind: 'server_local',
      capabilities: { read: true, write: true, command: true, test: true }
    }
  });

  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.equal(plan.executionTarget.executionLocation, 'server');
  assert.deepEqual(localRuntimeCandidateCalls, []);
});

test('server non-code phases remain runnable without workspace capabilities', () => {
  const { resolver } = setup({
    runtimeCandidates: [candidate('mock', { supportedWorkspaceCapabilities: [] })],
    compiledIdentity: toolFreeIdentity
  });
  const plan = resolve(resolver, {
    phase: 'task_execution',
    taskRequiresCodeChanges: false,
    workspace: {
      workspaceId: 'server-workspace',
      providerKind: 'server_local',
      capabilities: { read: false, write: false, command: false, test: false }
    }
  });
  assert.deepEqual(plan.executionTarget.requiredCapabilities, []);
});

test('server workspaces require command/test when an Agent explicitly requests run_test', () => {
  const commandIdentity: CompiledAgentIdentity = {
    ...toolFreeIdentity,
    requestedToolIds: ['cap-command-run'],
    requestedToolKeys: ['tool.command_run'],
    capabilityIds: ['cap-command-run']
  };
  const { resolver } = setup({ runtimeCandidates: [candidate('mock')], compiledIdentity: commandIdentity });
  assert.throws(
    () => resolve(resolver, {
      taskRequiresCodeChanges: false,
      workspace: {
        workspaceId: 'server-workspace',
        providerKind: 'server_local',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

test('Runtime metadata cannot synthesize missing workspace command/test capabilities', () => {
  const commandIdentity: CompiledAgentIdentity = {
    ...toolFreeIdentity,
    requestedToolIds: ['cap-command-run'],
    requestedToolKeys: ['tool.command_run'],
    capabilityIds: ['cap-command-run']
  };
  const { resolver, calls } = setup({
    runtimeCandidates: [candidate('codex', {
      supportedWorkspaceProviderKinds: ['server_local']
    })],
    compiledIdentity: commandIdentity
  });
  assert.throws(
    () => resolve(resolver, {
      sessionPreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] },
      workspace: {
        workspaceId: 'server-workspace',
        providerKind: 'server_local',
        capabilities: { read: true, write: true, command: false, test: false }
      }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
  assert.equal(calls.length, 0);
});

test('does not return an InvocationPlan when Tool Authority blocks a requested Tool', () => {
  const { resolver } = setup({ blockedCatalog: true });
  assert.throws(
    () => resolve(resolver),
    (error: unknown) =>
      error instanceof InvocationResolutionError &&
      error.code === 'CAPABILITY_BLOCKED' &&
      error.message.includes('tool.file_read (blocked)')
  );
});

test('phase policy isolates unavailable profile tools without blocking a read-only invocation', () => {
  const { resolver } = setup({ blockedCatalog: true, blockedReasons: ['PHASE_BLOCKED'] });
  const plan = resolve(resolver, { phase: 'task_acceptance' });
  assert.deepEqual(plan.toolCatalog.tools, []);
  assert.deepEqual(plan.toolCatalog.decisions[0]?.reasons, ['PHASE_BLOCKED']);
});

test('discussion eligibility ignores profile write and test tools that phase policy will block', () => {
  const executionOnlyIdentity: CompiledAgentIdentity = {
    ...toolFreeIdentity,
    requestedToolIds: ['cap-file-write', 'cap-command-run'],
    requestedToolKeys: ['tool.file_write', 'tool.command_run'],
    capabilityIds: ['cap-file-write', 'cap-command-run']
  };
  const { resolver } = setup({
    runtimeCandidates: [candidate('generic_llm', {
      supportedWorkspaceCapabilities: [],
      supportedToolNames: []
    })],
    compiledIdentity: executionOnlyIdentity,
    blockedCatalog: true,
    blockedReasons: ['PHASE_BLOCKED']
  });

  const plan = resolve(resolver, {
    phase: 'discussion',
    taskKind: 'analysis',
    workspace: {
      workspaceId: 'detached-workspace',
      providerKind: 'server_local',
      capabilities: { read: false, write: false, command: false, test: false }
    }
  });

  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.deepEqual(plan.executionTarget.requiredToolIds, []);
  assert.deepEqual(plan.executionTarget.requiredCapabilities, []);
  assert.deepEqual(plan.toolCatalog.decisions[0]?.reasons, ['PHASE_BLOCKED']);
});

test('runtime candidates are derived from registry metadata, not resolve input', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('generic_llm')] });
  const plan = resolve(resolver, { smartRouterPick: 'codex' });
  assert.equal(plan.executionTarget.runtimeType, 'generic_llm');
  assert.equal('runtimeCandidates' in plan, false);
});

test('adapter without explicit workspace and Tool metadata is ineligible', () => {
  const profileCompiler = { compileIdentity: () => compiledIdentity };
  const toolAuthority = { resolve: () => catalog };
  const registry = { listAll: () => [{ type: 'codex', metadata: { name: 'codex', version: '2', category: 'external', provider: 'test', capabilityIds: [] } }] };
  const resolver = new InvocationResolverService(profileCompiler as never, toolAuthority as never, registry as never);
  assert.throws(
    () => resolve(resolver),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});

for (const phase of [
  'discussion',
  'brief_generation',
  'brief_revision',
  'task_acceptance',
  'post_review',
  'final_delivery',
  'user_message_routing'
] as const) {
  test(`${phase} can run from its Envelope without a live Workspace capability`, () => {
    const { resolver } = setup({
      runtimeCandidates: [candidate('mock')],
      compiledIdentity: {
        ...compiledIdentity,
        requestedToolIds: [],
        requestedToolKeys: [],
        capabilityIds: []
      }
    });
    const plan = resolve(resolver, {
      phase,
      taskRequiresCodeChanges: true,
      workspace: {
        workspaceId: 'detached-workspace',
        providerKind: 'server_local',
        capabilities: { read: false, write: false, command: false, test: false }
      }
    });
    assert.deepEqual(plan.executionTarget.requiredCapabilities, []);
  });
}

test('task execution that changes code still requires live read/write/command capabilities', () => {
  const { resolver } = setup({ runtimeCandidates: [candidate('mock')] });
  assert.throws(
    () => resolve(resolver, {
      phase: 'task_execution',
      taskRequiresCodeChanges: true,
      workspace: {
        workspaceId: 'detached-workspace',
        providerKind: 'server_local',
        capabilities: { read: false, write: false, command: false, test: false }
      }
    }),
    (error: unknown) => error instanceof InvocationResolutionError && error.code === 'NO_ELIGIBLE_RUNTIME'
  );
});
