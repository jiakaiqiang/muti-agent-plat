export const RUNTIME_OUTPUT_SCHEMA_VERSION = '1.0' as const;

export const RUNTIME_OUTPUT_KINDS = [
  'agent_message',
  'task_acceptance_decision',
  'task_brief',
  'task_execution_result',
  'file_revision_candidate',
  'post_review_report',
  'final_delivery',
  'user_message_handling_plan'
] as const;

export type RuntimeOutputKind = (typeof RUNTIME_OUTPUT_KINDS)[number];

export const RUNTIME_ARTIFACT_TYPES = [
  'text',
  'markdown',
  'json',
  'code_diff',
  'test_report',
  'feishu_draft',
  'url',
  'file'
] as const;

export type RuntimeArtifactType = (typeof RUNTIME_ARTIFACT_TYPES)[number];

export type ContractValidationSuccess<T> = {
  valid: true;
  value: T;
  errors: [];
};

export type ContractValidationFailure = {
  valid: false;
  errors: string[];
};

export type ContractValidationResult<T> = ContractValidationSuccess<T> | ContractValidationFailure;
