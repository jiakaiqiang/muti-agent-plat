import type { GroupChatAgentRef, GroupChatAttachmentRef, GroupChatSkillRef } from '@agent-cluster/shared';

export type HistoricalSkillCandidate = GroupChatSkillRef & { status: 'active' | 'disabled' };
export type HistoricalAgentCandidate = GroupChatAgentRef & { status: 'active' | 'disabled' };

export type HistoricalTagState<TRef> = {
  ref: TRef;
  executable: boolean;
  reason?: 'unavailable' | 'deleted' | 'not_ready';
};

export type HistoricalMessageContext = {
  skill?: HistoricalTagState<GroupChatSkillRef> & { current?: HistoricalSkillCandidate };
  agents: Array<HistoricalTagState<GroupChatAgentRef> & { current?: HistoricalAgentCandidate }>;
  attachments: Array<HistoricalTagState<GroupChatAttachmentRef>>;
  /** History is a read-only scope; membership join time never narrows it. */
  historyReadable: true;
};

/**
 * Keep the historical tag immutable for display, while resolving execution
 * against the newest currently-enabled Skill with the same stable key/scope.
 */
export function resolveHistoricalSkill(
  ref: GroupChatSkillRef,
  current: readonly HistoricalSkillCandidate[]
): HistoricalMessageContext['skill'] {
  const active = current
    .filter((candidate) => candidate.key === ref.key && candidate.status === 'active')
    .filter((candidate) => !ref.scope || candidate.scope === ref.scope)
    .filter((candidate) => !ref.scopeId || candidate.scopeId === ref.scopeId)
    .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
  return active
    ? { ref: structuredClone(ref), current: structuredClone(active), executable: true }
    : { ref: structuredClone(ref), executable: false, reason: 'unavailable' };
}

/** Disabled/deleted Agents keep their historical @ tag but cannot execute. */
export function resolveHistoricalAgent(
  ref: GroupChatAgentRef,
  current: readonly HistoricalAgentCandidate[]
): HistoricalMessageContext['agents'][number] {
  const agent = current.find((candidate) => candidate.id === ref.id || (ref.key && candidate.key === ref.key));
  return agent?.status === 'active'
    ? { ref: structuredClone(ref), current: structuredClone(agent), executable: true }
    : { ref: structuredClone(ref), executable: false, reason: 'unavailable' };
}

/** Attachment metadata remains visible, but deleted/not-ready content is never executable context. */
export function resolveHistoricalAttachment(ref: GroupChatAttachmentRef): HistoricalMessageContext['attachments'][number] {
  return ref.uploadStatus === 'ready'
    ? { ref: structuredClone(ref), executable: true }
    : {
      ref: structuredClone(ref),
      executable: false,
      reason: ref.uploadStatus === 'deleted' ? 'deleted' : 'not_ready'
    };
}

export function buildHistoricalMessageContext(input: {
  skill?: GroupChatSkillRef;
  agents?: readonly GroupChatAgentRef[];
  attachments?: readonly GroupChatAttachmentRef[];
  currentSkills?: readonly HistoricalSkillCandidate[];
  currentAgents?: readonly HistoricalAgentCandidate[];
}): HistoricalMessageContext {
  return {
    ...(input.skill ? { skill: resolveHistoricalSkill(input.skill, input.currentSkills ?? []) } : {}),
    agents: (input.agents ?? []).map((ref) => resolveHistoricalAgent(ref, input.currentAgents ?? [])),
    attachments: (input.attachments ?? []).map(resolveHistoricalAttachment),
    historyReadable: true
  };
}
