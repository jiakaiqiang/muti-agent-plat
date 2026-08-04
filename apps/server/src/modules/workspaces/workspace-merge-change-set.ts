import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  FileHash,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceConflictError,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { mergeWorkspaceText, WORKSPACE_MERGE_CONFLICT } from '@agent-cluster/shared';
import { resolveWorkspacePath } from './workspace-path.js';

export async function mergeServerLocalChangeSet(input: {
  rootPath: string;
  currentRevision: WorkspaceRevision;
  changeSet: WorkspaceChangeSet;
}): Promise<{ changeSet: WorkspaceChangeSet; conflicts: WorkspaceConflictError[] }> {
  const changes: WorkspaceChange[] = [];
  const conflicts: WorkspaceConflictError[] = [];
  for (const change of input.changeSet.changes) {
    if (change.operation !== 'update') {
      changes.push(change);
      continue;
    }
    const absolute = resolveWorkspacePath(input.rootPath, change.path).absolute;
    const current = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!current || hashesEqual(hash(current), change.expectedHash)) {
      changes.push(change);
      continue;
    }
    if (change.baseContent === undefined) {
      changes.push(change);
      continue;
    }
    const currentText = decodeUtf8(current);
    const merged = currentText === undefined
      ? { ok: false as const, reason: 'overlapping_changes' as const }
      : mergeWorkspaceText(change.baseContent, currentText, change.content);
    if (!merged.ok) {
      conflicts.push({
        code: WORKSPACE_MERGE_CONFLICT,
        message: `Current and Session changes overlap: ${change.path}`,
        changeSetId: input.changeSet.id,
        operation: change.operation,
        path: change.path,
        baseHash: change.expectedHash,
        actualHash: hash(current),
        actualRevision: input.currentRevision
      });
      continue;
    }
    if (merged.content === currentText) continue;
    changes.push({ ...change, content: merged.content, expectedHash: hash(current) });
  }
  return { changeSet: { ...input.changeSet, changes }, conflicts };
}

function hash(content: Buffer): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') };
}

function hashesEqual(left: FileHash, right: FileHash) {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function decodeUtf8(content: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}
