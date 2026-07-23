import type { WorkspaceLeaseMode } from '@agent-cluster/shared';

export type PermissionWaitStatus = 'RUNNING' | 'WAIT_WORKSPACE_PERMISSION';

export interface EvaluatePermissionWaitInput {
  requiredMode: WorkspaceLeaseMode;
  currentState: 'granted' | 'prompt' | 'denied' | 'unsupported';
  taskRequiresWorkspace: boolean;
}

export interface PermissionWaitDecision {
  status: PermissionWaitStatus;
  reason?: 'permission-prompt' | 'permission-denied' | 'permission-unsupported' | 'permission-insufficient';
  requiredMode: WorkspaceLeaseMode;
}

export function evaluatePermissionWaitStatus(
  input: EvaluatePermissionWaitInput
): PermissionWaitDecision {
  if (!input.taskRequiresWorkspace) {
    return { status: 'RUNNING', requiredMode: input.requiredMode };
  }
  if (input.currentState === 'granted') {
    return { status: 'RUNNING', requiredMode: input.requiredMode };
  }
  const reason =
    input.currentState === 'denied'
      ? 'permission-denied'
      : input.currentState === 'unsupported'
        ? 'permission-unsupported'
        : 'permission-prompt';
  return { status: 'WAIT_WORKSPACE_PERMISSION', reason, requiredMode: input.requiredMode };
}
