import type {
  WorkflowMemberMappingGap,
  WorkflowMemberMappingNodeEvidence,
  WorkflowNode
} from '@agent-cluster/shared';

/**
 * Evaluates the published graph against the current session membership. The
 * optional node list is used only to attach deterministic evidence to the
 * confirmation card; it never infers semantic requirement/Agent fit.
 */
export type WorkflowMemberMappingResult =
  | { status: 'ready' }
  | { status: 'mapping_required'; gaps: WorkflowMemberMappingGap[]; addable: string[] };

export function evaluateWorkflowMemberMapping(input: {
  involvedAgentIds: string[];
  participatingAgentIds: string[];
  findAgent: (id: string) => { id: string; key: string; name: string; status: 'active' | 'disabled' } | undefined;
  workflowNodes?: WorkflowNode[];
}): WorkflowMemberMappingResult {
  const gaps: WorkflowMemberMappingGap[] = [];
  for (const agentId of input.involvedAgentIds) {
    const agent = input.findAgent(agentId);
    if (!agent) {
      gaps.push({ agentId, agentName: agentId, reason: 'unknown', ...gapEvidence(input.workflowNodes, agentId, false) });
      continue;
    }
    if (agent.status === 'disabled') {
      gaps.push({ agentId, agentName: agent.name, reason: 'disabled', ...gapEvidence(input.workflowNodes, agentId, false) });
      continue;
    }
    if (!input.participatingAgentIds.includes(agentId)) {
      gaps.push({ agentId, agentName: agent.name, reason: 'not_participating', ...gapEvidence(input.workflowNodes, agentId, true) });
    }
  }
  if (gaps.length === 0) return { status: 'ready' };
  return {
    status: 'mapping_required',
    gaps,
    addable: gaps.filter((gap) => gap.reason === 'not_participating').map((gap) => gap.agentId)
  };
}

function evidenceForAgent(
  nodes: WorkflowNode[] | undefined,
  agentId: string
): WorkflowMemberMappingNodeEvidence[] | undefined {
  if (!nodes) return undefined;
  const evidence = nodes.flatMap<WorkflowMemberMappingNodeEvidence>((node) => {
    if (node.type === 'agent' && node.agentId === agentId) {
      return [{
        nodeId: node.id,
        ...(node.name ? { nodeName: node.name } : {}),
        nodeType: 'agent' as const,
        ...(node.stageDescription ? { stageDescription: node.stageDescription } : {}),
        ...(node.inputContract ? { inputContract: [...node.inputContract] } : {}),
        ...(node.outputContract ? { outputContract: [...node.outputContract] } : {}),
        impact: `未加入则所选流程的「${node.name ?? node.id}」节点无法按发布图执行。`
      }];
    }
    if (node.type === 'robot_approval' && node.reviewerAgentId === agentId) {
      return [{
        nodeId: node.id,
        ...(node.name ? { nodeName: node.name } : {}),
        nodeType: 'robot_approval' as const,
        reviewPrompt: node.reviewPrompt,
        criteria: [...node.criteria],
        impact: `未加入则所选流程的「${node.name ?? node.id}」质量审核节点无法按发布图执行。`
      }];
    }
    return [];
  });
  return evidence;
}

function gapEvidence(
  nodes: WorkflowNode[] | undefined,
  agentId: string,
  canInvite: boolean
): Partial<Pick<WorkflowMemberMappingGap, 'canInvite' | 'nodes'>> {
  return nodes
    ? { canInvite, nodes: evidenceForAgent(nodes, agentId) ?? [] }
    : {};
}
