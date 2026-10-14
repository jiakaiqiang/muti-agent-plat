import type { DecisionRecord } from '@agent-cluster/shared';
import { briefQuestionKey } from '@agent-cluster/shared';

export function confirmedQuestionAnswers(decisions: DecisionRecord[]) {
  const answers = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.status !== 'confirmed' || !decision.question || !decision.answer) continue;
    answers.set(briefQuestionKey(decision.question), decision);
  }
  return answers;
}

export function unresolvedBriefQuestions(questions: string[], decisions: DecisionRecord[]) {
  const answered = confirmedQuestionAnswers(decisions);
  return questions.filter((question) => !answered.has(briefQuestionKey(question)));
}
