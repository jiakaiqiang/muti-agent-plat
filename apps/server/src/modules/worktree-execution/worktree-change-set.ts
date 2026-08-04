import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type {
  FileHash,
  RuntimeFileChange,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { assertWithinRootRealpath, safeJoin } from '../../common/path-safety.js';
import { isWorkspaceSensitivePath } from '../workspaces/workspace-sensitive-guard.js';
import { runGit, runGitText } from './git-command.js';

const DEFAULT_MAX_CHANGED_FILES = 512;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function buildWorktreeChangeSet(input: {
  worktreeRoot: string;
  baseCommit: string;
  baseRevision: WorkspaceRevision;
  baselineHashes: Record<string, string>;
  scopePath?: string;
}): Promise<WorkspaceChangeSet> {
  const changedPaths = await listChangedPaths(input.worktreeRoot, input.baseCommit);
  const scope = normalizeScope(input.scopePath);
  const outsideScope = scope
    ? changedPaths.filter((path) => path !== scope && !path.startsWith(`${scope}/`))
    : [];
  if (outsideScope.length) {
    throw new Error(`worktree changed paths outside the selected directory: ${outsideScope.join(', ')}`);
  }
  const maxFiles = Number(process.env.AGENT_CLUSTER_WORKTREE_MAX_CHANGED_FILES ?? DEFAULT_MAX_CHANGED_FILES);
  if (changedPaths.length > maxFiles) {
    throw new Error(`worktree changed ${changedPaths.length} files, exceeding the limit of ${maxFiles}`);
  }

  const changes: WorkspaceChange[] = [];
  for (const repositoryPath of changedPaths) {
    const path = scope ? repositoryPath.slice(scope.length).replace(/^\//, '') : repositoryPath;
    if (!path) continue;
    if (isWorkspaceSensitivePath(path)) {
      throw new Error(`worktree change contains a sensitive path: ${path}`);
    }
    const base = await readBaseFile(input.worktreeRoot, input.baseCommit, repositoryPath);
    const current = await readCurrentFile(input.worktreeRoot, repositoryPath);
    if (base && current && base.equals(current)) continue;
    if (!base && current) {
      changes.push({ operation: 'create', path, content: decodeText(path, current), encoding: 'utf-8' });
      continue;
    }
    if (base && !current) {
      changes.push({
        operation: 'delete',
        path,
        expectedHash: baselineHash(input.baselineHashes, repositoryPath),
        baseContent: decodeText(path, base)
      });
      continue;
    }
    if (base && current) {
      changes.push({
        operation: 'update',
        path,
        content: decodeText(path, current),
        encoding: 'utf-8',
        expectedHash: baselineHash(input.baselineHashes, repositoryPath),
        baseContent: decodeText(path, base)
      });
    }
  }

  return {
    id: randomUUID(),
    baseRevision: input.baseRevision,
    changes,
    createdAt: new Date().toISOString()
  };
}

function normalizeScope(value: string | undefined) {
  const normalized = value?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
  return normalized && normalized !== '.' ? normalized : undefined;
}

export function changeSetFileChanges(
  changeSet: WorkspaceChangeSet,
  baselineContents: Readonly<Record<string, string>> = {}
): RuntimeFileChange[] {
  return changeSet.changes.map((change) => {
    if (change.operation === 'move') {
      return {
        path: change.toPath,
        operation: 'create' as const,
        encoding: 'utf-8' as const,
        source: 'runtime_proposed_change' as const
      };
    }
    return {
      path: change.path,
      operation: change.operation,
      ...('content' in change ? { content: change.content } : {}),
      ...(change.operation !== 'create' && baselineContents[change.path] !== undefined
        ? { previousContent: baselineContents[change.path] }
        : {}),
      encoding: 'utf-8' as const,
      source: 'runtime_proposed_change' as const
    };
  });
}

async function listChangedPaths(worktreeRoot: string, baseCommit: string) {
  const [tracked, untracked] = await Promise.all([
    runGit(worktreeRoot, ['diff', '--name-only', '-z', baseCommit, '--']),
    runGit(worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  return [...new Set([...nulList(tracked), ...nulList(untracked)])].sort((left, right) => left.localeCompare(right));
}

async function readBaseFile(worktreeRoot: string, baseCommit: string, path: string): Promise<Buffer | undefined> {
  const exists = await runGitText(worktreeRoot, ['cat-file', '-e', `${baseCommit}:${path}`])
    .then(() => true)
    .catch(() => false);
  if (!exists) return undefined;
  // `git show <revision>:<path>` performs revision/path disambiguation that can
  // stat the combined argument relative to a deep worktree on Windows. Reading
  // the already-resolved blob directly avoids that MAX_PATH-sensitive branch.
  const content = await runGit(worktreeRoot, ['cat-file', 'blob', `${baseCommit}:${path}`]);
  assertFileSize(path, content);
  return content;
}

async function readCurrentFile(worktreeRoot: string, path: string): Promise<Buffer | undefined> {
  const absolute = safeJoin(worktreeRoot, path);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`worktree change cannot contain a symbolic link: ${path}`);
    if (!stat.isFile()) return undefined;
    await assertWithinRootRealpath(worktreeRoot, absolute);
    const content = await readFile(absolute);
    assertFileSize(path, content);
    return content;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function decodeText(path: string, content: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`binary or non-UTF-8 worktree changes are not supported yet: ${path}`);
  }
}

function assertFileSize(path: string, content: Buffer) {
  const maxBytes = Number(process.env.AGENT_CLUSTER_WORKTREE_MAX_FILE_BYTES ?? DEFAULT_MAX_FILE_BYTES);
  if (content.length > maxBytes) throw new Error(`worktree file exceeds ${maxBytes} bytes: ${path}`);
}

function baselineHash(hashes: Record<string, string>, path: string): FileHash {
  const value = hashes[path];
  if (!value) throw new Error(`worktree baseline hash is missing for: ${path}`);
  return { algorithm: 'sha256', value };
}

function nulList(content: Buffer) {
  return content.toString('utf8').split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

function isEnoent(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT';
}
