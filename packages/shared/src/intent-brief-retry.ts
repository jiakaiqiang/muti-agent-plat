export type RetryIntentBriefInput = {
  contractVersion: 'intent-brief-retry-v1';
  dataEpoch: string;
  expectedRoutingRevision: number;
  expectedIntentRevision: number;
  expectedOperationId: string;
  idempotencyKey: string;
};

export function isRetryIntentBriefInput(value: unknown): value is RetryIntentBriefInput {
  const row = value as RetryIntentBriefInput;
  return Boolean(row && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).every(key => ['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'expectedIntentRevision', 'expectedOperationId', 'idempotencyKey'].includes(key)) &&
    row.contractVersion === 'intent-brief-retry-v1' &&
    [row.expectedRoutingRevision, row.expectedIntentRevision].every(version => Number.isSafeInteger(version) && version > 0) &&
    [row.dataEpoch, row.expectedOperationId, row.idempotencyKey].every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256));
}
