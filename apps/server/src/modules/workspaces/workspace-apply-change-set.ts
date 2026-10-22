import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
/** Human source reconciliation shares the actual apply lock; sampling cannot race an in-process write. */
export const sourceReconciliationWriteLock = applyWriteLock;

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
  authorize?: (rootPath: string, finalChangeSet: WorkspaceChangeSet) => Promise<void>;
}

export async function applyServerLocalChangeSet(
  args: ApplyServerLocalChangeSetArgs
): Promise<ApplyChangeSetResult> {
  const { rootPath, currentRevision, nextRevision, changeSet } = args;
  let writeOutcomeUncertain = false;

  assertWorkspaceWriteAllowed(changeSet.changes);

  const paths = collectWritePaths(changeSet.changes).map((path) => `${rootPath}::${path}`);
  return await applyWriteLock.runAll(paths, async (): Promise<ApplyChangeSetResult> => {
    await args.authorize?.(rootPath, changeSet);
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

    // Merge/force/conflict resolution may change bytes. Check the final batch before its first write.
    await args.authorize?.(rootPath, merged.changeSet);
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
        // writeFile can mutate/truncate before throwing (ENOSPC/EIO). Until its expected state is
        // recorded, the rollback routine cannot prove that this file has been restored.
        writeOutcomeUncertain = true;
        if (args.authorize) {
          if (change.operation !== 'update') throw new Error('INTENT_SOURCE_UPDATE_REQUIRED');
          await applyPinnedSourceUpdate(rootPath, change, snapshotByPath.get(change.path),
            () => args.authorize!(rootPath, merged.changeSet));
        } else await applyChange(rootPath, change);
        for (const expected of expectedAppliedStates(change, snapshotByPath)) {
          if (args.authorize) {
            const original = snapshotByPath.get(expected.path);
            expected.dev = original?.dev; expected.ino = original?.ino;
          }
          appliedStates.set(expected.path, expected);
        }
        writeOutcomeUncertain = false;
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
  }).catch((error: unknown) => {
    if (!args.authorize) throw error;
    // The inner catch rolls back every applied path. A rollback conflict is deliberately unknown.
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(message, { cause: error }), {
      workspaceApplyOutcome: writeOutcomeUncertain || message.includes('WORKSPACE_ROLLBACK_REQUIRES_ATTENTION') ? 'unknown' : 'not_applied'
    });
  });
}

class WorkspaceApplyConflict extends Error {
  constructor(readonly conflicts: Awaited<ReturnType<typeof validateChangeSetBaseHashes>>) {
    super('Workspace changed while the ChangeSet was being applied.');
  }
}

export type PathSnapshot = { path: string; kind: 'missing' | 'file'; content?: Buffer; dev?: number; ino?: number };

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
    await restore(rootPath, original, expected).catch((error) => {
      errors.push(`${original.path}: rollback failed (${String(error)})`);
    });
  }
  return errors;
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'missing') return true;
  if (right.dev !== undefined && (left.dev !== right.dev || left.ino !== right.ino)) return false;
  return Boolean(left.content?.equals(right.content!));
}

async function snapshot(rootPath: string, path: string): Promise<PathSnapshot> {
  const absolute = resolveWorkspacePath(rootPath, path).absolute;
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) throw new Error(`Workspace write target is not a file: ${path}`);
    return { path, kind: 'file', content: await readFile(absolute), dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (isEnoent(error)) return { path, kind: 'missing' };
    throw error;
  }
}

async function restore(rootPath: string, entry: PathSnapshot, expected?: PathSnapshot) {
  const absolute = resolveWorkspacePath(rootPath, entry.path).absolute;
  if (expected?.dev !== undefined && entry.kind === 'file') {
    const handle = await open(absolute, 'r+');
    try {
      const metadata = await handle.stat();
      if (metadata.dev !== expected.dev || metadata.ino !== expected.ino || metadata.nlink !== 1 ||
          metadata.size !== expected.content?.length) throw new Error('pinned rollback target changed');
      const observed = Buffer.alloc(expected.content.length + 1);
      const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
      if (bytesRead !== expected.content.length || !observed.subarray(0, bytesRead).equals(expected.content)) {
        throw new Error('pinned rollback content changed');
      }
      await writeFile(handle, entry.content!);
      await handle.truncate(entry.content!.length);
    } finally { await handle.close(); }
    return;
  }
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

/** A final path check cannot pin a target: a concurrent rename could redirect writeFile(path).
 * Open without truncation first, prove its identity and content, then authorize and write that handle. */
async function applyPinnedSourceUpdate(rootPath: string, change: Extract<WorkspaceChange, { operation: 'update' }>,
  original: PathSnapshot | undefined, authorize: () => Promise<void>): Promise<void> {
  if (!original?.content || original.kind !== 'file') throw new Error('INTENT_SOURCE_BASELINE_REQUIRED');
  const absolute = resolveWorkspacePath(rootPath, change.path).absolute;
  await assertWorkspacePathWithinRoot(rootPath, change.path);
  const handle = await open(absolute, 'r+');
  let written = false;
  const proposed = Buffer.from(change.content, 'utf8');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.dev !== original.dev || metadata.ino !== original.ino ||
        metadata.size !== original.content.length) throw new Error('INTENT_SOURCE_FILE_IDENTITY_CHANGED');
    const observed = Buffer.alloc(original.content.length + 1);
    const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
    if (bytesRead !== original.content.length || !observed.subarray(0, bytesRead).equals(original.content)) {
      throw new Error('INTENT_SOURCE_BASELINE_CHANGED');
    }
    await authorize();
    await writeFile(handle, proposed);
    await handle.truncate(proposed.length);
    written = true;
    // Detect a changed root/path after admission, without following it for writing or rollback.
    await authorize();
  } catch (error) {
    if (written) {
      const observed = Buffer.alloc(proposed.length + 1);
      const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
      if (bytesRead !== proposed.length || !observed.subarray(0, bytesRead).equals(proposed)) {
        throw new Error('WORKSPACE_ROLLBACK_REQUIRES_ATTENTION: pinned file changed after write', { cause: error });
      }
      await handle.write(original.content, 0, original.content.length, 0);
      await handle.truncate(original.content.length);
    }
    throw error;
  } finally { await handle.close(); }
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
