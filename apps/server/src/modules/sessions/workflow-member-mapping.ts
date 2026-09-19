/**
 * Phase 4 T3: evaluates whether a workflow's involved agents can run in this
 * session without asking the user. A clean mapping means every agent is
 * participating and active; anything else is a gap the user must resolve
 * (invite a missing member, accept a disabled agent, or abandon the workflow).
 */
export type WorkflowMemberMappingResult =
  | { status: 'ready' }
  | { status: 'mapping_required'; gaps: Array<{ agentId: string; agentName: string; reason: 'not_participating' | 'disabled' | 'unknown' }>; addable: string[] };

export function evaluateWorkflowMemberMapping(input: {
  involvedAgentIds: string[];
  participatingAgentIds: string[];
  findAgent: (id: string) => { id: string; key: string; name: string; status: 'active' | 'disabled' } | undefined;
}): WorkflowMemberMappingResult {
  const gaps: Array<{ agentId: string; agentName: string; reason: 'not_participating' | 'disabled' | 'unknown' }> = [];
  for (const agentId of input.involvedAgentIds) {
    const agent = input.findAgent(agentId);
    if (!agent) {
      gaps.push({ agentId, agentName: agentId, reason: 'unknown' });
      continue;
    }
    if (agent.status === 'disabled') {
      gaps.push({ agentId, agentName: agent.name, reason: 'disabled' });
      continue;
    }
    if (!input.participatingAgentIds.includes(agentId)) {
      gaps.push({ agentId, agentName: agent.name, reason: 'not_participating' });
    }
  }
  if (gaps.length === 0) return { status: 'ready' };
  return {
    status: 'mapping_required',
    gaps,
    addable: gaps.filter((gap) => gap.reason === 'not_participating').map((gap) => gap.agentId)
  };
}
