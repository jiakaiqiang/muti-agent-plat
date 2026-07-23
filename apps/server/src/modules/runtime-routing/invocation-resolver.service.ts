import { Injectable } from '@nestjs/common';
import type {
  AgentDefinition,
  AgentRunPhase,
  ExpectedRuntimeOutput,
  InvocationPlan,
  ResolvedExecutionTarget,
  RuntimeBudget,
  RuntimePreference,
  RuntimeType,
  CompiledAgentIdentity,
  ResolvedToolCatalog,
  WorkspaceCapabilities,
  WorkspaceCapabilityKey,
  WorkspaceProviderKind
} from '@agent-cluster/shared';
import { AgentProfileCompilerService } from '../agent-profile/agent-profile-compiler.service.js';
import {
  getToolsForCapability,
  getToolsForCapabilities,
  getWorkspaceRequirementsForTools
} from '../tools/capability-tool-mapping.js';
import {
  isToolBlockedByPhase,
  ToolAuthorityResolverService
} from '../tools/tool-authority-resolver.service.js';
import { RuntimeRegistryService } from '../runtimes/runtime-registry.service.js';

export type InvocationRuntimeCandidate = {
  runtimeType: RuntimeType;
  available: boolean;
  supportedWorkspaceCapabilities: readonly WorkspaceCapabilityKey[];
  supportedWorkspaceProviderKinds?: readonly WorkspaceProviderKind[];
  supportedToolNames: readonly string[];
};

export type ResolveInvocationInput = {
  invocationId: string;
  sessionId: string;
  taskId?: string;
  taskKind: string;
  phase: AgentRunPhase;
  agent: AgentDefinition;
  taskRequiresCodeChanges: boolean;
  workspace: {
    workspaceId: string;
    providerKind: WorkspaceProviderKind;
    capabilities: WorkspaceCapabilities;
  };
  taskOverride?: { runtimeType: RuntimeType; modelId?: string };
  sessionPreference?: RuntimePreference;
  projectPolicyRuntime?: RuntimeType;
  smartRouterPick?: RuntimeType;
  globalDefaultRuntime?: RuntimeType;
  excludedRuntimeTypes?: RuntimeType[];
  contextEnvelopeFactory: (input: {
    identity: CompiledAgentIdentity;
    toolCatalog: ResolvedToolCatalog;
    executionTarget: ResolvedExecutionTarget;
  }) => import('@agent-cluster/shared').ContextEnvelopeV2;
  expectedOutput: ExpectedRuntimeOutput;
  budget: RuntimeBudget;
};

export class InvocationResolutionError extends Error {
  constructor(
    readonly code: 'NO_ELIGIBLE_RUNTIME' | 'CAPABILITY_BLOCKED',
    message: string
  ) {
    super(message);
    this.name = 'InvocationResolutionError';
  }
}

@Injectable()
export class InvocationResolverService {
  constructor(
    private readonly profileCompiler: AgentProfileCompilerService,
    private readonly toolAuthority: ToolAuthorityResolverService,
    private readonly runtimeRegistry: RuntimeRegistryService
  ) {}

  resolve(input: ResolveInvocationInput): InvocationPlan {
    const identity = this.profileCompiler.compileIdentity({ agent: input.agent });
    const requiredToolIds = identity.requestedToolIds.filter((capabilityId) =>
      !getToolsForCapability(capabilityId).some((toolName) => isToolBlockedByPhase(input.phase, toolName))
    );
    const requiredToolNames = getToolsForCapabilities(requiredToolIds).sort();
    const requiredCapabilities = this.requiredWorkspaceCapabilities(input, requiredToolNames);
    const eligible = this.eligibleCandidates(input, requiredCapabilities, requiredToolNames);
    const selection = this.selectRuntime(input, eligible);

    if (!selection) {
      throw new InvocationResolutionError(
        'NO_ELIGIBLE_RUNTIME',
        `No eligible Runtime for ${input.phase}/${input.taskKind}; required tools: ${requiredToolNames.join(',') || 'none'}`
      );
    }

    const executionTarget: ResolvedExecutionTarget = {
      runtimeType: selection.candidate.runtimeType,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      source: selection.source,
      reason: selection.reason,
      requiredCapabilities,
      requiredToolIds,
      writeMode: input.taskRequiresCodeChanges ? 'propose_changes' : 'none',
      workspaceProviderKind: input.workspace.providerKind
    };
    const workspaceCapabilities = this.effectiveWorkspaceCapabilities(input, selection.candidate);
    const toolCatalog = this.toolAuthority.resolve({
      identity,
      phase: input.phase,
      workspaceCapabilities,
      runtimeSupportedToolNames: selection.candidate.supportedToolNames,
      sessionId: input.sessionId,
      taskId: input.taskId
    });
    const blocked = toolCatalog.decisions.filter(
      (decision) =>
        decision.status === 'blocked' &&
        decision.reasons.some((reason) => reason !== 'PHASE_BLOCKED')
    );
    if (blocked.length > 0) {
      throw new InvocationResolutionError(
        'CAPABILITY_BLOCKED',
        `Tool Authority blocked: ${blocked
          .map((decision) => `${decision.toolKey} (${decision.reasons.join(', ')})`)
          .join(', ')}`
      );
    }
    const contextEnvelope = input.contextEnvelopeFactory({ identity, toolCatalog, executionTarget });

    return {
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      phase: input.phase,
      agent: identity,
      executionTarget,
      toolCatalog,
      contextEnvelope,
      expectedOutput: input.expectedOutput,
      budget: input.budget
    };
  }

  private requiredWorkspaceCapabilities(input: ResolveInvocationInput, toolNames: readonly string[]) {
    const requirements = new Set<WorkspaceCapabilityKey>();
    if (input.phase === 'task_execution' && input.taskRequiresCodeChanges) {
      ['read', 'write'].forEach((item) => requirements.add(item as WorkspaceCapabilityKey));
      if (input.workspace.providerKind !== 'browser_broker') {
        requirements.add('command');
      }
    }
    getWorkspaceRequirementsForTools(toolNames).forEach((item) => requirements.add(item));
    return (['read', 'write', 'command', 'test'] as const).filter((item) => requirements.has(item));
  }

  private eligibleCandidates(
    input: ResolveInvocationInput,
    requiredCapabilities: readonly WorkspaceCapabilityKey[],
    requiredToolNames: readonly string[]
  ) {
    const allowed = input.sessionPreference?.allowedRuntimeTypes
      ? new Set(input.sessionPreference.allowedRuntimeTypes)
      : undefined;
    const excluded = new Set(input.excludedRuntimeTypes ?? []);
    return this.runtimeCandidates().filter((candidate) => {
      if (!candidate.available || excluded.has(candidate.runtimeType) || (allowed && !allowed.has(candidate.runtimeType))) return false;
      if (
        candidate.supportedWorkspaceProviderKinds?.length &&
        !candidate.supportedWorkspaceProviderKinds.includes(input.workspace.providerKind)
      ) {
        return false;
      }
      const candidateCapabilities = new Set(candidate.supportedWorkspaceCapabilities);
      const candidateTools = new Set(candidate.supportedToolNames);
      const workspaceCapabilities = this.effectiveWorkspaceCapabilities(input, candidate);
      return (
        requiredCapabilities.every(
          (requirement) => workspaceCapabilities[requirement] && candidateCapabilities.has(requirement)
        ) && requiredToolNames.every((toolName) => candidateTools.has(toolName))
      );
    });
  }

  private effectiveWorkspaceCapabilities(
    input: ResolveInvocationInput,
    candidate: InvocationRuntimeCandidate
  ): WorkspaceCapabilities {
    const supportsBrowserMirror =
      input.workspace.providerKind === 'browser_broker' &&
      candidate.supportedWorkspaceProviderKinds?.includes('browser_broker') === true;
    if (!supportsBrowserMirror) return input.workspace.capabilities;
    const runtimeCapabilities = new Set(candidate.supportedWorkspaceCapabilities);
    return {
      ...input.workspace.capabilities,
      command: input.workspace.capabilities.command || runtimeCapabilities.has('command'),
      test: input.workspace.capabilities.test || runtimeCapabilities.has('test')
    };
  }

  private runtimeCandidates(): InvocationRuntimeCandidate[] {
    return this.runtimeRegistry.listAll().map((adapter) => ({
      runtimeType: adapter.type,
      available: true,
      supportedWorkspaceCapabilities: adapter.metadata?.supportedWorkspaceCapabilities ?? [],
      supportedWorkspaceProviderKinds: adapter.metadata?.supportedWorkspaceProviderKinds,
      supportedToolNames: adapter.metadata?.supportedToolNames ?? []
    }));
  }

  private selectRuntime(input: ResolveInvocationInput, eligible: readonly InvocationRuntimeCandidate[]) {
    const byType = new Map(eligible.map((candidate) => [candidate.runtimeType, candidate]));
    const selections = [
      input.taskOverride
        ? {
            runtimeType: input.taskOverride.runtimeType,
            modelId: input.taskOverride.modelId,
            source: 'task_override' as const,
            reason: 'Eligible task override selected.'
          }
        : undefined,
      input.sessionPreference?.preferredRuntimeType
        ? {
            runtimeType: input.sessionPreference.preferredRuntimeType,
            modelId: input.sessionPreference.preferredModelId,
            source: 'session_preference' as const,
            reason: 'Eligible session preference selected.'
          }
        : undefined,
      input.projectPolicyRuntime
        ? {
            runtimeType: input.projectPolicyRuntime,
            source: 'project_policy' as const,
            reason: 'Eligible project policy selected.'
          }
        : undefined,
      input.smartRouterPick
        ? {
            runtimeType: input.smartRouterPick,
            source: 'smart_router' as const,
            reason: 'Eligible smart-router candidate selected.'
          }
        : undefined,
      input.globalDefaultRuntime
        ? {
            runtimeType: input.globalDefaultRuntime,
            source: 'global_default' as const,
            reason: 'Eligible global default selected.'
          }
        : undefined,
      eligible[0]
        ? {
            runtimeType: eligible[0].runtimeType,
            source: 'smart_router' as const,
            reason: 'First deterministic eligible Runtime selected.'
          }
        : undefined
    ];
    for (const selection of selections) {
      if (!selection) continue;
      const candidate = byType.get(selection.runtimeType);
      if (candidate) return { ...selection, candidate };
    }
    return undefined;
  }
}
