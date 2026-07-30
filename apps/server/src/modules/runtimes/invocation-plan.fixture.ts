import type {
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  InvocationPlan,
  ResolvedExecutionTarget,
  ResolvedToolCatalog
} from '@agent-cluster/shared';

type PlanOverrides = Omit<Partial<InvocationPlan>, 'agent' | 'executionTarget' | 'toolCatalog' | 'contextEnvelope'> & {
  agent?: Partial<CompiledAgentIdentity>;
  executionTarget?: Partial<ResolvedExecutionTarget>;
  toolCatalog?: Partial<ResolvedToolCatalog>;
  contextEnvelope?: Omit<Partial<ContextEnvelopeV2>, 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6'> & {
    L0?: Omit<Partial<ContextEnvelopeV2['L0']>, 'workspace'> & {
      workspace?: Partial<ContextEnvelopeV2['L0']['workspace']>;
    };
    L1?: Omit<Partial<ContextEnvelopeV2['L1']>, 'navigation'> & {
      navigation?: Partial<ContextEnvelopeV2['L1']['navigation']>;
    };
    L2?: Partial<ContextEnvelopeV2['L2']>;
    L3?: Partial<ContextEnvelopeV2['L3']>;
    L4?: Partial<ContextEnvelopeV2['L4']>;
    L5?: Partial<ContextEnvelopeV2['L5']>;
    L6?: Partial<ContextEnvelopeV2['L6']>;
  };
};

export function makeInvocationPlan(overrides: PlanOverrides = {}): InvocationPlan {
  const invocationId = overrides.invocationId ?? '00000000-0000-4000-8000-000000000901';
  const sessionId = overrides.sessionId ?? '00000000-0000-4000-8000-000000000902';
  const runtimeType = overrides.executionTarget?.runtimeType ?? 'mock';
  const revision = { id: 'revision-test', observedAt: '2026-07-12T00:00:00.000Z' };
  const agent: CompiledAgentIdentity = {
    agentId: '00000000-0000-4000-8000-000000000903',
    key: 'test-agent',
    name: 'Test Agent',
    role: 'test',
    systemPrompt: 'Follow the invocation plan.',
    profileHash: 'profile-test',
    profileRevision: 1,
    skillBindings: [],
    requestedToolIds: [],
    requestedToolKeys: [],
    capabilityIds: [],
    knowledgeBaseIds: [],
    ...overrides.agent
  };
  const executionTarget: ResolvedExecutionTarget = {
    runtimeType,
    source: 'smart_router',
    reason: 'Test fixture.',
    requiredCapabilities: [],
    requiredToolIds: [],
    writeMode: 'none',
    workspaceProviderKind: 'server_local',
    executionLocation: 'server',
    ...overrides.executionTarget
  };
  const toolCatalog: ResolvedToolCatalog = {
    tools: [],
    decisions: [],
    catalogHash: 'catalog-test',
    ...overrides.toolCatalog
  };
  const baseEnvelope: ContextEnvelopeV2 = {
    version: 'v2',
    createdAt: '2026-07-12T00:00:00.000Z',
    workspaceId: 'workspace-test',
    sessionId,
    L0: {
      systemRules: [],
      agentId: agent.agentId,
      profileHash: agent.profileHash,
      profileRevision: agent.profileRevision,
      toolCatalogHash: toolCatalog.catalogHash,
      workspace: {
        workspaceId: 'workspace-test',
        rootName: 'workspace',
        providerKind: executionTarget.workspaceProviderKind,
        revision
      }
    },
    L1: {
      sessionGoal: 'Test invocation',
      phase: overrides.phase ?? 'task_execution',
      navigation: { entries: [], truncated: false }
    },
    L2: { source: 'generated', modules: [] },
    L3: { files: [], totalByteLength: 0, truncated: false },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 8_000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3_600 }
  };
  const envelopeOverrides = overrides.contextEnvelope ?? {};
  const contextEnvelope: ContextEnvelopeV2 = {
    ...baseEnvelope,
    ...envelopeOverrides,
    L0: {
      ...baseEnvelope.L0,
      ...envelopeOverrides.L0,
      workspace: {
        ...baseEnvelope.L0.workspace,
        ...envelopeOverrides.L0?.workspace
      }
    },
    L1: {
      ...baseEnvelope.L1,
      ...envelopeOverrides.L1,
      navigation: {
        ...baseEnvelope.L1.navigation,
        ...envelopeOverrides.L1?.navigation
      }
    },
    L2: { ...baseEnvelope.L2, ...envelopeOverrides.L2 },
    L3: { ...baseEnvelope.L3, ...envelopeOverrides.L3 },
    L4: { ...baseEnvelope.L4, ...envelopeOverrides.L4 },
    L5: { ...baseEnvelope.L5, ...envelopeOverrides.L5 },
    L6: { ...baseEnvelope.L6, ...envelopeOverrides.L6 }
  };

  return {
    invocationId,
    sessionId,
    phase: 'task_execution',
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    budget: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxTotalTokens: 10_000 },
    ...overrides,
    agent,
    executionTarget,
    toolCatalog,
    contextEnvelope
  };
}
