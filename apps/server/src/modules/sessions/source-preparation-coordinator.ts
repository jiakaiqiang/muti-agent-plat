import { ConflictException, Injectable, Optional, ServiceUnavailableException, type OnApplicationBootstrap } from '@nestjs/common';
import type { SessionDetail, SourceBinding } from '@agent-cluster/shared';
import { GitHubAuthorizationService, type GitHubAuthorizationView } from '../code-hosts/github-authorization.service.js';
import { GitHubCodeHostAdapter } from '../code-hosts/github-code-host.adapter.js';
import { normalizeGitHubRepositoryUrl } from '../code-hosts/github-repository-url.js';
import { GitRepositoryWorkspaceManager } from '../repository-workspaces/repository-workspace-manager.js';
import { SessionsService } from './sessions.service.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';

@Injectable()
export class SourcePreparationCoordinator implements OnApplicationBootstrap {
  private readonly running = new Map<string, Promise<SourceBinding>>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly authorizations: GitHubAuthorizationService,
    private readonly github: GitHubCodeHostAdapter,
    private readonly workspaces: GitRepositoryWorkspaceManager,
    @Optional() private readonly localRuntime?: LocalRuntimeConnectionService
  ) {}

  onApplicationBootstrap(): void {
    for (const session of this.sessions.list()) {
      const source = this.sessions.get(session.id).sourceBinding;
      if (source &&
          ['awaiting_auth', 'cloning'].includes(source.state)) {
        void this.prepare(session.id).catch(() => undefined);
      }
    }
  }

  prepare(sessionId: string): Promise<SourceBinding> {
    return this.serialize(sessionId, () => this.sessions.get(sessionId).sourceBinding?.executionLocation === 'local'
      ? this.prepareLocalUnlocked(sessionId) : this.prepareUnlocked(sessionId));
  }

  async startOAuth(sessionId: string): Promise<{ authorizationUrl: string }> {
    if (this.sessions.get(sessionId).sourceBinding?.executionLocation === 'local') {
      const session = this.localSession(sessionId);
      if (session.sourceBinding.state === 'ready') throw new ConflictException('SOURCE_ALREADY_READY');
      if (!this.requireLocalRuntime().isDeviceConnected(session.sourceBinding.deviceId!)) {
        throw new ServiceUnavailableException('LOCAL_RUNTIME_UNAVAILABLE');
      }
      return { authorizationUrl: await this.authorizations.startLocalOAuth(sessionId,
        session.codeSource.repositoryUrl, session.sourceBinding.deviceId!) };
    }
    const session = this.serverSession(sessionId);
    if (session.sourceBinding?.state === 'ready') throw new ConflictException('SOURCE_ALREADY_READY');
    return { authorizationUrl: await this.authorizations.startServerOAuth(sessionId,
      session.codeSource!.repositoryUrl) };
  }

  async savePat(sessionId: string, token: string): Promise<SourceBinding> {
    if (this.sessions.get(sessionId).sourceBinding?.executionLocation === 'local') {
      const session = this.localSession(sessionId);
      if (session.sourceBinding.state === 'ready') throw new ConflictException('SOURCE_ALREADY_READY');
      const authorization = await this.requireLocalRuntime().requestGitHubAuthorization(
        session.sourceBinding.deviceId!, { action: 'save_pat',
          repositoryUrl: session.codeSource.repositoryUrl, token });
      if (!authorization) throw new ConflictException('GITHUB_AUTHORIZATION_UNAVAILABLE');
      return this.serialize(sessionId, () => this.prepareLocalUnlocked(sessionId, authorization.id));
    }
    const session = this.serverSession(sessionId);
    if (session.sourceBinding?.state === 'ready') throw new ConflictException('SOURCE_ALREADY_READY');
    const authorization = await this.authorizations.saveServerPat(token,
      session.codeSource!.repositoryUrl);
    return this.serialize(sessionId, () => this.prepareUnlocked(sessionId, authorization));
  }

  async disconnectLocalAuthorization(authorizationId: string, deviceId: string,
    repositoryUrl: string) {
    const disconnected = await this.requireLocalRuntime().requestGitHubAuthorization(deviceId,
      { action: 'disconnect', authorizationId, repositoryUrl });
    if (!disconnected || disconnected.state !== 'disconnected') {
      throw new ConflictException('GITHUB_AUTHORIZATION_DISCONNECT_FAILED');
    }
    return disconnected;
  }

  async completeOAuth(code: string, state: string): Promise<SourceBinding> {
    const exchanged = await this.authorizations.exchangeOAuthCode(code, state);
    if (exchanged.executionLocation === 'local') {
      const session = this.localSession(exchanged.sessionId);
      if (session.sourceBinding.deviceId !== exchanged.deviceId ||
          session.codeSource.repositoryUrl !== exchanged.repositoryUrl) {
        throw new ConflictException('GITHUB_OAUTH_SESSION_MISMATCH');
      }
      const authorization = await this.requireLocalRuntime().requestGitHubAuthorization(
        exchanged.deviceId, { action: 'save_oauth', repositoryUrl: exchanged.repositoryUrl,
          token: exchanged.accessToken, ...(exchanged.expiresAt ? { expiresAt: exchanged.expiresAt } : {}) });
      if (!authorization) throw new ConflictException('GITHUB_AUTHORIZATION_UNAVAILABLE');
      return this.serialize(exchanged.sessionId,
        () => this.prepareLocalUnlocked(exchanged.sessionId, authorization.id));
    }
    const session = this.serverSession(exchanged.sessionId);
    if (session.codeSource?.repositoryUrl !== exchanged.repositoryUrl) {
      throw new ConflictException('GITHUB_OAUTH_SESSION_MISMATCH');
    }
    return this.serialize(exchanged.sessionId,
      () => this.prepareUnlocked(exchanged.sessionId, exchanged.authorization));
  }

  async branches(sessionId: string): Promise<{ defaultBranch: string; branches: Array<{ name: string; sha: string }>; version: number }> {
    const binding = this.sessions.get(sessionId).sourceBinding;
    if (!binding) throw new ConflictException('GITHUB_SOURCE_REQUIRED');
    if (binding.state !== 'awaiting_base_branch' || !binding.defaultBranch) {
      throw new ConflictException('SOURCE_BRANCH_SELECTION_NOT_READY');
    }
    const branches = binding.executionLocation === 'local'
      ? (await this.requireLocalRuntime().requestGitHubSource(binding.deviceId!,
          { action: 'branches', sessionId })).branches!
      : await this.workspaces.listBranches(sessionId);
    return { defaultBranch: binding.defaultBranch, branches, version: binding.version };
  }

  selectBranch(sessionId: string, branch: string, expectedVersion: number): Promise<SourceBinding> {
    return this.serialize(sessionId, async () => {
      const binding = this.sessions.get(sessionId).sourceBinding;
      if (!binding) throw new ConflictException('GITHUB_SOURCE_REQUIRED');
      if (binding.state !== 'awaiting_base_branch' || binding.version !== expectedVersion ||
          !binding.workspaceId || !binding.cacheKey) {
        throw new ConflictException('SOURCE_PREPARATION_VERSION_CONFLICT');
      }
      if (binding.executionLocation === 'local') {
        const selected = await this.requireLocalRuntime().requestGitHubSource(binding.deviceId!,
          { action: 'select_branch', sessionId, baseBranch: branch });
        return this.sessions.completeLocalSourcePreparation(sessionId, expectedVersion,
          { workspaceId: binding.workspaceId, cacheKey: binding.cacheKey,
            baseBranch: branch, baseSha: selected.baseSha! });
      }
      const selected = await this.workspaces.selectBaseBranch(sessionId, branch);
      const prepared = { workspaceId: binding.workspaceId,
        workspacePath: this.workspaces.sessionWorkspacePath(sessionId),
        cacheKey: binding.cacheKey, baseBranch: branch, baseSha: selected.baseSha };
      return this.sessions.completeServerSourcePreparation(sessionId, expectedVersion, prepared);
    });
  }

  private async prepareUnlocked(sessionId: string, supplied?: GitHubAuthorizationView): Promise<SourceBinding> {
    const session = this.serverSession(sessionId);
    let binding = session.sourceBinding!;
    if (binding.state === 'ready' || binding.state === 'awaiting_base_branch') return binding;
    const authorization = supplied ?? await this.authorizations.findReusableServerAuthorization(
      session.codeSource!.repositoryUrl);
    if (!authorization) {
      if (binding.state !== 'awaiting_auth') {
        binding = this.sessions.updateServerSourcePreparation(sessionId, binding.version,
          { state: 'awaiting_auth', errorCode: undefined });
      }
      return binding;
    }
    binding = this.sessions.updateServerSourcePreparation(sessionId, binding.version,
      { state: 'cloning', authorizationRef: authorization.id, errorCode: undefined });
    try {
      const prepared = await this.authorizations.withServerToken(authorization.id,
        binding.repositoryUrl, async (token) => {
          const repository = normalizeGitHubRepositoryUrl(binding.repositoryUrl);
          const access = await this.github.inspectRepository(token, repository);
          const workspace = await this.workspaces.prepare(sessionId, authorization.accountId,
            repository.repositoryUrl, access.id, token, access.defaultBranch);
          return { access, workspace };
        });
      return this.sessions.updateServerSourcePreparation(sessionId, binding.version, {
        state: 'awaiting_base_branch', repositoryId: prepared.access.id,
        defaultBranch: prepared.access.defaultBranch,
        cacheKey: prepared.workspace.cacheKey, workspaceId: prepared.workspace.workspaceId,
        errorCode: undefined
      });
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_SOURCE_PREPARATION_FAILED';
      this.sessions.updateServerSourcePreparation(sessionId, binding.version,
        { state: 'failed', errorCode: code });
      throw new Error(code);
    }
  }

  private async prepareLocalUnlocked(sessionId: string, suppliedAuthorizationId?: string): Promise<SourceBinding> {
    const session = this.localSession(sessionId);
    let binding = session.sourceBinding;
    if (binding.state === 'ready' || binding.state === 'awaiting_base_branch') return binding;
    const localRuntime = this.requireLocalRuntime();
    let authorizationId = suppliedAuthorizationId;
    if (!authorizationId) {
      try {
        authorizationId = (await localRuntime.requestGitHubAuthorization(binding.deviceId!, {
          action: 'find_reusable', repositoryUrl: binding.repositoryUrl }))?.id;
      } catch {
        return this.sessions.updateLocalSourcePreparation(sessionId, binding.version,
          { state: 'blocked', errorCode: 'LOCAL_RUNTIME_UNAVAILABLE' });
      }
    }
    if (!authorizationId) {
      if (binding.state !== 'awaiting_auth') {
        binding = this.sessions.updateLocalSourcePreparation(sessionId, binding.version,
          { state: 'awaiting_auth', errorCode: undefined });
      }
      return binding;
    }
    binding = this.sessions.updateLocalSourcePreparation(sessionId, binding.version,
      { state: 'cloning', authorizationRef: authorizationId, errorCode: undefined });
    try {
      const prepared = await localRuntime.requestGitHubSource(binding.deviceId!, {
        action: 'prepare', sessionId, repositoryUrl: binding.repositoryUrl, authorizationId
      });
      return this.sessions.updateLocalSourcePreparation(sessionId, binding.version, {
        state: 'awaiting_base_branch', repositoryId: prepared.repositoryId,
        defaultBranch: prepared.defaultBranch, cacheKey: prepared.cacheKey,
        workspaceId: prepared.workspaceId, errorCode: undefined
      });
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_SOURCE_PREPARATION_FAILED';
      this.sessions.updateLocalSourcePreparation(sessionId, binding.version,
        { state: 'failed', errorCode: code });
      throw new Error(code);
    }
  }

  private localSession(sessionId: string): SessionDetail & { sourceBinding: SourceBinding;
    codeSource: Extract<SessionDetail['codeSource'], { kind: 'remote_repository' }> } {
    const session = this.sessions.get(sessionId);
    if (session.codeSource?.kind !== 'remote_repository' ||
        session.sourceBinding?.executionLocation !== 'local' || !session.sourceBinding.deviceId) {
      throw new ConflictException('GITHUB_LOCAL_SOURCE_REQUIRED');
    }
    return session as SessionDetail & { sourceBinding: SourceBinding;
      codeSource: Extract<SessionDetail['codeSource'], { kind: 'remote_repository' }> };
  }

  private requireLocalRuntime(): LocalRuntimeConnectionService {
    if (!this.localRuntime) throw new ServiceUnavailableException('LOCAL_RUNTIME_UNAVAILABLE');
    return this.localRuntime;
  }

  private serverSession(sessionId: string): SessionDetail & { sourceBinding: SourceBinding;
    codeSource: Extract<SessionDetail['codeSource'], { kind: 'remote_repository' }> } {
    const session = this.sessions.get(sessionId);
    if (session.codeSource?.kind !== 'remote_repository' ||
        session.sourceBinding?.executionLocation !== 'server') {
      throw new ConflictException('GITHUB_SERVER_SOURCE_REQUIRED');
    }
    return session as SessionDetail & { sourceBinding: SourceBinding;
      codeSource: Extract<SessionDetail['codeSource'], { kind: 'remote_repository' }> };
  }

  private serialize(sessionId: string, operation: () => Promise<SourceBinding>): Promise<SourceBinding> {
    const previous = this.running.get(sessionId);
    const current = (previous ?? Promise.resolve(undefined)).then(operation, operation);
    this.running.set(sessionId, current);
    void current.finally(() => {
      if (this.running.get(sessionId) === current) this.running.delete(sessionId);
    }).catch(() => undefined);
    return current;
  }
}
