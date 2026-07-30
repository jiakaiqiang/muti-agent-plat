import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import { isSensitivePath } from '../../common/path-safety.js';
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
  const cursorIndex = decodeCursor(input.cursor, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const targetCount = cursorIndex + limit + 1;
  const deadlineAt = input.deadlineMs ? Date.now() + Math.max(1, input.deadlineMs) : Number.POSITIVE_INFINITY;
  let deadlineReached = false;
  const entries: FileMetadata[] = [];
  const maxDepth = Math.min(8, Math.max(0, input.maxDepth ?? (input.recursive ? 1 : 0)));
  const visit = async (directory: string, directoryRelative: string, depth: number): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of children) {
      if (Date.now() >= deadlineAt) { deadlineReached = true; return; }
      if (entries.length >= targetCount) return;
      const entryRelative = directoryRelative ? `${directoryRelative}/${dirent.name}` : dirent.name;
      if (isSensitivePath(entryRelative)) continue;
      if (dirent.isDirectory() && isGeneratedWorkspaceDirectory(dirent.name)) continue;
      const entryAbsolute = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        const stats = await stat(entryAbsolute);
        entries.push({ path: entryRelative, kind: 'directory', revision, modifiedAt: stats.mtime.toISOString() });
        if (input.recursive && depth < maxDepth) await visit(entryAbsolute, entryRelative, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      const stats = await stat(entryAbsolute);
      entries.push({ path: entryRelative, kind: 'file', size: stats.size, revision, modifiedAt: stats.mtime.toISOString() });
    }
  };
  await visit(absolute, relativePath, 0);

  const page = entries.slice(cursorIndex, cursorIndex + limit);
  const nextIndex = cursorIndex + page.length;
  const nextCursor = entries.length > nextIndex || deadlineReached ? encodeCursor(nextIndex) : undefined;

  return {
    path: relativePath,
    entries: page,
    revision,
    ...(nextCursor ? { nextCursor } : {})
  };
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
