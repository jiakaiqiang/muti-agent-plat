import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type {
  FileHash,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceConflictError,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { WORKSPACE_BASE_HASH_MISMATCH } from '@agent-cluster/shared';
import { resolveWorkspacePath } from './workspace-path.js';

export interface ValidateChangeSetBaseHashesArgs {
  rootPath: string;
  currentRevision: WorkspaceRevision;
  changeSet: WorkspaceChangeSet;
}

export async function validateChangeSetBaseHashes(
  args: ValidateChangeSetBaseHashesArgs
): Promise<WorkspaceConflictError[]> {
  const { rootPath, currentRevision, changeSet } = args;
  const conflicts: WorkspaceConflictError[] = [];
  for (const change of changeSet.changes) {
    if (change.operation === 'create') {
      const { absolute } = resolveWorkspacePath(rootPath, change.path);
      const actual = await inspectPath(absolute);
      if (actual.exists) {
        conflicts.push({
          code: WORKSPACE_BASE_HASH_MISMATCH,
          message: `Create target already exists: ${change.path}`,
          changeSetId: changeSet.id,
          operation: 'create',
          path: change.path,
          ...(actual.hash ? { actualHash: actual.hash } : {}),
          actualRevision: currentRevision
        });
      }
      continue;
    }
    const conflict = await checkChange(rootPath, currentRevision, changeSet.id, change);
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

async function checkChange(
  rootPath: string,
  currentRevision: WorkspaceRevision,
  changeSetId: string,
  change: Exclude<WorkspaceChange, { operation: 'create' }>
): Promise<WorkspaceConflictError | null> {
  const targetPath = change.operation === 'move' ? change.fromPath : change.path;
  const { absolute } = resolveWorkspacePath(rootPath, targetPath);
  const actualHash = await hashFileIfExists(absolute);
  if (actualHash && hashesEqual(actualHash, change.expectedHash)) {
    return null;
  }
  return {
    code: WORKSPACE_BASE_HASH_MISMATCH,
    message:
      actualHash === null
        ? `Target file no longer exists: ${targetPath}`
        : `File hash changed since ChangeSet was prepared: ${targetPath}`,
    changeSetId,
    operation: change.operation,
    path: targetPath,
    baseHash: change.expectedHash,
    ...(actualHash ? { actualHash } : {}),
    actualRevision: currentRevision
  };
}

async function hashFileIfExists(absolute: string): Promise<FileHash | null> {
  try {
    const buffer = await readFile(absolute);
    return { algorithm: 'sha256', value: createHash('sha256').update(buffer).digest('hex') };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function inspectPath(absolute: string): Promise<{ exists: boolean; hash?: FileHash }> {
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) return { exists: true };
    const buffer = await readFile(absolute);
    return { exists: true, hash: { algorithm: 'sha256', value: createHash('sha256').update(buffer).digest('hex') } };
  } catch (error) {
    if (isEnoent(error)) return { exists: false };
    throw error;
  }
}

function hashesEqual(a: FileHash, b: FileHash): boolean {
  return a.algorithm === b.algorithm && a.value === b.value;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT';
}
