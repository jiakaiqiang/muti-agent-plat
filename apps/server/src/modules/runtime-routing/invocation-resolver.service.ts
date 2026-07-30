import { Injectable } from '@nestjs/common';
import type {
  AgentDefinition,
  AgentRunPhase,
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  ExpectedRuntimeOutput,
  InvocationPlan,
  PendingApprovalInfo,
  ResolvedExecutionTarget,
  ResolvedToolCatalog,
  RuntimeBudget,
  RuntimePreference,
  RuntimeType,
  RuntimeWriteMode,
  WorkspaceCapabilityKey,
  WorkspaceCapabilities,
  WorkspaceProviderKind
} from '@agent-cluster/shared';
import { AgentProfileCompilerService } from '../agent-profile/agent-profile-compiler.service.js';
import { RuntimeRegistryService } from '../runtimes/runtime-registry.service.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';
import {
  isToolBlockedByPhase,
  ToolAuthorityResolverService
} from '../tools/tool-authority-resolver.service.js';
import {
  getToolsForCapabilities,
  getToolsForCapability,
  getWorkspaceRequirementsForTools
} from '../tools/capability-tool-mapping.js';

export class InvocationResolutionError extends Error {
  constructor(
    public code: 'CAPABILITY_BLOCKED' | 'NO_ELIGIBLE_RUNTIME',
    message: string
  ) {
    super(message);
    this.name = 'InvocationResolutionError';
  }
}

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
  taskRequiresCodeChanges: boolean;
  agent: AgentDefinition;
  workspace: {
    workspaceId: string;
    providerKind: WorkspaceProviderKind;
    capabilities: WorkspaceCapabilities;
  };
  sessionPreference?: RuntimePreference;
  taskOverride?: { runtimeType: RuntimeType; modelId?: string };
  projectPolicyRuntime?: RuntimeType;
  smartRouterPick?: RuntimeType;
  globalDefaultRuntime: RuntimeType;
  excludedRuntimeTypes?: RuntimeType[];
  contextEnvelopeFactory: (input: {
    identity: CompiledAgentIdentity;
    toolCatalog: ResolvedToolCatalog;
    executionTarget: ResolvedExecutionTarget;
  }) => ContextEnvelopeV2;
  expectedOutput: ExpectedRuntimeOutput;
  budget: RuntimeBudget;
  writeModeOverride?: RuntimeWriteMode;
};

const PROPOSAL_ONLY_TOOL_NAMES = ['read_file', 'search_code'] as const;

@Injectable()
export class InvocationResolverService {
  constructor(
    private readonly profileCompiler: AgentProfileCompilerService,
    private readonly toolAuthority: ToolAuthorityResolverService,
    private readonly runtimeRegistry: RuntimeRegistryService,
    private readonly localRuntime?: LocalRuntimeConnectionService
  ) {}

  resolve(input: ResolveInvocationInput): InvocationPlan {
    const identity = this.profileCompiler.compileIdentity({ agent: input.agent });
    const allowedToolNames = input.writeModeOverride === 'proposal_only'
      ? new Set<string>(PROPOSAL_ONLY_TOOL_NAMES)
      : undefined;
    const requiredToolIds = identity.requestedToolIds.filter((capabilityId) =>
      !getToolsForCapability(capabilityId).some((toolName) => isToolBlockedByPhase(input.phase, toolName))
    );
    const requiredToolNames = getToolsForCapabilities(requiredToolIds)
      .filter((toolName) => !allowedToolNames || allowedToolNames.has(toolName))
      .sort();
    const requiredCapabilities = this.requiredWorkspaceCapabilities(input, requiredToolNames);
    const selection = this.selectRuntime(input, requiredCapabilities, requiredToolNames);
    const executionTarget: ResolvedExecutionTarget = {
      runtimeType: selection.candidate.runtimeType,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      source: selection.source,
      reason: selection.reason,
      requiredCapabilities,
      requiredToolIds,
      writeMode: input.writeModeOverride ?? (input.taskRequiresCodeChanges ? 'propose_changes' : 'none'),
      workspaceProviderKind: input.workspace.providerKind,
      executionLocation: executionLocationFor(input.workspace.providerKind)
    };
    const toolCatalog = this.toolAuthority.resolve({
      identity,
      phase: input.phase,
      workspaceCapabilities: input.workspace.capabilities,
      runtimeSupportedToolNames: selection.candidate.supportedToolNames,
      ...(allowedToolNames ? { allowedToolNames: [...allowedToolNames] } : {}),
      sessionId: input.sessionId,
      taskId: input.taskId
    });

    const blocked = toolCatalog.decisions.filter(
      (decision) =>
        decision.status === 'blocked' &&
        decision.reasons.some((reason) => !['PHASE_BLOCKED', 'INVOCATION_POLICY_BLOCKED'].includes(reason))
    );

    const approvalBlocked = blocked.filter((decision) =>
      decision.reasons.includes('HUMAN_APPROVAL_REQUIRED')
    );
    const hardBlocked = blocked.filter((decision) =>
      !decision.reasons.includes('HUMAN_APPROVAL_REQUIRED')
    );

    if (hardBlocked.length > 0) {
      throw new InvocationResolutionError(
        'CAPABILITY_BLOCKED',
        `Tool Authority blocked: ${hardBlocked
          .map((decision) => `${decision.toolKey} (${decision.reasons.join(', ')})`)
          .join(', ')}`
      );
    }

    const contextEnvelope = input.contextEnvelopeFactory({ identity, toolCatalog, executionTarget });

    const pendingApprovals: PendingApprovalInfo[] | undefined = approvalBlocked.length > 0
      ? approvalBlocked.map((d) => ({
          toolId: d.toolId,
          toolKey: d.toolKey,
          approvalId: d.approvalId!,
          reasons: d.reasons
        }))
      : undefined;

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
      budget: input.budget,
      ...(pendingApprovals ? { pendingApprovals } : {})
    };
  }

  private requiredWorkspaceCapabilities(input: ResolveInvocationInput, toolNames: readonly string[]) {
    const requirements = new Set<WorkspaceCapabilityKey>();
    if (
      input.phase === 'task_execution' &&
      input.taskRequiresCodeChanges &&
      input.writeModeOverride !== 'proposal_only'
    ) {
      ['read', 'write', 'command'].forEach((item) => requirements.add(item as WorkspaceCapabilityKey));
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
    return this.runtimeCandidates(input).filter((candidate) => {
      if (!candidate.available || excluded.has(candidate.runtimeType) || (allowed && !allowed.has(candidate.runtimeType))) return false;
      if (
        candidate.supportedWorkspaceProviderKinds?.length &&
        !candidate.supportedWorkspaceProviderKinds.includes(input.workspace.providerKind)
      ) {
        return false;
      }
      const candidateCapabilities = new Set(candidate.supportedWorkspaceCapabilities);
      const candidateTools = new Set(candidate.supportedToolNames);
      return (
        requiredCapabilities.every(
          (cap) => input.workspace.capabilities[cap] && candidateCapabilities.has(cap)
        ) &&
        requiredToolNames.every((tool) => candidateTools.has(tool))
      );
    });
  }

  private selectRuntime(
    input: ResolveInvocationInput,
    requiredCapabilities: readonly WorkspaceCapabilityKey[],
    requiredToolNames: readonly string[]
  ) {
    if (input.taskOverride) {
      const candidate = this.runtimeCandidates(input).find((c) => c.runtimeType === input.taskOverride!.runtimeType);
      if (candidate && this.isCandidateEligible(candidate, input, requiredCapabilities, requiredToolNames)) {
        return {
          candidate,
          modelId: input.taskOverride.modelId,
          source: 'task_override' as const,
          reason: `Task override selected ${candidate.runtimeType}`
        };
      }
    }

    const candidates = this.eligibleCandidates(input, requiredCapabilities, requiredToolNames);

    if (candidates.length === 0) {
      throw new InvocationResolutionError(
        'NO_ELIGIBLE_RUNTIME',
        [
          `No eligible runtime for phase=${input.phase}`,
          `providerKind=${input.workspace.providerKind}`,
          `requiredCapabilities=${requiredCapabilities.join(',') || 'none'}`,
          `requiredTools=${requiredToolNames.join(',') || 'none'}`,
          `allowedRuntimeTypes=${input.sessionPreference?.allowedRuntimeTypes?.join(',') || 'any'}`
        ].join(', ')
      );
    }

    const preferredType = input.sessionPreference?.preferredRuntimeType;
    if (preferredType) {
      const preferred = candidates.find((c) => c.runtimeType === preferredType);
      if (preferred) {
        return {
          candidate: preferred,
          modelId: input.sessionPreference?.preferredModelId,
          source: 'session_preference' as const,
          reason: `Session preference selected ${preferred.runtimeType}`
        };
      }
    }

    if (input.projectPolicyRuntime) {
      const policy = candidates.find((c) => c.runtimeType === input.projectPolicyRuntime);
      if (policy) {
        return {
          candidate: policy,
          modelId: undefined,
          source: 'project_policy' as const,
          reason: `Project policy selected ${policy.runtimeType}`
        };
      }
    }

    if (input.smartRouterPick) {
      const smart = candidates.find((c) => c.runtimeType === input.smartRouterPick);
      if (smart) {
        return {
          candidate: smart,
          modelId: undefined,
          source: 'smart_router' as const,
          reason: `Smart router selected ${smart.runtimeType}`
        };
      }
    }

    const globalDefault = candidates.find((c) => c.runtimeType === input.globalDefaultRuntime);
    const selected = globalDefault ?? candidates[0]!;

    return {
      candidate: selected,
      modelId: undefined,
      source: 'global_default' as const,
      reason: `Global default selected ${selected.runtimeType}`
    };
  }

  private isCandidateEligible(
    candidate: InvocationRuntimeCandidate,
    input: ResolveInvocationInput,
    requiredCapabilities: readonly WorkspaceCapabilityKey[],
    requiredToolNames: readonly string[]
  ): boolean {
    if (!candidate.available) return false;
    const allowed = input.sessionPreference?.allowedRuntimeTypes;
    if (allowed && !allowed.includes(candidate.runtimeType)) return false;
    if (input.excludedRuntimeTypes?.includes(candidate.runtimeType)) return false;
    if (
      candidate.supportedWorkspaceProviderKinds?.length &&
      !candidate.supportedWorkspaceProviderKinds.includes(input.workspace.providerKind)
    ) {
      return false;
    }
    const candidateCapabilities = new Set(candidate.supportedWorkspaceCapabilities);
    const candidateTools = new Set(candidate.supportedToolNames);
    return (
      requiredCapabilities.every(
        (cap) => input.workspace.capabilities[cap] && candidateCapabilities.has(cap)
      ) &&
      requiredToolNames.every((tool) => candidateTools.has(tool))
    );
  }

  private runtimeCandidates(input: ResolveInvocationInput): InvocationRuntimeCandidate[] {
    if (input.workspace.providerKind === 'local_bridge') {
      return this.localRuntime?.listRuntimeCandidates(input.workspace.workspaceId) ?? [];
    }
    return this.runtimeRegistry.listAll().map((adapter) => {
      const metadata = adapter.metadata;
      return {
        runtimeType: adapter.type,
        available: true,
        supportedWorkspaceCapabilities: metadata?.supportedWorkspaceCapabilities ?? [],
        supportedWorkspaceProviderKinds: metadata?.supportedWorkspaceProviderKinds,
        supportedToolNames: metadata?.supportedToolNames ?? []
      };
    });
  }
}

function executionLocationFor(providerKind: WorkspaceProviderKind) {
  return providerKind === 'server_local' ? ('server' as const) : ('local' as const);
}
