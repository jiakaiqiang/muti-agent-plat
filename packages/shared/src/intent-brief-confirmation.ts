export type ConfirmIntentBriefInput = {
  contractVersion: 'intent-brief-confirm-v1';
  dataEpoch: string;
  confirmationId: string;
  expectedBriefVersion: number;
  expectedIntentRevision: number;
  idempotencyKey: string;
};
export type IntentBriefConfirmationReceipt = {
  id: string;
  actorId: string;
  request: ConfirmIntentBriefInput;
  sourceEventId: string;
  requirementRevision: number;
  resultStatus: 'WAIT_WORKFLOW_SELECT' | 'PAUSED';
  createdAt: string;
};

export function isConfirmIntentBriefInput(value: unknown): value is ConfirmIntentBriefInput {
  const input = value as ConfirmIntentBriefInput;
  return Boolean(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['contractVersion', 'dataEpoch', 'confirmationId', 'expectedBriefVersion', 'expectedIntentRevision', 'idempotencyKey'].includes(key)) &&
    input.contractVersion === 'intent-brief-confirm-v1' &&
    [input.expectedBriefVersion, input.expectedIntentRevision].every(value => Number.isSafeInteger(value) && value > 0) &&
    [input.dataEpoch, input.confirmationId, input.idempotencyKey].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256));
}
