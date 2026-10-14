import type { GitTaskCandidate } from '../contracts.js';
import { isSensitiveWorkspacePath } from '../workspace-path-safety.js';
import { AuthorizedGit } from './authorized-git.js';
import { candidateRefPrefix } from './git-task-candidate.js';

const sha1 = /^[a-f0-9]{40}$/i;

export type GitDeliveryIntegration = {
  baseCommit: string;
  treeSha?: string;
  changedPaths: string[];
  conflicts: string[];
};

export async function changedGitPaths(worktreePath: string, parentSha: string,
  treeSha: string, git = new AuthorizedGit()): Promise<string[]> {
  if (!sha1.test(parentSha) || !sha1.test(treeSha)) {
    throw new Error('GITHUB_DELIVERY_SHA_INVALID');
  }
  return (await git.run(worktreePath,
    ['diff', '--name-only', '-z', parentSha, treeSha, '--'],
    undefined, { raw: true })).split('\0').filter(Boolean).sort();
}

export async function integrateGitTaskCandidates(input: {
  worktreePath: string;
  sessionId: string;
  baseCommit: string;
  candidates: readonly GitTaskCandidate[];
}, git = new AuthorizedGit()): Promise<GitDeliveryIntegration> {
  if (!sha1.test(input.baseCommit) ||
      await git.run(input.worktreePath, ['rev-parse', '--verify', 'HEAD']) !== input.baseCommit) {
    throw new Error('GITHUB_DELIVERY_BASE_CHANGED');
  }
  for (const candidate of input.candidates) {
    if (candidate.sessionId !== input.sessionId || candidate.baseCommit !== input.baseCommit ||
        !sha1.test(candidate.treeSha) || !candidate.ref.startsWith(candidateRefPrefix(input.sessionId)) ||
        await git.run(input.worktreePath, ['rev-parse', '--verify', `${candidate.ref}^{tree}`]) !== candidate.treeSha) {
      throw new Error('GITHUB_CANDIDATE_SCOPE_MISMATCH');
    }
    const actualPaths = (await git.run(input.worktreePath,
      ['diff', '--name-only', '-z', input.baseCommit, candidate.treeSha, '--'],
      undefined, { raw: true })).split('\0').filter(Boolean).sort();
    if (actualPaths.some((path) => isSensitiveWorkspacePath(path) || path.startsWith('/') ||
        path.split('/').includes('..')) ||
        actualPaths.join('\0') !== [...candidate.changedPaths].sort().join('\0')) {
      throw new Error('GITHUB_CANDIDATE_MANIFEST_MISMATCH');
    }
    for (const path of actualPaths) {
      const entry = await git.run(input.worktreePath,
        ['ls-tree', '-z', candidate.treeSha, '--', path], undefined, { raw: true });
      if (/^(120000|160000) /.test(entry)) throw new Error('GITHUB_CANDIDATE_LINK_DENIED');
    }
  }
  if (await git.run(input.worktreePath, ['status', '--porcelain'])) {
    throw new Error('GITHUB_DELIVERY_WORKSPACE_DIRTY');
  }
  for (const candidate of input.candidates) {
    const commit = await git.run(input.worktreePath, [
      '-c', 'user.name=Agent Cluster', '-c', 'user.email=agent-cluster@local.invalid',
      'commit-tree', candidate.treeSha, '-p', candidate.baseCommit,
      '-m', `Agent Cluster candidate ${candidate.id}`
    ]);
    try {
      await git.run(input.worktreePath, ['cherry-pick', '--no-commit', commit]);
    } catch (error) {
      const unmerged = await git.run(input.worktreePath, ['ls-files', '--unmerged', '-z'],
        undefined, { raw: true });
      const conflicts = [...new Set(unmerged.split('\0').filter(Boolean).map((entry) =>
        entry.slice(entry.indexOf('\t') + 1)))].sort();
      if (!conflicts.length) throw error;
      return { baseCommit: input.baseCommit, changedPaths: [], conflicts };
    }
  }
  const treeSha = await git.run(input.worktreePath, ['write-tree']);
  const changedPaths = (await git.run(input.worktreePath,
    ['diff', '--cached', '--name-only', '-z', input.baseCommit, '--'], undefined, { raw: true }))
    .split('\0').filter(Boolean);
  return { baseCommit: input.baseCommit, treeSha, changedPaths, conflicts: [] };
}
