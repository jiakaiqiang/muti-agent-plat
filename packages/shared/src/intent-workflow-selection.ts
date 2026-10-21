/** Selection pins business context; it is not an execution-effect grant. */
export type IntentWorkflowSelectionInput = {
  contractVersion: 'intent-workflow-select-v1';
  dataEpoch: string;
  briefId: string;
  expectedBriefVersion: number;
  expectedIntentRevision: number;
  expectedRequirementRevision: number;
  expectedExecutionEpoch: number;
  expectedSessionGeneration: number;
  workflowId: string;
  workflowVersion: number;
  definitionHash: string;
  confirmationId: string;
  idempotencyKey: string;
};
export function isIntentWorkflowSelectionInput(value: unknown): value is IntentWorkflowSelectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const texts = ['dataEpoch', 'briefId', 'workflowId', 'definitionHash', 'confirmationId', 'idempotencyKey'];
  const versions = ['expectedBriefVersion', 'expectedIntentRevision', 'expectedRequirementRevision', 'expectedExecutionEpoch', 'expectedSessionGeneration', 'workflowVersion'];
  return row.contractVersion === 'intent-workflow-select-v1' && Object.keys(row).every(key => ['contractVersion', ...texts, ...versions].includes(key)) &&
    texts.every(key => typeof row[key] === 'string' && (row[key] as string).trim().length > 0 && (row[key] as string).length <= 256) &&
    versions.every(key => Number.isSafeInteger(row[key]) && (row[key] as number) > 0);
}
