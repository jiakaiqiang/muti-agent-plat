import { createHash } from 'node:crypto';
import type {
  InvocationPlan,
  RuntimeArtifactSystemEvidence,
  RuntimeFileChange,
  VerifiedTestResult,
  WorkspaceChange,
  WorkspaceChangeSet
} from '@agent-cluster/shared';
import { createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

export function runtimeSystemEvidence(
  input: InvocationPlan,
  fileChanges: RuntimeFileChange[] = [],
  verifiedTestResults: VerifiedTestResult[] = []
): RuntimeArtifactSystemEvidence {
  return createRuntimeArtifactSystemEvidence(input.invocationId, {
    workspaceChangeSet: snapshotChangeSet(input, fileChanges),
    verifiedTestResults,
    capturedAt: nowIso()
  });
}

export function emptyRuntimeSystemEvidence(invocationId: string): RuntimeArtifactSystemEvidence {
  return createRuntimeArtifactSystemEvidence(invocationId, { capturedAt: nowIso() });
}

function snapshotChangeSet(input: InvocationPlan, fileChanges: RuntimeFileChange[]): WorkspaceChangeSet {
  return {
    id: crypto.randomUUID(),
    baseRevision: input.contextEnvelope.L0.workspace.revision,
    changes: fileChanges.map(toWorkspaceChange),
    createdAt: nowIso()
  };
}

function toWorkspaceChange(change: RuntimeFileChange): WorkspaceChange {
  if (change.operation === 'create') {
    if (typeof change.content !== 'string') {
      throw new Error(`SYSTEM_EVIDENCE_INVALID: created file has no captured content: ${change.path}`);
    }
    return { operation: 'create', path: change.path, content: change.content, encoding: 'utf-8' };
  }
  if (typeof change.previousContent !== 'string') {
    throw new Error(`SYSTEM_EVIDENCE_INVALID: ${change.operation} has no captured baseline: ${change.path}`);
  }
  const expectedHash = {
    algorithm: 'sha256' as const,
    value: createHash('sha256').update(change.previousContent, 'utf8').digest('hex')
  };
  if (change.operation === 'delete') {
    return { operation: 'delete', path: change.path, expectedHash };
  }
  if (typeof change.content !== 'string') {
    throw new Error(`SYSTEM_EVIDENCE_INVALID: updated file has no captured content: ${change.path}`);
  }
  return { operation: 'update', path: change.path, content: change.content, encoding: 'utf-8', expectedHash };
}
