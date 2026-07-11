import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  FileHash,
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import { resolveWorkspacePath } from './workspace-path.js';

const DEFAULT_LIMIT = 200;

export interface ListServerLocalDirectoryArgs {
  rootPath: string;
  revision: WorkspaceRevision;
  input: ListDirectoryInput;
}

export async function listServerLocalDirectory(
  args: ListServerLocalDirectoryArgs
): Promise<ListDirectoryResult> {
  const { rootPath, revision, input } = args;
  const { relative: relativePath, absolute } = resolveWorkspacePath(rootPath, input.path ?? '');
  const rawEntries = await readdir(absolute, { withFileTypes: true });
  const visible = rawEntries
    .filter((entry) => !(entry.isDirectory() && isGeneratedWorkspaceDirectory(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cursorIndex = decodeCursor(input.cursor, visible.length);
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const slice = visible.slice(cursorIndex, cursorIndex + limit);

  const entries: FileMetadata[] = [];
  for (const dirent of slice) {
    const entryRelative = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
    const entryAbsolute = join(absolute, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({
        path: entryRelative,
        kind: 'directory',
        revision
      });
      continue;
    }
    if (!dirent.isFile()) {
      continue;
    }
    const stats = await stat(entryAbsolute);
    const hash = await hashFile(entryAbsolute);
    entries.push({
      path: entryRelative,
      kind: 'file',
      size: stats.size,
      hash,
      revision,
      modifiedAt: stats.mtime.toISOString()
    });
  }

  const nextIndex = cursorIndex + slice.length;
  const nextCursor = nextIndex < visible.length ? encodeCursor(nextIndex) : undefined;

  return {
    path: relativePath,
    entries,
    revision,
    ...(nextCursor ? { nextCursor } : {})
  };
}

async function hashFile(filePath: string): Promise<FileHash> {
  const content = await readFile(filePath);
  const digest = createHash('sha256').update(content).digest('hex');
  return { algorithm: 'sha256', value: digest };
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, total: number): number {
  if (!cursor) return 0;
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (!Number.isFinite(decoded) || decoded < 0) return 0;
  return Math.min(decoded, total);
}
