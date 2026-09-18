import type { Delegation, DiscussionRun } from '@agent-cluster/shared';

export type DiscussionSynthesis = {
  /** Attributed, per-expert conclusions — never a merged claim of agreement. */
  summary: string;
  /** Distinct conclusions on the same question; the user chooses, the synthesis does not. */
  conflicts: string[];
  /** Open questions the experts raised, plus anything the coordinator asked the user. */
  unresolved: string[];
  risks: string[];
  failed: Array<{ delegationId: string; agentName: string; code: string; retryable: boolean }>;
  unanswered: Array<{ delegationId: string; agentName: string; status: Delegation['status'] }>;
  /** Exactly the delegations whose results were read. "Summarised" is checkable against this. */
  sourceDelegationIds: string[];
  outcome: 'ready' | 'needs_user';
};

/**
 * Deterministic synthesis of one discussion round from its persisted
 * delegations. It reads real results — current revision, not stale, completed —
 * and presents each conclusion under its expert's name. It does not merge
 * conclusions into a consensus, because the experts did not give one; where
 * conclusions differ, the user decides (AC5). Failures and unanswered asks are
 * listed, not hidden.
 */
export function synthesizeDiscussion(
  run: DiscussionRun,
  context: { agentNames: Record<string, string>; questionsForUser?: string[] }
): DiscussionSynthesis {
  const name = (agentId: string) => context.agentNames[agentId] ?? agentId;
  const current = run.delegations.filter((item) => item.requirementRevision === run.requirementRevision && !item.stale);

  const answered = current.filter((item) => item.status === 'completed' && item.result);
  const failed = current
    .filter((item) => item.status === 'failed')
    .map((item) => ({
      delegationId: item.id,
      agentName: name(item.targetAgentId),
      code: item.failure?.code ?? 'UNKNOWN',
      retryable: item.failure?.retryable ?? false
    }));
  const unanswered = current
    .filter((item) => item.status === 'pending' || item.status === 'running' || item.status === 'blocked')
    .map((item) => ({ delegationId: item.id, agentName: name(item.targetAgentId), status: item.status }));

  const unresolved = [
    ...answered.flatMap((item) => item.result!.openQuestions),
    ...(context.questionsForUser ?? [])
  ];
  const risks = answered.flatMap((item) => item.result!.risks);

  // A conflict is a disagreement on the same question: experts asked the same
  // objective who reached different conclusions. Experts asked different
  // questions naturally answer differently, and that is not a conflict.
  // Conflicts are surfaced for the user to decide, not resolved here.
  const byObjective = new Map<string, string[]>();
  for (const item of answered) {
    const key = item.objective.trim();
    const conclusions = byObjective.get(key) ?? [];
    const text = item.result!.conclusion.trim();
    if (!conclusions.includes(text)) conclusions.push(text);
    byObjective.set(key, conclusions);
  }
  const conflicts = [...byObjective.values()].filter((conclusions) => conclusions.length > 1).flat();

  const lines: string[] = [];
  if (answered.length === 0) {
    lines.push('本轮没有可用的专家结论。');
  }
  for (const item of answered) {
    const report = item.result!;
    lines.push(`【${name(item.targetAgentId)}】${report.conclusion}`);
    if (report.evidenceRefs.length) lines.push(`  依据：${report.evidenceRefs.join('、')}`);
    if (report.risks.length) lines.push(`  风险：${report.risks.join('；')}`);
    if (report.suggestedActions.length) lines.push(`  建议：${report.suggestedActions.join('；')}`);
  }
  for (const item of failed) {
    lines.push(`【${item.agentName}】未能给出结论：${item.code}${item.retryable ? '（可重试）' : ''}`);
  }
  for (const item of unanswered) {
    lines.push(`【${item.agentName}】尚未回复（${item.status}）`);
  }
  if (conflicts.length) lines.push(`专家结论不一致，需要你决定：${conflicts.map((text, index) => `(${index + 1}) ${text}`).join(' ')}`);
  if (unresolved.length) lines.push(`待你回答：${unresolved.map((text, index) => `(${index + 1}) ${text}`).join(' ')}`);

  const outcome: DiscussionSynthesis['outcome'] =
    answered.length > 0 && failed.length === 0 && unanswered.length === 0 && conflicts.length === 0 && unresolved.length === 0
      ? 'ready'
      : 'needs_user';

  return {
    summary: lines.join('\n'),
    conflicts,
    unresolved,
    risks,
    failed,
    unanswered,
    sourceDelegationIds: answered.map((item) => item.id),
    outcome
  };
}
