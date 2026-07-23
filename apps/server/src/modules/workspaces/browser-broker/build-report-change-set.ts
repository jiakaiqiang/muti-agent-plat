import type {
  FileHash,
  WorkspaceChangeSet,
  WorkspaceRevision
} from '@agent-cluster/shared';

export interface BuildReportChangeSetArgs {
  changeSetId: string;
  baseRevision: WorkspaceRevision;
  path: string;
  content: string;
  existingHash?: FileHash;
  createdAt: string;
}

export function buildReportChangeSet(args: BuildReportChangeSetArgs): WorkspaceChangeSet {
  const { changeSetId, baseRevision, path, content, existingHash, createdAt } = args;
  const changes = existingHash
    ? [
        {
          operation: 'update' as const,
          path,
          content,
          encoding: 'utf-8' as const,
          expectedHash: existingHash
        }
      ]
    : [
        {
          operation: 'create' as const,
          path,
          content,
          encoding: 'utf-8' as const
        }
      ];
  return {
    id: changeSetId,
    baseRevision,
    changes,
    createdAt
  };
}
