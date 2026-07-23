export type SessionWaitStatus = 'RUNNING' | 'WAIT_WORKSPACE_CLIENT';

export interface EvaluateWaitStatusInput {
  workspaceKind: 'server_local' | 'browser_broker' | 'local_bridge';
  brokerConnected: boolean;
  taskRequiresWorkspace: boolean;
}

export interface WaitStatusDecision {
  status: SessionWaitStatus;
  reason?: 'broker-offline';
}

export function evaluateBrokerWaitStatus(input: EvaluateWaitStatusInput): WaitStatusDecision {
  if (!input.taskRequiresWorkspace) return { status: 'RUNNING' };
  if (input.workspaceKind !== 'browser_broker') return { status: 'RUNNING' };
  if (input.brokerConnected) return { status: 'RUNNING' };
  return { status: 'WAIT_WORKSPACE_CLIENT', reason: 'broker-offline' };
}
