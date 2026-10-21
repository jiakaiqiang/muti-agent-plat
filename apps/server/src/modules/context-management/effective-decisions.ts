import { createHash } from 'node:crypto';
import { briefQuestionKey, type DecisionRecord, type WorkItem } from '@agent-cluster/shared';

/** One projection shared by context construction and execution version checks. */
export function effectiveDecisions(decisions: DecisionRecord[], work: WorkItem): DecisionRecord[] {
  const inheritedIds = new Set(work.inheritedDecisionIds);
  const valid = decisions.filter(decision => decision.status === 'confirmed' &&
    (decision.workItemId === work.id || inheritedIds.has(decision.id)));
  const overriddenIds = new Set(valid.filter(decision => decision.workItemId === work.id)
    .map(decision => decision.overridesDecisionId).filter((id): id is string => Boolean(id)));
  const effectiveAnswers = new Map<string, DecisionRecord>();
  for (const decision of valid) {
    if (!decision.question || !decision.answer || overriddenIds.has(decision.id)) continue;
    const key = briefQuestionKey(decision.question);
    const previous = effectiveAnswers.get(key);
    if (!previous || decision.workItemId === work.id || previous.workItemId !== work.id) effectiveAnswers.set(key, decision);
  }
  return valid.filter(decision => !overriddenIds.has(decision.id) &&
    (!decision.question || effectiveAnswers.get(briefQuestionKey(decision.question))?.id === decision.id));
}

export function decisionSetHash(decisions: Array<Pick<DecisionRecord, 'id' | 'revision'>>) {
  return createHash('sha256').update(JSON.stringify(decisions.map(item => [item.id, item.revision]).sort())).digest('hex');
}

/** A correction retains the semantic kind of its replaced/overridden constraint. */
export function effectiveConstraintContents(decisions: DecisionRecord[], work: WorkItem): string[] {
  const byId = new Map(decisions.map(row => [row.id, row]));
  return effectiveDecisions(decisions, work).filter(row => {
    let current: DecisionRecord | undefined = row;
    const seen = new Set<string>();
    while (current?.kind === 'correction' && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.supersedesDecisionId ?? current.overridesDecisionId ?? '');
    }
    return current?.kind === 'constraint';
  }).map(row => row.content);
}
