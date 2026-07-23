import type { WorkspaceLease, WorkspaceOperationKind } from '@agent-cluster/shared';

export const WORKSPACE_LEASE_UNAUTHORIZED = 'WORKSPACE_LEASE_UNAUTHORIZED' as const;

export class WorkspaceLeaseUnauthorizedError extends Error {
  readonly code = WORKSPACE_LEASE_UNAUTHORIZED;
  constructor(reason: string) {
    super(`workspace lease unauthorized: ${reason}`);
    this.name = 'WorkspaceLeaseUnauthorizedError';
  }
}

export interface WorkspaceLeaseValidationInput {
  lease: WorkspaceLease;
  operation: WorkspaceOperationKind;
  now: Date;
}

export type WorkspaceLeaseValidationResult =
  | { ok: true }
  | { ok: false; code: typeof WORKSPACE_LEASE_UNAUTHORIZED; reason: string };

const WRITE_OPERATIONS: readonly WorkspaceOperationKind[] = ['applyChangeSet'];

export function validateWorkspaceLease(input: WorkspaceLeaseValidationInput): WorkspaceLeaseValidationResult {
  const { lease, operation, now } = input;
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return unauthorized(`lease expiresAt is not a valid ISO date: ${lease.expiresAt}`);
  }
  if (expiresAt <= now.getTime()) {
    return unauthorized(`lease expired at ${lease.expiresAt}`);
  }
  if (!lease.allowedOperations.includes(operation)) {
    return unauthorized(`operation ${operation} is not in lease.allowedOperations`);
  }
  if (WRITE_OPERATIONS.includes(operation) && lease.mode !== 'read_write') {
    return unauthorized(`operation ${operation} requires a read_write lease but received ${lease.mode}`);
  }
  return { ok: true };
}

function unauthorized(reason: string): WorkspaceLeaseValidationResult {
  return { ok: false, code: WORKSPACE_LEASE_UNAUTHORIZED, reason };
}

export function assertWorkspaceLease(input: WorkspaceLeaseValidationInput): void {
  const result = validateWorkspaceLease(input);
  if (!result.ok) {
    throw new WorkspaceLeaseUnauthorizedError(result.reason);
  }
}
