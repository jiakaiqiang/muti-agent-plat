import { normalizeGitHubRepositoryUrl } from '@agent-cluster/shared';
import type { LocalGitHubSourceRequest, LocalGitHubSourceResult, WorkspaceIndexSnapshot } from '@agent-cluster/shared';
import { GitRepositoryWorkspaceManager } from '@agent-cluster/shared/node/repository-workspace-manager';
import { LocalGitHubAuthorizationStore } from './github-authorization-store.js';
import type { LocalRuntimeState } from './state.js';
import { saveState } from './state.js';
import { createWorkspaceState, LocalWorkspace } from './workspace.js';

export class LocalGitHubSourcePreparer {
  constructor(
    private readonly state: LocalRuntimeState,
    private readonly authorizations: LocalGitHubAuthorizationStore,
    private readonly manager: GitRepositoryWorkspaceManager,
    private readonly workspaces: Map<string, LocalWorkspace>,
    private readonly persist: (state: LocalRuntimeState) => Promise<void> = saveState,
    private readonly onIndexUpdated: (snapshot: WorkspaceIndexSnapshot) => void | Promise<void> =
      () => undefined
  ) {}

  async handle(request: LocalGitHubSourceRequest): Promise<LocalGitHubSourceResult> {
    try {
      if (request.action === 'prepare') return await this.prepare(request);
      if (request.action === 'cleanup') {
        const workspaceId = `github-session:${request.sessionId}`;
        await this.manager.cleanupSession(request.sessionId);
        this.workspaces.get(workspaceId)?.close();
        this.workspaces.delete(workspaceId);
        this.state.workspaces = this.state.workspaces.filter((item) => item.workspaceId !== workspaceId);
        await this.persist(this.state);
        return { requestId: request.requestId, status: 'ok' };
      }
      if (request.action === 'branches') {
        this.requireWorkspace(request.sessionId);
        return { requestId: request.requestId, status: 'ok',
          branches: await this.manager.listBranches(request.sessionId) };
      }
      if (request.action === 'select_branch') {
        const workspace = this.requireWorkspace(request.sessionId);
        const selected = await this.manager.selectBaseBranch(request.sessionId, request.baseBranch);
        return { requestId: request.requestId, status: 'ok', baseSha: selected.baseSha,
          workspace: await this.registration(workspace) };
      }
      throw new Error('GITHUB_SOURCE_REQUEST_INVALID');
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_SOURCE_PREPARATION_FAILED';
      return { requestId: request.requestId, status: 'error', error: { code } };
    }
  }

  private async prepare(request: Extract<LocalGitHubSourceRequest, { action: 'prepare' }>): Promise<LocalGitHubSourceResult> {
    const repository = normalizeGitHubRepositoryUrl(request.repositoryUrl);
    const access = await this.authorizations.inspectRepository(request.authorizationId,
      repository.repositoryUrl);
    const prepared = await this.authorizations.withToken(request.authorizationId,
      repository.repositoryUrl, (token) => this.manager.prepare(request.sessionId,
        access.accountId, repository.repositoryUrl, access.repositoryId, token, access.defaultBranch));
    const existing = this.state.workspaces.find((item) => item.workspaceId === prepared.workspaceId);
    if (existing && existing.rootPath !== prepared.workspacePath) {
      throw new Error('GITHUB_SESSION_WORKSPACE_MISMATCH');
    }
    let workspaceState = existing;
    if (!workspaceState) {
      workspaceState = await createWorkspaceState(prepared.workspacePath,
        repository.repositoryId);
      workspaceState.workspaceId = prepared.workspaceId;
      this.state.workspaces.push(workspaceState);
      try { await this.persist(this.state); }
      catch (error) {
        this.state.workspaces = this.state.workspaces.filter((item) => item !== workspaceState);
        throw error;
      }
    }
    let workspace = this.workspaces.get(prepared.workspaceId);
    if (!workspace) {
      workspace = new LocalWorkspace(workspaceState, { onIndexUpdated: this.onIndexUpdated });
      this.workspaces.set(prepared.workspaceId, workspace);
    }
    return { requestId: request.requestId, status: 'ok',
      repositoryId: access.repositoryId, defaultBranch: access.defaultBranch,
      cacheKey: prepared.cacheKey, workspaceId: prepared.workspaceId,
      workspace: await this.registration(workspace) };
  }

  private requireWorkspace(sessionId: string): LocalWorkspace {
    const workspaceId = `github-session:${sessionId}`;
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.state.workspaces.some((item) => item.workspaceId === workspaceId &&
      item.rootPath === this.manager.sessionWorkspacePath(sessionId))) {
      throw new Error('GITHUB_SESSION_WORKSPACE_NOT_FOUND');
    }
    return workspace;
  }

  private async registration(workspace: LocalWorkspace) {
    const index = await workspace.getIndexSnapshot();
    const { entries: _entries, nextCursor: _nextCursor, ...summary } = index;
    return {
      workspaceId: workspace.state.workspaceId,
      displayName: workspace.state.displayName,
      capabilities: workspace.capabilities(),
      revision: await workspace.revision(),
      index: summary,
      permissions: workspace.permissionPolicy(),
      registeredAt: workspace.state.registeredAt
    };
  }
}
