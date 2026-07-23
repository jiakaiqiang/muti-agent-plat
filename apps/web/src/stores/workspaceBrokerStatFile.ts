import type { FileMetadata, StatFileInput, WorkspaceRevision } from '@agent-cluster/shared';
import type { BrowserDirectoryHandle, BrowserFileHandle } from './workspaceBrokerReadFile';
import { assertSafeBrowserWorkspacePath } from './workspaceBrokerPath';

export class BrowserWorkspaceFileNotFoundError extends Error {
  readonly code = 'WORKSPACE_FILE_NOT_FOUND';
  readonly path: string;
  constructor(path: string) {
    super(`workspace file not found: ${path}`);
    this.name = 'BrowserWorkspaceFileNotFoundError';
    this.path = path;
  }
}

export interface BrowserStatFileArgs {
  root: BrowserDirectoryHandle;
  input: StatFileInput;
  revision: WorkspaceRevision;
  digest: (bytes: ArrayBuffer) => Promise<string>;
}

export async function browserStatFile(args: BrowserStatFileArgs): Promise<FileMetadata> {
  const { root, input, revision, digest } = args;
  const segments = normalizeSegments(input.path);
  const parent = await resolveParent(root, segments);
  const name = segments[segments.length - 1];

  const fileHandle = await tryGetFileHandle(parent, name);
  if (fileHandle) {
    const file = await fileHandle.getFile();
    const hashValue = await digest(await file.arrayBuffer());
    return {
      path: input.path,
      kind: 'file',
      size: file.size,
      hash: { algorithm: 'sha256', value: hashValue },
      revision,
      modifiedAt: new Date(file.lastModified).toISOString()
    };
  }

  const dirHandle = await tryGetDirectoryHandle(parent, name);
  if (dirHandle) {
    return { path: input.path, kind: 'directory', revision };
  }

  throw new BrowserWorkspaceFileNotFoundError(input.path);
}

function normalizeSegments(path: string): string[] {
  const normalized = assertSafeBrowserWorkspacePath(path);
  if (!normalized) throw new Error('empty path');
  return normalized.split('/');
}

async function resolveParent(
  root: BrowserDirectoryHandle,
  segments: string[]
): Promise<BrowserDirectoryHandle> {
  let current: BrowserDirectoryHandle = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = await current.getDirectoryHandle(segments[i]);
  }
  return current;
}

async function tryGetFileHandle(
  parent: BrowserDirectoryHandle,
  name: string
): Promise<BrowserFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch {
    return null;
  }
}

async function tryGetDirectoryHandle(
  parent: BrowserDirectoryHandle,
  name: string
): Promise<BrowserDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}
