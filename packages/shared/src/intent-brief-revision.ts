import { isConfirmIntentBriefInput, type ConfirmIntentBriefInput } from './intent-brief-confirmation.js';
export type ReviseIntentBriefInput = Omit<ConfirmIntentBriefInput, 'contractVersion'> & {
  contractVersion: 'intent-brief-revise-v1';
  userMessage: string;
  questionAnswers: Array<{ question: string; answer: string }>;
  assignedAgentKeys?: string[];
};
export type IntentBriefRevisionBinding = { briefId: string; workItemId: string; request: ReviseIntentBriefInput; reviewerIds?: string[] };
export function isReviseIntentBriefInput(value: unknown): value is ReviseIntentBriefInput {
  const row = value as ReviseIntentBriefInput;
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.contractVersion !== 'intent-brief-revise-v1') return false;
  const { userMessage, questionAnswers, assignedAgentKeys, ...binding } = row;
  return isConfirmIntentBriefInput({ ...binding, contractVersion: 'intent-brief-confirm-v1' }) &&
    (assignedAgentKeys === undefined || (Array.isArray(assignedAgentKeys) && assignedAgentKeys.length <= 8 &&
      new Set(assignedAgentKeys).size === assignedAgentKeys.length && assignedAgentKeys.every(key => typeof key === 'string' && key.trim() === key && key.length > 0 && key.length <= 256))) &&
    typeof userMessage === 'string' && userMessage.trim().length > 0 && userMessage.length <= 8000 &&
    Array.isArray(questionAnswers) && questionAnswers.length <= 30 && questionAnswers.every(item => item &&
      typeof item === 'object' && !Array.isArray(item) && Object.keys(item).every(key => ['question', 'answer'].includes(key)) &&
      [item.question, item.answer].every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 2000)) &&
    briefRevisionMessage(row).length <= 8000;
}
export function briefRevisionMessage(input: ReviseIntentBriefInput): string {
  return input.userMessage + (input.questionAnswers.length ? '\n\n逐题回答：\n' + input.questionAnswers.map(row => `问题：${row.question}\n回答：${row.answer}`).join('\n\n') : '');
}
