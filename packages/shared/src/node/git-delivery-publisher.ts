import { normalizeGitHubRepositoryUrl } from '../github-repository-url.js';
import { AuthorizedGit } from './authorized-git.js';

const sha = /^[a-f0-9]{40}$/i;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskBranchForDelivery(sessionId: string, round: number): string {
  if (!sessionIdPattern.test(sessionId) || !Number.isSafeInteger(round) || round < 1) {
    throw new Error('GITHUB_DELIVERY_BRANCH_INVALID');
  }
  return `agent-cluster/${sessionId}/${round}`;
}

export type GitDeliveryPublication =
  | { outcome: 'published'; taskBranch: string; commitSha: string; remoteHeadSha?: string }
  | { outcome: 'remote_changed'; taskBranch: string; candidateCommitSha: string;
      remoteHeadSha: string };

export async function publishGitDelivery(input: {
  worktreePath: string;
  repositoryUrl: string;
  sessionId: string;
  round: number;
  baseSha: string;
  treeSha: string;
  previousCommitSha?: string;
  integratedRemoteSha?: string;
  accountId: string;
  accountLogin: string;
  accountEmail?: string;
  token: string;
}, git = new AuthorizedGit()): Promise<GitDeliveryPublication> {
  normalizeGitHubRepositoryUrl(input.repositoryUrl);
  const taskBranch = taskBranchForDelivery(input.sessionId, input.round);
  if (![input.baseSha, input.treeSha, input.previousCommitSha, input.integratedRemoteSha].filter(Boolean)
    .every((value) => sha.test(value!))) throw new Error('GITHUB_DELIVERY_SHA_INVALID');
  if (!/^\d+$/.test(input.accountId) || !/^[A-Za-z0-9-]{1,39}$/.test(input.accountLogin) ||
      !input.token) throw new Error('GITHUB_DELIVERY_AUTHOR_INVALID');
  const email = input.accountEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.accountEmail)
    ? input.accountEmail : `${input.accountId}+${input.accountLogin}@users.noreply.github.com`;
  const actualTree = await git.run(input.worktreePath, ['write-tree']);
  if (actualTree !== input.treeSha) throw new Error('GITHUB_VALIDATION_CANDIDATE_CHANGED');
  const remoteRef = `refs/heads/${taskBranch}`;
  const remoteLine = await git.run(input.worktreePath,
    ['ls-remote', '--heads', 'origin', remoteRef], input.token);
  const remoteHeadSha = remoteLine ? remoteLine.split(/\s+/)[0] : undefined;
  if (remoteHeadSha && !sha.test(remoteHeadSha)) throw new Error('GITHUB_REMOTE_BRANCH_INVALID');
  if (remoteHeadSha && remoteHeadSha !== (input.integratedRemoteSha ?? input.previousCommitSha)) {
    await git.run(input.worktreePath, ['fetch', 'origin', remoteRef], input.token);
    const remoteTree = await git.run(input.worktreePath, ['rev-parse', `${remoteHeadSha}^{tree}`]);
    const message = await git.run(input.worktreePath, ['log', '-1', '--format=%B', remoteHeadSha]);
    let descendsFromPrevious = false;
    if (input.previousCommitSha) {
      try {
        await git.run(input.worktreePath,
          ['merge-base', '--is-ancestor', input.previousCommitSha, remoteHeadSha]);
        descendsFromPrevious = true;
      } catch { /* unrelated remote ref */ }
    }
    if (!descendsFromPrevious && !message.includes(`Agent-Cluster-Session: ${input.sessionId}`)) {
      throw new Error('GITHUB_REMOTE_BRANCH_OWNERSHIP_CONFLICT');
    }
    if (remoteTree === input.treeSha) {
      return { outcome: 'published', taskBranch, commitSha: remoteHeadSha, remoteHeadSha };
    }
    const parent = input.integratedRemoteSha ?? input.previousCommitSha ?? input.baseSha;
    const candidateCommitSha = await git.run(input.worktreePath, [
      '-c', `user.name=${input.accountLogin}`, '-c', `user.email=${email}`,
      'commit-tree', input.treeSha, '-p', parent,
      '-m', `Agent Cluster assisted delivery (round ${input.round})`,
      '-m', `Agent-Cluster-Session: ${input.sessionId}`
    ]);
    return { outcome: 'remote_changed', taskBranch, candidateCommitSha, remoteHeadSha };
  }
  const parent = input.integratedRemoteSha ?? input.previousCommitSha ?? input.baseSha;
  const commitSha = await git.run(input.worktreePath, [
    '-c', `user.name=${input.accountLogin}`, '-c', `user.email=${email}`,
    'commit-tree', input.treeSha, '-p', parent,
    '-m', `Agent Cluster assisted delivery (round ${input.round})`,
    '-m', `Agent-Cluster-Session: ${input.sessionId}`
  ]);
  if (!sha.test(commitSha)) throw new Error('GITHUB_DELIVERY_COMMIT_INVALID');
  await git.run(input.worktreePath,
    ['push', 'origin', `${commitSha}:${remoteRef}`], input.token);
  return { outcome: 'published', taskBranch, commitSha, remoteHeadSha };
}
