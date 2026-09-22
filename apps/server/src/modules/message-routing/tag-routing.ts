import type {
  AgentDefinition,
  GroupChatAgentRef,
  GroupChatRoutingSnapshot,
  GroupChatSkillRef
} from '@agent-cluster/shared';

type RoutingAgent = Pick<AgentDefinition, 'id' | 'key' | 'name' | 'role' | 'description' | 'tags' | 'capabilityIds'>;

function tokens(value: string | undefined) {
  return new Set(
    (value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 1)
  );
}

function ref(agent: RoutingAgent): GroupChatAgentRef {
  return { id: agent.id, key: agent.key, name: agent.name };
}

function stableAgents(agents: readonly RoutingAgent[]) {
  return [...agents].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-Hans') || left.id.localeCompare(right.id)
  );
}

function semanticScore(skill: GroupChatSkillRef, agent: RoutingAgent) {
  const skillTerms = new Set([...tokens(skill.key), ...tokens(skill.name)]);
  const agentTerms = new Set([
    ...tokens(agent.key),
    ...tokens(agent.name),
    ...tokens(agent.role),
    ...tokens(agent.description),
    ...agent.tags.flatMap((item) => [...tokens(item)]),
    ...agent.capabilityIds.flatMap((item) => [...tokens(item)])
  ]);
  return [...skillTerms].filter((term) => agentTerms.has(term)).length;
}

/**
 * Resolves the explicit composer tags without an LLM. This is intentionally
 * deterministic: the semantic router may later classify the message, but it
 * cannot silently replace the user-selected targets.
 */
export function resolveTagRouting(input: {
  skill?: GroupChatSkillRef;
  candidates: readonly RoutingAgent[];
  mainAgent: RoutingAgent;
}): GroupChatRoutingSnapshot {
  const candidates = stableAgents(input.candidates);
  const candidateAgentIds = candidates.map((agent) => agent.id);

  if (!input.skill && candidates.length === 0) {
    return {
      mode: 'main',
      reason: 'no_explicit_routing',
      candidateAgentIds: [],
      distributionAgentIds: [],
      resolvedAgentId: input.mainAgent.id,
      resolvedAgent: ref(input.mainAgent)
    };
  }

  if (!input.skill && candidates.length > 0) {
    return {
      mode: 'distributed',
      reason: 'agent_candidates_without_skill',
      candidateAgentIds,
      distributionAgentIds: candidateAgentIds
    };
  }

  if (candidates.length === 0) {
    return {
      mode: 'main',
      reason: 'skill_without_agent_candidate',
      candidateAgentIds: [],
      distributionAgentIds: [],
      resolvedAgentId: input.mainAgent.id,
      resolvedAgent: ref(input.mainAgent),
      skill: input.skill
    };
  }

  const ranked = candidates
    .map((agent) => ({ agent, score: semanticScore(input.skill!, agent) }))
    .sort((left, right) => right.score - left.score || left.agent.name.localeCompare(right.agent.name, 'zh-Hans') || left.agent.id.localeCompare(right.agent.id));
  const best = ranked[0];
  if (!best || best.score === 0) {
    return {
      mode: 'main',
      reason: 'skill_agent_semantic_mismatch',
      candidateAgentIds,
      distributionAgentIds: [],
      resolvedAgentId: input.mainAgent.id,
      resolvedAgent: ref(input.mainAgent),
      skill: input.skill
    };
  }

  return {
    mode: 'single',
    reason: 'skill_agent_semantically_matched',
    candidateAgentIds,
    distributionAgentIds: [],
    resolvedAgentId: best.agent.id,
    resolvedAgent: ref(best.agent),
    skill: input.skill
  };
}
