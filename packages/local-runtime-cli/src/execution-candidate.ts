import { createHash, randomUUID } from 'node:crypto';
import type { InvocationPlan, LocalRuntimePermissionPolicy, RuntimeExecutionCandidate, WorkspaceChangeSet } from '@agent-cluster/shared';

export function candidateHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function captureExecutionCandidate(plan: InvocationPlan, changeSet: WorkspaceChangeSet, permissions: LocalRuntimePermissionPolicy): RuntimeExecutionCandidate {
  if (Buffer.byteLength(JSON.stringify(changeSet), 'utf8') > 1_000_000) throw new Error('CANDIDATE_TOO_LARGE');
  return { id: randomUUID(), invocationId: plan.invocationId, sessionId: plan.sessionId,
    taskId: plan.taskId, workItemId: plan.workItemId, workspaceId: plan.contextEnvelope.L0.workspace.workspaceId,
    baseRevision: changeSet.baseRevision, changeSet, manifestHash: candidateHash(changeSet),
    permissionHash: candidateHash(permissions), outputVersion: plan.expectedOutput.schemaVersion,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), stage: 'candidate_captured' };
}

export function validateExecutionCandidate(plan: InvocationPlan, candidate: RuntimeExecutionCandidate, permissions: LocalRuntimePermissionPolicy) {
  if (candidate.sessionId !== plan.sessionId ||
    (candidate.taskId !== plan.taskId && (!plan.recoveryOriginTaskId || candidate.taskId !== plan.recoveryOriginTaskId)) || candidate.workItemId !== plan.workItemId ||
    candidate.workspaceId !== plan.contextEnvelope.L0.workspace.workspaceId) throw new Error('CANDIDATE_SCOPE_MISMATCH');
  if (!(Date.parse(candidate.expiresAt) > Date.now())) throw new Error('CANDIDATE_EXPIRED');
  if (candidate.outputVersion !== plan.expectedOutput.schemaVersion) throw new Error('CANDIDATE_OUTPUT_VERSION_CHANGED');
  if (candidate.permissionHash !== candidateHash(permissions)) throw new Error('CANDIDATE_PERMISSIONS_CHANGED');
  if (candidate.manifestHash !== candidateHash(candidate.changeSet)) throw new Error('CANDIDATE_HASH_MISMATCH');
  if (Buffer.byteLength(JSON.stringify(candidate.changeSet), 'utf8') > 1_000_000) throw new Error('CANDIDATE_TOO_LARGE');
}
