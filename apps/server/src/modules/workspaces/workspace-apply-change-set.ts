import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import { assertWorkspaceWriteAllowed } from './workspace-sensitive-guard.js';
import { assertWorkspacePathWithinRoot } from './workspace-symlink-guard.js';
import { WorkspaceWriteLock } from './workspace-write-lock.js';
import { mergeServerLocalChangeSet } from './workspace-merge-change-set.js';

const applyWriteLock = new WorkspaceWriteLock();

function collectWritePaths(changes: readonly WorkspaceChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.operation === 'move') {
      paths.add(change.fromPath);
      paths.add(change.toPath);
      continue;
    }
    paths.add(change.path);
  }
  return Array.from(paths);
}

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

  assertWorkspaceWriteAllowed(changeSet.changes);

  const paths = collectWritePaths(changeSet.changes).map((path) => `${rootPath}::${path}`);
  return await applyWriteLock.runAll(paths, async () => {
    const merged = await mergeServerLocalChangeSet({ rootPath, currentRevision, changeSet });
    if (merged.conflicts.length > 0) {
      return { ok: false, changeSetId: changeSet.id, revision: currentRevision, conflicts: merged.conflicts };
    }
    const conflicts = await validateChangeSetBaseHashes({
      rootPath,
      currentRevision,
      changeSet: merged.changeSet
    });
    if (conflicts.length > 0) {
      return {
        ok: false,
        changeSetId: changeSet.id,
        revision: currentRevision,
        conflicts
      };
    }

    const snapshots = await Promise.all(collectWritePaths(merged.changeSet.changes).map((path) => snapshot(rootPath, path)));
    const snapshotByPath = new Map(snapshots.map((entry) => [entry.path, entry]));
    const appliedStates = new Map<string, PathSnapshot>();
    try {
      for (const change of merged.changeSet.changes) {
        const lateConflicts = await validateChangeSetBaseHashes({
          rootPath,
          currentRevision,
          changeSet: { ...merged.changeSet, changes: [change] }
        });
        if (lateConflicts.length) throw new WorkspaceApplyConflict(lateConflicts);
        await applyChange(rootPath, change);
        for (const expected of expectedAppliedStates(change, snapshotByPath)) appliedStates.set(expected.path, expected);
      }
    } catch (error) {
      const rollbackErrors = await rollbackAppliedPaths(rootPath, snapshots, appliedStates);
      if (rollbackErrors.length) {
        throw new Error(
          `WORKSPACE_ROLLBACK_REQUIRES_ATTENTION: ${rollbackErrors.join('; ')}`,
          { cause: error }
        );
      }
      if (error instanceof WorkspaceApplyConflict) {
        return {
          ok: false,
          changeSetId: changeSet.id,
          revision: currentRevision,
          conflicts: error.conflicts
        };
      }
      throw error;
    }

    return {
      ok: true,
      changeSetId: changeSet.id,
      revision: nextRevision ?? createWorkspaceRevision(),
      appliedCount: merged.changeSet.changes.length
    };
  });
}

class WorkspaceApplyConflict extends Error {
  constructor(readonly conflicts: Awaited<ReturnType<typeof validateChangeSetBaseHashes>>) {
    super('Workspace changed while the ChangeSet was being applied.');
  }
}

export type PathSnapshot = { path: string; kind: 'missing' | 'file'; content?: Buffer };

function expectedAppliedStates(change: WorkspaceChange, snapshots: Map<string, PathSnapshot>): PathSnapshot[] {
  if (change.operation === 'create' || change.operation === 'update') {
    return [{ path: change.path, kind: 'file', content: Buffer.from(change.content, change.encoding) }];
  }
  if (change.operation === 'delete') return [{ path: change.path, kind: 'missing' }];
  const source = snapshots.get(change.fromPath);
  if (!source || source.kind !== 'file') throw new Error(`Move source snapshot is unavailable: ${change.fromPath}`);
  return [
    { path: change.fromPath, kind: 'missing' },
    { path: change.toPath, kind: 'file', content: source.content }
  ];
}

export async function rollbackAppliedPaths(
  rootPath: string,
  snapshots: PathSnapshot[],
  appliedStates: Map<string, PathSnapshot>
) {
  const errors: string[] = [];
  for (const original of snapshots) {
    const expected = appliedStates.get(original.path);
    if (!expected) continue;
    const current = await snapshot(rootPath, original.path).catch((error) => {
      errors.push(`${original.path}: cannot inspect current state (${String(error)})`);
      return undefined;
    });
    if (!current) continue;
    if (!sameSnapshot(current, expected)) {
      errors.push(`${original.path}: changed after the batch write; automatic rollback was skipped`);
      continue;
    }
    await restore(rootPath, original).catch((error) => {
      errors.push(`${original.path}: rollback failed (${String(error)})`);
    });
  }
  return errors;
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'missing') return true;
  return Boolean(left.content?.equals(right.content!));
}

async function snapshot(rootPath: string, path: string): Promise<PathSnapshot> {
  const absolute = resolveWorkspacePath(rootPath, path).absolute;
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new Error(`Workspace write target is not a file: ${path}`);
    return { path, kind: 'file', content: await readFile(absolute) };
  } catch (error) {
    if (isEnoent(error)) return { path, kind: 'missing' };
    throw error;
  }
}

async function restore(rootPath: string, entry: PathSnapshot) {
  const absolute = resolveWorkspacePath(rootPath, entry.path).absolute;
  if (entry.kind === 'missing') {
    await rm(absolute, { force: true });
    return;
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, entry.content!);
}

function isEnoent(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT';
}

async function applyChange(rootPath: string, change: WorkspaceChange): Promise<void> {
  if (change.operation === 'create') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await assertWorkspacePathWithinRoot(rootPath, change.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, change.content, change.encoding);
    return;
  }
  if (change.operation === 'update') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await assertWorkspacePathWithinRoot(rootPath, change.path);
    await writeFile(absolute, change.content, change.encoding);
    return;
  }
  if (change.operation === 'delete') {
    const { absolute } = resolveWorkspacePath(rootPath, change.path);
    await assertWorkspacePathWithinRoot(rootPath, change.path);
    await rm(absolute, { force: true });
    return;
  }
  const { absolute: fromAbsolute } = resolveWorkspacePath(rootPath, change.fromPath);
  const { absolute: toAbsolute } = resolveWorkspacePath(rootPath, change.toPath);
  await assertWorkspacePathWithinRoot(rootPath, change.fromPath);
  await assertWorkspacePathWithinRoot(rootPath, change.toPath);
  await mkdir(dirname(toAbsolute), { recursive: true });
  await rename(fromAbsolute, toAbsolute);
}
