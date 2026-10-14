import type { DecisionRecord } from '@agent-cluster/shared'
import { briefQuestionKey } from '@agent-cluster/shared'

export function effectiveBriefQuestionAnswers(
  decisions: DecisionRecord[],
  workItemId: string,
  inheritedDecisionIds: string[] = []
) {
  const inherited = new Set(inheritedDecisionIds)
  const effective = new Map<string, DecisionRecord>()
  for (const decision of decisions) {
    if (decision.status !== 'confirmed' || !decision.question || !decision.answer) continue
    if (decision.workItemId !== workItemId && !inherited.has(decision.id)) continue
    const key = briefQuestionKey(decision.question)
    const previous = effective.get(key)
    if (!previous || decision.workItemId === workItemId || previous.workItemId !== workItemId) {
      effective.set(key, decision)
    }
  }
  return [...effective.values()]
}
