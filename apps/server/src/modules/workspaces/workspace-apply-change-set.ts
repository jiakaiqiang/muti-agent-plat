import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ApplyChangeSetResult,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { resolveWorkspacePath } from './workspace-path.js';
import { validateChangeSetBaseHashes } from './workspace-change-set-validation.js';
import { createWorkspaceRevision } from './workspace-revision.js';

export interface ApplyServerLocalChangeSetArgs {
  rootPath: string;
  currentRevision: WorkspaceRevision;
  nextRevision?: WorkspaceRevision;
  changeSet: WorkspaceChangeSet;
}

export async function applyServerLocalChangeSet(
  args: ApplyServerLocalChangeSetArgs
): Promise<ApplyChangeSetResult> {
  const { rootPath, currentRevision, nextRevision, changeSet } = args;

  const conflicts = await validateChangeSetBaseHashes({
    rootPath,
    currentRevision,
    changeSet
  });
  if (conflicts.length > 0) {
    return {
      ok: false,
      changeSetId: changeSet.id,
      revision: currentRevision,
      conflicts
    };
  }

  for (const change of changeSet.changes) {
    await applyChange(rootPath, change);
  }

  return {
    ok: true,
    changeSetId: changeSet.id,
    revision: nextRevision ?? createWorkspaceRevision(),
    appliedCount: changeSet.changes.length
  };
}

async function applyChange(rootPath: string, change: WorkspaceChange): Promise<void> {
  if (change.operation === 'create') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, change.content, change.encoding);
    return;
  }
  if (change.operation === 'update') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await writeFile(absolute, change.content, change.encoding);
    return;
  }
  if (change.operation === 'delete') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await rm(absolute, { force: true });
    return;
  }
  const { absolute: fromAbsolute } = resolveWorkspacePath(rootPath, change.fromPath);
  const { absolute: toAbsolute } = resolveWorkspacePath(rootPath, change.toPath);
  await mkdir(dirname(toAbsolute), { recursive: true });
  await rename(fromAbsolute, toAbsolute);
}
