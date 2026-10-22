/** Server-issued candidate capability. Model output can never create or change this binding. */
export type IntentSourceCandidateBinding = {
  mode: 'candidate_only';
  authorityId: string;
  authorityRevision: number;
  authorityHash: string;
  sourceResourceId: string;
  grantId: string;
  workspaceId: string;
  workspaceBindingHash: string;
  sessionId: string;
  dataEpoch: string;
  sessionGeneration: number;
  workItemId: string;
  taskId: string;
  intentStepId: string;
  invocationId: string;
  operationId: string;
  effectScopeHash: string;
};
