import type {
  ApplyChangeSetResult,
  WorkspaceChangeSet,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { assertSafeBrowserWorkspacePath } from './workspaceBrokerPath';

export interface BrowserWritableFile {
  write: (contents: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface BrowserWritableFileHandle {
  createWritable: () => Promise<BrowserWritableFile>;
}

export interface BrowserWritableDirectoryHandle {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<BrowserWritableFileHandle>;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<BrowserWritableDirectoryHandle>;
  removeEntry?: (name: string) => Promise<void>;
}

export interface BrowserApplyChangeSetArgs {
  root: BrowserWritableDirectoryHandle;
  changeSet: WorkspaceChangeSet;
  nextRevision: WorkspaceRevision;
}

export async function browserApplyChangeSet(
  args: BrowserApplyChangeSetArgs
): Promise<ApplyChangeSetResult> {
  const { root, changeSet, nextRevision } = args;
  let applied = 0;
  for (const change of changeSet.changes) {
    if (change.operation === 'create' || change.operation === 'update') {
      const { parent, filename } = await resolveWritableParent(root, change.path, true);
      const fileHandle = await parent.getFileHandle(filename, { create: change.operation === 'create' });
      const writable = await fileHandle.createWritable();
      await writable.write(change.content);
      await writable.close();
      applied += 1;
      continue;
    }
    if (change.operation === 'delete') {
      const { parent, filename } = await resolveWritableParent(root, change.path, false);
      if (!parent.removeEntry) {
        throw new Error(`browser workspace does not support delete: ${change.path}`);
      }
      await parent.removeEntry(filename);
      applied += 1;
      continue;
    }
    const fromLookup = await resolveWritableParent(root, change.fromPath, false);
    const toLookup = await resolveWritableParent(root, change.toPath, true);
    const sourceFile = await fromLookup.parent.getFileHandle(fromLookup.filename);
    const sourceContent = await readWritableFile(sourceFile);
    const destination = await toLookup.parent.getFileHandle(toLookup.filename, { create: true });
    const writable = await destination.createWritable();
    await writable.write(sourceContent);
    await writable.close();
    if (fromLookup.parent.removeEntry) {
      await fromLookup.parent.removeEntry(fromLookup.filename);
    }
    applied += 1;
  }
  return {
    ok: true,
    changeSetId: changeSet.id,
    revision: nextRevision,
    appliedCount: applied
  };
}

async function resolveWritableParent(
  root: BrowserWritableDirectoryHandle,
  path: string,
  createDirectories: boolean
): Promise<{ parent: BrowserWritableDirectoryHandle; filename: string }> {
  const normalized = assertSafeBrowserWorkspacePath(path);
  const segments = normalized.split('/');
  if (segments.length === 0) throw new Error(`empty path: ${path}`);
  const filename = segments[segments.length - 1];
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = await current.getDirectoryHandle(segments[i], { create: createDirectories });
  }
  return { parent: current, filename };
}

async function readWritableFile(handle: BrowserWritableFileHandle): Promise<string> {
  const extended = handle as unknown as {
    getFile?: () => Promise<{ text: () => Promise<string> }>;
  };
  if (typeof extended.getFile !== 'function') return '';
  const file = await extended.getFile();
  return file.text();
}
