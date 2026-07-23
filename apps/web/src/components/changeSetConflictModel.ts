import type { WorkspaceChange, WorkspaceChangeSet, WorkspaceConflictError } from '@agent-cluster/shared';

export interface ChangeSetConflictRow {
  path: string;
  targetPath?: string;
  operation: WorkspaceChange['operation'];
  writable: boolean;
  conflictCode?: WorkspaceConflictError['code'];
  conflictMessage?: string;
}

export interface ChangeSetConflictModel {
  hasConflicts: boolean;
  rows: ChangeSetConflictRow[];
}

export interface BuildChangeSetConflictModelInput {
  changeSet: WorkspaceChangeSet;
  conflicts: readonly WorkspaceConflictError[];
}

export function buildChangeSetConflictModel(
  input: BuildChangeSetConflictModelInput
): ChangeSetConflictModel {
  const { changeSet, conflicts } = input;
  const byPath = new Map<string, WorkspaceConflictError>();
  for (const conflict of conflicts) byPath.set(conflict.path, conflict);

  const rows: ChangeSetConflictRow[] = changeSet.changes.map((change) => {
    const rowPath = change.operation === 'move' ? change.fromPath : change.path;
    const targetPath = change.operation === 'move' ? change.toPath : undefined;
    const conflict = byPath.get(rowPath);
    if (conflict) {
      return {
        path: rowPath,
        ...(targetPath ? { targetPath } : {}),
        operation: change.operation,
        writable: false,
        conflictCode: conflict.code,
        conflictMessage: conflict.message
      };
    }
    return {
      path: rowPath,
      ...(targetPath ? { targetPath } : {}),
      operation: change.operation,
      writable: true
    };
  });

  return { hasConflicts: conflicts.length > 0, rows };
}
