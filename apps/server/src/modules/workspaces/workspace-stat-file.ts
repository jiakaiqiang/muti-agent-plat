import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { FileHash, FileMetadata, StatFileInput, WorkspaceRevision } from '@agent-cluster/shared';
import { resolveWorkspacePath } from './workspace-path.js';
import { assertWorkspacePathWithinRoot } from './workspace-symlink-guard.js';

export interface StatServerLocalFileArgs {
  rootPath: string;
  revision: WorkspaceRevision;
  input: StatFileInput;
}

export async function statServerLocalFile(args: StatServerLocalFileArgs): Promise<FileMetadata> {
  const { rootPath, revision, input } = args;
  const { absolute, relative } = resolveWorkspacePath(rootPath, input.path);
  await assertWorkspacePathWithinRoot(rootPath, relative);
  const stats = await stat(absolute);

  if (stats.isDirectory()) {
    return {
      path: relative,
      kind: 'directory',
      revision,
      modifiedAt: stats.mtime.toISOString()
    };
  }

  const hash = await hashFile(absolute);
  return {
    path: relative,
    kind: 'file',
    size: stats.size,
    hash,
    revision,
    modifiedAt: stats.mtime.toISOString()
  };
}

async function hashFile(filePath: string): Promise<FileHash> {
  const content = await readFile(filePath);
  const digest = createHash('sha256').update(content).digest('hex');
  return { algorithm: 'sha256', value: digest };
}
