import { createHash, randomUUID } from 'node:crypto';
import { isSensitiveWorkspacePath } from '../workspace-path-safety.js';
import { AuthorizedGit } from './authorized-git.js';
import type { GitTaskCandidate } from '../contracts.js';

const sha1 = /^[a-f0-9]{40}$/i;
const refSegment = /^[a-zA-Z0-9_-]+$/;

const shortRefSegment = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function candidateRefPrefix(sessionId: string): string {
  return `refs/ac/c/${shortRefSegment(sessionId)}/`;
}

export async function captureGitTaskCandidate(input: {
  worktreePath: string;
  sessionId: string;
  taskId: string;
  baseCommit: string;
  maxChangedFiles?: number;
}, git = new AuthorizedGit()): Promise<GitTaskCandidate | undefined> {
  if (!refSegment.test(input.sessionId) || !refSegment.test(input.taskId) ||
      !sha1.test(input.baseCommit)) throw new Error('GITHUB_CANDIDATE_SCOPE_INVALID');
  const head = await git.run(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
  if (head !== input.baseCommit) throw new Error('GITHUB_CANDIDATE_BASE_CHANGED');
  await git.run(input.worktreePath, ['add', '-A', '--']);
  const output = await git.run(input.worktreePath,
    ['diff', '--cached', '--name-only', '-z', input.baseCommit, '--'], undefined, { raw: true });
  const changedPaths = output.split('\0').filter(Boolean);
  if (changedPaths.length === 0) return undefined;
  if (changedPaths.length > (input.maxChangedFiles ?? 512)) {
    throw new Error('GITHUB_CANDIDATE_FILE_LIMIT');
  }
  for (const path of changedPaths) {
    if (path.startsWith('/') || path.split('/').includes('..') || isSensitiveWorkspacePath(path)) {
      throw new Error('GITHUB_CANDIDATE_PATH_DENIED');
    }
    const stage = await git.run(input.worktreePath, ['ls-files', '--stage', '-z', '--', path],
      undefined, { raw: true });
    if (stage && /^(120000|160000) /.test(stage)) {
      throw new Error('GITHUB_CANDIDATE_LINK_DENIED');
    }
  }
  const treeSha = await git.run(input.worktreePath, ['write-tree']);
  if (!sha1.test(treeSha)) throw new Error('GITHUB_CANDIDATE_TREE_INVALID');
  const id = randomUUID();
  const ref = `${candidateRefPrefix(input.sessionId)}${shortRefSegment(input.taskId)}/${shortRefSegment(id)}`;
  await git.run(input.worktreePath, ['update-ref', ref, treeSha]);
  return {
    id, sessionId: input.sessionId, taskId: input.taskId,
    baseCommit: input.baseCommit, treeSha, ref, changedPaths,
    createdAt: new Date().toISOString()
  };
}
