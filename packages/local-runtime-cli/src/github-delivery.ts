import type { LocalGitHubDeliveryRequest, LocalGitHubDeliveryResult } from '@agent-cluster/shared';
import { AuthorizedGit } from '@agent-cluster/shared/node/authorized-git';
import { GitRepositoryWorkspaceManager } from '@agent-cluster/shared/node/repository-workspace-manager';
import { changedGitPaths, integrateGitTaskCandidates } from '@agent-cluster/shared/node/git-delivery-integration';
import { detectRepositoryValidation, runRepositoryValidation } from '@agent-cluster/shared/node/repository-validation';
import { publishGitDelivery } from '@agent-cluster/shared/node/git-delivery-publisher';
import { GitHubPullRequests } from '@agent-cluster/shared/node/github-pull-requests';
import { GitConflictEditor } from '@agent-cluster/shared/node/git-conflict-editor';
import type { LocalGitHubAuthorizationStore } from './github-authorization-store.js';

export class LocalGitHubDelivery {
  private readonly git = new AuthorizedGit();
  private readonly conflicts: GitConflictEditor;

  constructor(private readonly manager = new GitRepositoryWorkspaceManager(),
    private readonly authorizations?: LocalGitHubAuthorizationStore,
    private readonly pulls = new GitHubPullRequests()) {
    this.conflicts = new GitConflictEditor(manager);
  }

  async handle(request: LocalGitHubDeliveryRequest): Promise<LocalGitHubDeliveryResult> {
    try {
      if (request.action === 'publish') {
        if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
        const identity = this.authorizations.identityFor(request.authorizationId, request.repositoryUrl);
        return await this.authorizations.withToken(request.authorizationId, request.repositoryUrl,
          async (token) => {
            const published = await publishGitDelivery({
              worktreePath: this.manager.deliveryWorkspacePath(request.sessionId),
              repositoryUrl: request.repositoryUrl, sessionId: request.sessionId,
              round: request.round, baseSha: request.baseSha, treeSha: request.treeSha,
              previousCommitSha: request.previousCommitSha,
              integratedRemoteSha: request.integratedRemoteSha, token, ...identity
            });
            if (published.outcome === 'remote_changed') {
              const integrated = await this.conflicts.start({ sessionId: request.sessionId,
                round: request.round, headSha: published.candidateCommitSha,
                baseBranch: published.taskBranch, token,
                targetOperation: 'integrate_task_branch' });
              return { requestId: request.requestId, sessionId: request.sessionId,
                status: 'ok' as const, outcome: 'remote_changed' as const,
                taskBranch: published.taskBranch, remoteHeadSha: published.remoteHeadSha,
                treeSha: integrated.treeSha, conflictView: integrated.view };
            }
            const pull = await this.pulls.createOrReopen(token, request.repositoryUrl,
              published.taskBranch, request.baseBranch,
              `Agent Cluster assisted delivery ${request.round}`);
            if (pull.headSha !== published.commitSha) throw new Error('GITHUB_PULL_HEAD_MISMATCH');
            const ciStatus = await this.pulls.ciStatus(token, request.repositoryUrl, pull.headSha);
            return { requestId: request.requestId, sessionId: request.sessionId,
              status: 'ok' as const, outcome: 'published' as const,
              taskBranch: published.taskBranch, commitSha: published.commitSha,
              pullRequestNumber: pull.number, pullRequestUrl: pull.url,
              pullRequestHeadSha: pull.headSha, ciStatus, mergeable: pull.mergeable };
          });
      }
      if (request.action === 'status' || request.action === 'merge') {
        if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
        return await this.authorizations.withToken(request.authorizationId, request.repositoryUrl,
          async (token) => {
            const pull = await this.pulls.get(token, request.repositoryUrl, request.pullRequestNumber);
            if (request.action === 'merge') {
              if (pull.state !== 'open' || pull.headSha !== request.expectedHeadSha) {
                throw new Error('GITHUB_PULL_HEAD_CHANGED');
              }
              const ciStatus = await this.pulls.ciStatus(token, request.repositoryUrl, pull.headSha);
              if (!['passed', 'not_configured'].includes(ciStatus) || pull.mergeable !== true) {
                throw new Error('GITHUB_MERGE_NOT_READY');
              }
              const mergedCommitSha = await this.pulls.squashMerge(token, request.repositoryUrl,
                pull.number, request.expectedHeadSha);
              return { requestId: request.requestId, sessionId: request.sessionId,
                status: 'ok' as const, outcome: 'merged' as const, mergedCommitSha };
            }
            const ciStatus = pull.state === 'open' && !pull.merged
              ? await this.pulls.ciStatus(token, request.repositoryUrl, pull.headSha) : undefined;
            return { requestId: request.requestId, sessionId: request.sessionId,
              status: 'ok' as const, outcome: 'status' as const,
              pullRequestNumber: pull.number, pullRequestUrl: pull.url,
              pullRequestHeadSha: pull.headSha, pullRequestState: pull.state,
              mergeable: pull.mergeable, mergedCommitSha: pull.mergeCommitSha,
              ...(ciStatus ? { ciStatus } : {}) };
          });
      }
      if (request.action === 'diff') {
        if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
        return await this.authorizations.withToken(request.authorizationId, request.repositoryUrl,
          async (token) => ({ requestId: request.requestId, sessionId: request.sessionId,
            status: 'ok' as const, outcome: 'diff' as const,
            diff: await this.pulls.diff(token, request.repositoryUrl, {
              kind: request.kind, number: request.pullRequestNumber,
              sha: request.sha, page: request.page
            }) }));
      }
      if (request.action === 'start_conflict') {
        if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
        return await this.authorizations.withToken(request.authorizationId, request.repositoryUrl,
          async (token) => {
            const started = await this.conflicts.start({ sessionId: request.sessionId,
              round: request.round, headSha: request.headSha,
              baseBranch: request.baseBranch, token,
              targetOperation: 'merge_pull_request' });
            return { requestId: request.requestId, sessionId: request.sessionId,
              status: 'ok' as const,
              outcome: started.view ? 'conflict_view' as const : 'conflict_complete' as const,
              conflictView: started.view, treeSha: started.treeSha };
          });
      }
      if (request.action === 'conflict_view') {
        return { requestId: request.requestId, sessionId: request.sessionId,
          status: 'ok', outcome: 'conflict_view',
          conflictView: await this.conflicts.view(request.sessionId, request.conflictId) };
      }
      if (request.action === 'conflict_save') {
        return { requestId: request.requestId, sessionId: request.sessionId,
          status: 'ok', outcome: 'conflict_view',
          conflictView: await this.conflicts.saveFile(request) };
      }
      if (request.action === 'conflict_complete') {
        return { requestId: request.requestId, sessionId: request.sessionId,
          status: 'ok', outcome: 'conflict_complete',
          treeSha: await this.conflicts.complete(request.sessionId,
            request.conflictId, request.expectedVersion) };
      }
      const path = request.action === 'integrate_validate'
        ? await this.manager.prepareDelivery(request.sessionId, request.baseSha, true)
        : this.manager.deliveryWorkspacePath(request.sessionId);
      if (request.action === 'integrate_validate') {
        const integrated = await integrateGitTaskCandidates({ worktreePath: path,
          sessionId: request.sessionId, baseCommit: request.baseSha,
          candidates: request.candidates });
        if (integrated.conflicts.length) {
          const conflictView = await this.conflicts.captureExisting(request.sessionId,
            request.round, 'integrate_task_branch');
          return { requestId: request.requestId,
            sessionId: request.sessionId, status: 'ok', outcome: 'conflict',
            conflicts: integrated.conflicts, conflictView };
        }
        if (!integrated.changedPaths.length) return { requestId: request.requestId,
          sessionId: request.sessionId, status: 'ok', outcome: 'no_changes',
          treeSha: integrated.treeSha, changedPaths: [] };
        const command = request.command ?? await detectRepositoryValidation(path);
        if (!command) return { requestId: request.requestId, sessionId: request.sessionId,
          status: 'ok', outcome: 'needs_input', treeSha: integrated.treeSha,
          changedPaths: integrated.changedPaths };
        const validation = await runRepositoryValidation({ root: path,
          candidateSha: integrated.treeSha!, command });
        return { requestId: request.requestId, sessionId: request.sessionId,
          status: 'ok', outcome: 'validated', treeSha: integrated.treeSha,
          changedPaths: integrated.changedPaths, validation, command };
      }
      const treeSha = await this.git.run(path, ['write-tree']);
      if (treeSha !== request.treeSha) throw new Error('GITHUB_VALIDATION_CANDIDATE_CHANGED');
      const changedPaths = await changedGitPaths(path, request.comparisonSha, treeSha, this.git);
      if (!changedPaths.length) return { requestId: request.requestId,
        sessionId: request.sessionId, status: 'ok', outcome: 'no_changes',
        treeSha, changedPaths };
      const command = request.command ?? await detectRepositoryValidation(path);
      if (!command) return { requestId: request.requestId, sessionId: request.sessionId,
        status: 'ok', outcome: 'needs_input', treeSha, changedPaths };
      const validation = await runRepositoryValidation({ root: path,
        candidateSha: treeSha, command });
      return { requestId: request.requestId, sessionId: request.sessionId,
        status: 'ok', outcome: 'validated', treeSha, changedPaths, validation, command };
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_DELIVERY_FAILED';
      return { requestId: request.requestId, sessionId: request.sessionId,
        status: 'error', error: { code } };
    }
  }
}
