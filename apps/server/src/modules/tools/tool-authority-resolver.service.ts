import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AgentRunPhase,
  CompiledAgentIdentity,
  ResolvedToolCatalog,
  ToolAuthorityDecision,
  WorkspaceCapabilities,
  WorkspaceCapabilityKey,
  WorkspaceToolDescriptor
} from '@agent-cluster/shared';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import {
  getToolsForCapability,
  TOOL_WORKSPACE_CAPABILITY_MAPPING
} from './capability-tool-mapping.js';
import { toWorkspaceToolDescriptor } from './tool.interface.js';
import { ToolRegistryService } from './tool-registry.service.js';

const PHASE_ALLOWED_CAPABILITIES: Readonly<Record<AgentRunPhase, readonly WorkspaceCapabilityKey[]>> = {
  discussion: ['read'],
  brief_generation: ['read'],
  brief_revision: ['read'],
  brief_consultation: ['read'],
  task_acceptance: ['read'],
  task_execution: ['read', 'write', 'command', 'test'],
  revision_synthesis: ['read'],
  post_review: ['read', 'command', 'test'],
  final_delivery: ['read'],
  user_message_routing: []
};

export function isToolBlockedByPhase(phase: AgentRunPhase, toolName: string) {
  const requirements = TOOL_WORKSPACE_CAPABILITY_MAPPING[
    toolName as keyof typeof TOOL_WORKSPACE_CAPABILITY_MAPPING
  ] as readonly WorkspaceCapabilityKey[] | undefined;
  if (!requirements) return false;
  const allowed = new Set(PHASE_ALLOWED_CAPABILITIES[phase]);
  return requirements.some((requirement) => !allowed.has(requirement));
}

export type ResolveToolAuthorityInput = {
  identity: CompiledAgentIdentity;
  phase: AgentRunPhase;
  workspaceCapabilities: WorkspaceCapabilities;
  runtimeSupportedToolNames: readonly string[];
  allowedToolNames?: readonly string[];
  sessionId: string;
  taskId?: string;
};

@Injectable()
export class ToolAuthorityResolverService {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly registry: ToolRegistryService
  ) {}

  resolve(input: ResolveToolAuthorityInput): ResolvedToolCatalog {
    const runtimeTools = new Set(input.runtimeSupportedToolNames);
    const invocationAllowedTools = input.allowedToolNames
      ? new Set(input.allowedToolNames)
      : undefined;
    const grants = new Set(input.identity.capabilityIds);
    const requestedKeys = new Map(
      input.identity.requestedToolIds.map((id, index) => [id, input.identity.requestedToolKeys[index] ?? id])
    );
    const requestedIds = [...new Set(input.identity.requestedToolIds)].sort((left, right) =>
      (requestedKeys.get(left) ?? left).localeCompare(requestedKeys.get(right) ?? right) || left.localeCompare(right)
    );
    const descriptors = new Map<string, WorkspaceToolDescriptor>();
    const decisions: ToolAuthorityDecision[] = [];

    for (const toolId of requestedIds) {
      const definition = this.capabilities.findDefinitionById(toolId);
      const toolKey = definition?.key ?? requestedKeys.get(toolId) ?? toolId;
      const reasons: string[] = [];

      if (!grants.has(toolId)) {
        decisions.push({ toolId, toolKey, status: 'blocked', reasons: ['AGENT_CAPABILITY_MISSING'] });
        continue;
      }
      if (!definition || definition.kind === 'internal' || definition.status !== 'active') {
        decisions.push({ toolId, toolKey, status: 'blocked', reasons: ['TOOL_DEFINITION_UNAVAILABLE'] });
        continue;
      }

      const mappedNames = getToolsForCapability(toolId).sort();
      const executableNames = invocationAllowedTools
        ? mappedNames.filter((name) => invocationAllowedTools.has(name))
        : mappedNames;
      if (mappedNames.length > 0 && executableNames.length === 0) {
        decisions.push({ toolId, toolKey, status: 'blocked', reasons: ['INVOCATION_POLICY_BLOCKED'] });
        continue;
      }
      if (executableNames.length === 0) {
        decisions.push({ toolId, toolKey, status: 'blocked', reasons: ['TOOL_MAPPING_UNAVAILABLE'] });
        continue;
      }

      const executableTools = executableNames.map((name) => ({ name, tool: this.registry.getTool(name) }));
      const phaseBlocked = executableNames.some((name) => isToolBlockedByPhase(input.phase, name));
      if (phaseBlocked) {
        decisions.push({ toolId, toolKey, status: 'blocked', reasons: ['PHASE_BLOCKED'] });
        continue;
      }

      for (const name of executableNames) {
        const requirements = TOOL_WORKSPACE_CAPABILITY_MAPPING[
          name as keyof typeof TOOL_WORKSPACE_CAPABILITY_MAPPING
        ] as readonly WorkspaceCapabilityKey[] | undefined;
        if (!requirements) {
          reasons.push(`WORKSPACE_REQUIREMENTS_UNAVAILABLE:${name}`);
          continue;
        }
        for (const requirement of requirements) {
          if (!input.workspaceCapabilities[requirement]) {
            reasons.push(`WORKSPACE_CAPABILITY_MISSING:${requirement}`);
          }
        }
        if (!runtimeTools.has(name)) {
          reasons.push(`RUNTIME_TOOL_UNSUPPORTED:${name}`);
        }
      }
      for (const { name, tool } of executableTools) {
        if (!tool) reasons.push(`TOOL_EXECUTOR_UNAVAILABLE:${name}`);
      }

      const approval = this.capabilities.checkInvocation(toolId, {
        sessionId: input.sessionId,
        agentId: input.identity.agentId,
        reason: `Invocation ${input.taskId ?? 'session'} requests ${toolKey}`
      });
      if (!approval.allowed) reasons.push('HUMAN_APPROVAL_REQUIRED');

      const blockedReasons = [...new Set(reasons)].sort();
      if (blockedReasons.length > 0) {
        decisions.push({
          toolId,
          toolKey,
          status: 'blocked',
          reasons: blockedReasons,
          ...(approval.approvalKey ? { approvalId: approval.approvalKey } : {})
        });
        continue;
      }

      for (const { tool } of executableTools) {
        if (tool) descriptors.set(tool.name, toWorkspaceToolDescriptor(tool));
      }
      decisions.push({
        toolId,
        toolKey,
        status: 'allowed',
        reasons: [
          'PROFILE_REQUESTED',
          'AGENT_CAPABILITY_GRANTED',
          'PHASE_ALLOWED',
          'WORKSPACE_ALLOWED',
          'RUNTIME_SUPPORTED',
          'APPROVAL_SATISFIED'
        ],
        ...(approval.approvalKey ? { approvalId: approval.approvalKey } : {})
      });
    }

    const tools = [...descriptors.values()].sort((left, right) => left.name.localeCompare(right.name));
    const catalogHash = createHash('sha256').update(stableJson({ tools, decisions })).digest('hex');
    return { tools, decisions, catalogHash };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
