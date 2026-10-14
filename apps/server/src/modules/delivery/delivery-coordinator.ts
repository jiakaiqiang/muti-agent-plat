import { ConflictException, Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConflictView, DeliveryDiff, DeliveryRecord, DeliveryValidation, RepositoryValidationCommand } from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { AuthorizedGit } from '@agent-cluster/shared/node/authorized-git';
import { changedGitPaths, integrateGitTaskCandidates } from '@agent-cluster/shared/node/git-delivery-integration';
import { detectRepositoryValidation, runRepositoryValidation } from '@agent-cluster/shared/node/repository-validation';
import { publishGitDelivery, taskBranchForDelivery } from '@agent-cluster/shared/node/git-delivery-publisher';
import { GitHubPullRequests } from '@agent-cluster/shared/node/github-pull-requests';
import { GitConflictEditor } from '@agent-cluster/shared/node/git-conflict-editor';
import { GitHubAuthorizationService } from '../code-hosts/github-authorization.service.js';
import { GitHubCodeHostAdapter } from '../code-hosts/github-code-host.adapter.js';
import { normalizeGitHubRepositoryUrl } from '../code-hosts/github-repository-url.js';
import { EventsService } from '../events/events.service.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';
import { GitRepositoryWorkspaceManager } from '../repository-workspaces/repository-workspace-manager.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { transitionDelivery } from './delivery-state.js';

type ValidationOutcome = {
  outcome: 'needs_input' | 'conflict' | 'validated' | 'no_changes';
  treeSha?: string;
  changedPaths?: string[];
  conflicts?: string[];
  conflictView?: ConflictView;
  validation?: DeliveryValidation;
  command?: RepositoryValidationCommand;
};

type RemotePullStatus = {
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestHeadSha: string;
  pullRequestState: 'open' | 'closed';
  mergeable: boolean | null;
  mergedCommitSha?: string;
  ciStatus?: 'not_configured' | 'pending' | 'failed' | 'passed';
};

type PublicationResult =
  | { outcome: 'published'; taskBranch: string; commitSha: string;
      pullRequestNumber: number; pullRequestUrl: string; pullRequestHeadSha: string;
      ciStatus: 'not_configured' | 'pending' | 'failed' | 'passed'; mergeable: boolean | null }
  | { outcome: 'remote_changed'; taskBranch: string; remoteHeadSha: string;
      treeSha?: string; conflictView?: ConflictView };

@Injectable()
export class DeliveryCoordinator implements OnApplicationBootstrap {
  private readonly running = new Map<string, Promise<DeliveryRecord>>();
  private readonly git = new AuthorizedGit();
  private readonly pulls = new GitHubPullRequests();
  private readonly conflicts: GitConflictEditor;

  constructor(
    private readonly sessions: SessionsService,
    private readonly workspaces: GitRepositoryWorkspaceManager,
    private readonly events: EventsService,
    @Optional() private readonly localRuntime?: LocalRuntimeConnectionService,
    @Optional() private readonly authorizations?: GitHubAuthorizationService,
    @Optional() private readonly github?: GitHubCodeHostAdapter
  ) {
    this.conflicts = new GitConflictEditor(workspaces);
    this.sessions.registerDeliveryReadyListener?.((sessionId, version) => {
      void this.validate(sessionId, version).catch(() => undefined);
    });
  }

  onApplicationBootstrap(): void {
    for (const summary of this.sessions.list('active')) {
      const session = this.sessions.get(summary.id);
      const current = session.delivery;
      if (current?.state === 'awaiting_validation_input' && !current.candidateTreeSha &&
          this.events.list(session.id).some((event) => event.type === 'final_delivery_created')) {
        void this.validate(session.id, current.version).catch(() => undefined);
      }
      if (current?.state !== 'validating' && current?.state !== 'pushing' &&
          current?.state !== 'merging') continue;
      const blocked = transitionDelivery(current, current.version, 'blocked', new Date().toISOString());
      this.sessions.updateDeliveryRecord(session.id, current.version, {
        ...blocked, errorCode: current.state === 'pushing'
          ? 'GITHUB_PUBLICATION_INTERRUPTED' : current.state === 'merging'
            ? 'GITHUB_MERGE_INTERRUPTED' : 'GITHUB_VALIDATION_INTERRUPTED'
      });
    }
  }

  validate(sessionId: string, expectedVersion: number,
    command?: RepositoryValidationCommand): Promise<DeliveryRecord> {
    const previous = this.running.get(sessionId);
    const current = (previous ?? Promise.resolve(undefined)).then(() =>
      this.validateUnlocked(sessionId, expectedVersion, command), () =>
      this.validateUnlocked(sessionId, expectedVersion, command));
    this.running.set(sessionId, current);
    void current.finally(() => {
      if (this.running.get(sessionId) === current) this.running.delete(sessionId);
    }).catch(() => undefined);
    return current;
  }

  publish(sessionId: string, expectedVersion: number): Promise<DeliveryRecord> {
    const previous = this.running.get(sessionId);
    const current = (previous ?? Promise.resolve(undefined)).then(() =>
      this.publishUnlocked(sessionId, expectedVersion), () =>
      this.publishUnlocked(sessionId, expectedVersion));
    this.running.set(sessionId, current);
    void current.finally(() => {
      if (this.running.get(sessionId) === current) this.running.delete(sessionId);
    }).catch(() => undefined);
    return current;
  }

  refresh(sessionId: string, expectedVersion: number): Promise<DeliveryRecord> {
    return this.serialize(sessionId, () => this.refreshUnlocked(sessionId, expectedVersion));
  }

  async diff(sessionId: string, kind: DeliveryDiff['kind'], page: number): Promise<DeliveryDiff> {
    const session = this.sessions.get(sessionId);
    const binding = session.sourceBinding;
    const record = session.delivery;
    if (session.codeSource?.kind !== 'remote_repository' ||
        !binding?.authorizationRef || !record ||
        !Number.isSafeInteger(page) || page < 1 || page > 30 ||
        kind === 'pull_request' && (!record.pullRequestNumber || !record.commitSha) ||
        kind === 'merged_commit' && !record.mergedCommitSha) {
      throw new ConflictException('GITHUB_DIFF_NOT_READY');
    }
    const sha = kind === 'pull_request' ? record.commitSha! : record.mergedCommitSha!;
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId || !this.localRuntime) throw new ConflictException('GITHUB_LOCAL_RUNTIME_OFFLINE');
      const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
        action: 'diff', sessionId, authorizationId: binding.authorizationRef,
        repositoryUrl: binding.repositoryUrl, kind, pullRequestNumber: record.pullRequestNumber,
        sha, page
      });
      if (result.outcome !== 'diff' || result.diff?.sha !== sha) {
        throw new ConflictException('GITHUB_DIFF_RESPONSE_INVALID');
      }
      return result.diff;
    }
    if (!this.authorizations) throw new ConflictException('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return this.authorizations.withServerToken(binding.authorizationRef,
      binding.repositoryUrl, (token) => this.pulls.diff(token, binding.repositoryUrl,
        { kind, number: record.pullRequestNumber, sha, page }));
  }

  async conflictView(sessionId: string, conflictId: string): Promise<ConflictView> {
    const session = this.sessions.get(sessionId);
    const binding = session.sourceBinding;
    if (session.delivery?.conflictId !== conflictId || !binding) {
      throw new ConflictException('GITHUB_CONFLICT_NOT_FOUND');
    }
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId || !this.localRuntime) throw new ConflictException('GITHUB_LOCAL_RUNTIME_OFFLINE');
      const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId,
        { action: 'conflict_view', sessionId, conflictId });
      if (result.outcome !== 'conflict_view' || result.conflictView?.id !== conflictId) {
        throw new ConflictException('GITHUB_CONFLICT_RESPONSE_INVALID');
      }
      return result.conflictView;
    }
    return this.conflicts.view(sessionId, conflictId);
  }

  async saveConflictFile(sessionId: string, conflictId: string, fileId: string,
    input: { expectedVersion: number; resultContent?: string;
      binaryChoice?: 'ours' | 'theirs'; confirm: boolean }): Promise<ConflictView> {
    const session = this.sessions.get(sessionId);
    const binding = session.sourceBinding;
    if (session.delivery?.state !== 'resolving_conflict' ||
        session.delivery.conflictId !== conflictId || !binding) {
      throw new ConflictException('GITHUB_CONFLICT_NOT_READY');
    }
    try {
      if (binding.executionLocation === 'local') {
        if (!binding.deviceId || !this.localRuntime) throw new ConflictException('GITHUB_LOCAL_RUNTIME_OFFLINE');
        const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
          action: 'conflict_save', sessionId, conflictId, fileId, ...input
        });
        if (result.outcome !== 'conflict_view' || result.conflictView?.id !== conflictId) {
          throw new ConflictException('GITHUB_CONFLICT_RESPONSE_INVALID');
        }
        return result.conflictView;
      }
      return await this.conflicts.saveFile({ sessionId, conflictId, fileId, ...input });
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_CONFLICT_VERSION_CONFLICT') {
        throw new ConflictException('GITHUB_CONFLICT_VERSION_CONFLICT');
      }
      throw error;
    }
  }

  completeConflict(sessionId: string, conflictId: string,
    expectedVersion: number): Promise<DeliveryRecord> {
    return this.serialize(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      const binding = session.sourceBinding;
      const current = session.delivery;
      if (!binding || current?.state !== 'resolving_conflict' ||
          current.conflictId !== conflictId) {
        throw new ConflictException('GITHUB_CONFLICT_NOT_READY');
      }
      let treeSha: string;
      try {
        if (binding.executionLocation === 'local') {
          if (!binding.deviceId || !this.localRuntime) throw new ConflictException('GITHUB_LOCAL_RUNTIME_OFFLINE');
          const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
            action: 'conflict_complete', sessionId, conflictId, expectedVersion
          });
          if (result.outcome !== 'conflict_complete' || !result.treeSha) {
            throw new ConflictException('GITHUB_CONFLICT_RESPONSE_INVALID');
          }
          treeSha = result.treeSha;
        } else {
          treeSha = await this.conflicts.complete(sessionId, conflictId, expectedVersion);
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'GITHUB_CONFLICT_VERSION_CONFLICT') {
          throw new ConflictException('GITHUB_CONFLICT_VERSION_CONFLICT');
        }
        throw error;
      }
      const next = this.sessions.updateDeliveryRecord(sessionId, current.version, {
        ...current, state: 'awaiting_validation_input', version: current.version + 1,
        candidateTreeSha: treeSha, validation: undefined, errorCode: undefined,
        updatedAt: new Date().toISOString()
      });
      return this.validateUnlocked(sessionId, next.version, next.validationCommand);
    });
  }

  merge(sessionId: string, expectedVersion: number, expectedHeadSha: string,
    idempotencyKey: string): Promise<DeliveryRecord> {
    return this.serialize(sessionId, () =>
      this.mergeUnlocked(sessionId, expectedVersion, expectedHeadSha, idempotencyKey));
  }

  private serialize(sessionId: string, operation: () => Promise<DeliveryRecord>): Promise<DeliveryRecord> {
    const previous = this.running.get(sessionId);
    const current = (previous ?? Promise.resolve(undefined)).then(operation, operation);
    this.running.set(sessionId, current);
    void current.finally(() => {
      if (this.running.get(sessionId) === current) this.running.delete(sessionId);
    }).catch(() => undefined);
    return current;
  }

  private async validateUnlocked(sessionId: string, expectedVersion: number,
    command?: RepositoryValidationCommand): Promise<DeliveryRecord> {
    const session = this.sessions.get(sessionId);
    const binding = session.sourceBinding;
    const current = session.delivery;
    if (session.codeSource?.kind !== 'remote_repository' || binding?.state !== 'ready' ||
        !binding.baseSha || !current || !current.candidates?.length ||
        !['awaiting_validation_input', 'blocked', 'needs_fix'].includes(current.state) ||
        current.version !== expectedVersion) {
      throw new ConflictException('GITHUB_DELIVERY_NOT_READY');
    }
    const selectedCommand = command ?? current.validationCommand;
    const validating = this.sessions.updateDeliveryRecord(sessionId, current.version,
      transitionDelivery(current, current.version, 'validating', new Date().toISOString()));
    let readyToPublish: DeliveryRecord | undefined;
    try {
      const outcome = binding.executionLocation === 'local'
        ? await this.validateLocal(sessionId, binding.deviceId, binding.baseSha, validating, selectedCommand)
        : await this.validateServer(sessionId, binding.baseSha, validating, selectedCommand);
      const target = outcome.outcome === 'conflict' ? 'resolving_conflict'
        : outcome.outcome === 'no_changes' ? 'idle'
          : outcome.outcome === 'needs_input' ? 'awaiting_validation_input'
            : outcome.validation?.exitCode === 0 ? 'preparing_push' : 'needs_fix';
      const transitioned = transitionDelivery(validating, validating.version, target,
        new Date().toISOString());
      const updated = this.sessions.updateDeliveryRecord(sessionId, validating.version, {
        ...transitioned,
        candidateTreeSha: outcome.treeSha ?? validating.candidateTreeSha,
        changedPaths: outcome.changedPaths ?? validating.changedPaths,
        conflictPaths: outcome.conflicts,
        conflictId: outcome.conflictView?.id ?? validating.conflictId,
        validation: outcome.validation,
        validationCommand: outcome.command ?? selectedCommand,
        errorCode: outcome.outcome === 'conflict' ? 'GITHUB_CANDIDATE_CONFLICT'
          : outcome.validation && outcome.validation.exitCode !== 0 ? 'GITHUB_VALIDATION_FAILED' : undefined
      });
      this.events.create({ sessionId, type: 'runtime_progress',
        content: target === 'preparing_push' ? '代码验证通过，等待交付。'
          : target === 'needs_fix' ? '代码验证失败，推送已暂停。'
            : target === 'resolving_conflict' ? '候选代码存在冲突，推送已暂停。'
              : target === 'idle' ? '没有需要提交的代码改动。' : '需要在会话中指定验证方式。',
        metadata: createMetadata('system_notice', { deliveryState: updated.state,
          deliveryVersion: updated.version, changedFileCount: updated.changedPaths?.length ?? 0 }) });
      if (target === 'preparing_push') readyToPublish = updated;
      else return updated;
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_DELIVERY_VALIDATION_FAILED';
      const blocked = transitionDelivery(validating, validating.version, 'blocked', new Date().toISOString());
      return this.sessions.updateDeliveryRecord(sessionId, validating.version, { ...blocked, errorCode: code });
    }
    return this.publishUnlocked(sessionId, readyToPublish.version);
  }

  private async publishUnlocked(sessionId: string, expectedVersion: number): Promise<DeliveryRecord> {
    const session = this.sessions.get(sessionId);
    const binding = session.sourceBinding;
    const current = session.delivery;
    if (session.codeSource?.kind !== 'remote_repository' || binding?.state !== 'ready' ||
        !binding.authorizationRef || !binding.baseSha || !current ||
        current.version !== expectedVersion ||
        !['preparing_push', 'blocked'].includes(current.state) ||
        !current.candidateTreeSha || !current.changedPaths?.length ||
        current.validation?.exitCode !== 0 ||
        current.validation.candidateSha !== current.candidateTreeSha) {
      throw new ConflictException('GITHUB_DELIVERY_NOT_VALIDATED');
    }
    const taskBranch = current.taskBranch ?? taskBranchForDelivery(sessionId, current.round);
    const pushing = this.sessions.updateDeliveryRecord(sessionId, current.version, {
      ...transitionDelivery(current, current.version, 'pushing', new Date().toISOString()),
      taskBranch, errorCode: undefined
    });
    try {
      const result = binding.executionLocation === 'local'
        ? await this.publishLocal(sessionId, binding.deviceId, binding.authorizationRef,
          binding.repositoryUrl, binding.baseSha, pushing)
        : await this.publishServer(sessionId, binding.authorizationRef,
          binding.repositoryUrl, binding.baseSha, pushing);
      if (result.taskBranch !== taskBranch) {
        throw new Error('GITHUB_PUBLICATION_RESPONSE_MISMATCH');
      }
      if (result.outcome === 'remote_changed') {
        if (!result.conflictView && !result.treeSha) {
          throw new Error('GITHUB_REMOTE_INTEGRATION_INVALID');
        }
        const next = this.sessions.updateDeliveryRecord(sessionId, pushing.version, {
          ...transitionDelivery(pushing, pushing.version,
            result.conflictView ? 'resolving_conflict' : 'awaiting_validation_input',
            new Date().toISOString()),
          publishParentSha: result.remoteHeadSha,
          candidateTreeSha: result.treeSha,
          conflictId: result.conflictView?.id,
          conflictPaths: result.conflictView?.files.map((file) => file.path),
          validation: undefined,
          errorCode: result.conflictView ? 'GITHUB_REMOTE_BRANCH_CONFLICT' : undefined
        });
        if (!result.conflictView) {
          void this.validate(sessionId, next.version, next.validationCommand).catch(() => undefined);
        }
        return next;
      }
      if (result.pullRequestHeadSha !== result.commitSha) {
        throw new Error('GITHUB_PUBLICATION_RESPONSE_MISMATCH');
      }
      const nextState = (result.ciStatus === 'passed' || result.ciStatus === 'not_configured') &&
        result.mergeable === true ? 'merge_ready' : 'awaiting_ci';
      const updated = this.sessions.updateDeliveryRecord(sessionId, pushing.version, {
        ...transitionDelivery(pushing, pushing.version, nextState, new Date().toISOString()),
        commitSha: result.commitSha, pullRequestNumber: result.pullRequestNumber,
        pullRequestUrl: result.pullRequestUrl, ciStatus: result.ciStatus,
        mergeable: result.mergeable,
        reviewedHeadSha: undefined, publishParentSha: undefined, errorCode: undefined
      });
      this.events.createOnce(`github-delivery:${sessionId}:${updated.round}:${result.commitSha}`, {
        sessionId, type: 'runtime_progress',
        content: `代码已提交，PR #${result.pullRequestNumber} 等待审查。`,
        metadata: createMetadata('system_notice', { code: 'GITHUB_PULL_REQUEST_UPDATED',
          deliveryRound: updated.round, deliveryVersion: updated.version,
          pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl,
          ciStatus: result.ciStatus })
      });
      return updated;
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_PUBLICATION_FAILED';
      const blocked = transitionDelivery(pushing, pushing.version, 'blocked', new Date().toISOString());
      return this.sessions.updateDeliveryRecord(sessionId, pushing.version, { ...blocked, errorCode: code });
    }
  }

  private async publishLocal(sessionId: string, deviceId: string | undefined,
    authorizationId: string, repositoryUrl: string, baseSha: string,
    record: DeliveryRecord): Promise<PublicationResult> {
    if (!deviceId || !this.localRuntime) throw new Error('GITHUB_LOCAL_RUNTIME_UNAVAILABLE');
    const result = await this.localRuntime.requestGitHubDelivery(deviceId, {
      action: 'publish', sessionId, authorizationId, repositoryUrl,
      round: record.round, baseBranch: record.baseBranch, baseSha,
      treeSha: record.candidateTreeSha!, previousCommitSha: record.commitSha,
      integratedRemoteSha: record.publishParentSha
    });
    if (result.outcome === 'remote_changed' && result.taskBranch && result.remoteHeadSha) {
      return { outcome: 'remote_changed', taskBranch: result.taskBranch,
        remoteHeadSha: result.remoteHeadSha, treeSha: result.treeSha,
        conflictView: result.conflictView };
    }
    if (result.outcome !== 'published' || !result.taskBranch || !result.commitSha ||
        !result.pullRequestNumber || !result.pullRequestUrl || !result.pullRequestHeadSha ||
        !result.ciStatus) throw new Error('GITHUB_PUBLICATION_RESPONSE_INVALID');
    return { outcome: 'published', taskBranch: result.taskBranch, commitSha: result.commitSha,
      pullRequestNumber: result.pullRequestNumber, pullRequestUrl: result.pullRequestUrl,
      pullRequestHeadSha: result.pullRequestHeadSha, ciStatus: result.ciStatus,
      mergeable: result.mergeable ?? null };
  }

  private async publishServer(sessionId: string, authorizationId: string,
    repositoryUrl: string, baseSha: string, record: DeliveryRecord) {
    if (!this.authorizations || !this.github) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return this.authorizations.withServerToken(authorizationId, repositoryUrl, async (token) => {
      const identity = await this.github!.identify(token);
      const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
      await this.github!.inspectRepository(token, repository);
      const published = await publishGitDelivery({
        worktreePath: this.workspaces.deliveryWorkspacePath(sessionId),
        repositoryUrl, sessionId, round: record.round, baseSha,
        treeSha: record.candidateTreeSha!, previousCommitSha: record.commitSha,
        integratedRemoteSha: record.publishParentSha,
        token, accountId: identity.id, accountLogin: identity.login,
        accountEmail: identity.email
      });
      if (published.outcome === 'remote_changed') {
        const integrated = await this.conflicts.start({ sessionId, round: record.round,
          headSha: published.candidateCommitSha, baseBranch: published.taskBranch,
          token, targetOperation: 'integrate_task_branch' });
        return { outcome: 'remote_changed' as const, taskBranch: published.taskBranch,
          remoteHeadSha: published.remoteHeadSha, treeSha: integrated.treeSha,
          conflictView: integrated.view };
      }
      const pull = await this.pulls.createOrReopen(token, repositoryUrl,
        published.taskBranch, record.baseBranch,
        `Agent Cluster assisted delivery ${record.round}`);
      if (pull.headSha !== published.commitSha) throw new Error('GITHUB_PULL_HEAD_MISMATCH');
      const ciStatus = await this.pulls.ciStatus(token, repositoryUrl, pull.headSha);
      return { outcome: 'published' as const,
        taskBranch: published.taskBranch, commitSha: published.commitSha,
        pullRequestNumber: pull.number, pullRequestUrl: pull.url,
        pullRequestHeadSha: pull.headSha, ciStatus, mergeable: pull.mergeable };
    });
  }

  private async refreshUnlocked(sessionId: string, expectedVersion: number): Promise<DeliveryRecord> {
    const session = this.sessions.get(sessionId);
    const current = session.delivery;
    if (!current || current.version !== expectedVersion || !current.pullRequestNumber ||
        !current.commitSha || !session.sourceBinding?.authorizationRef ||
        session.codeSource?.kind !== 'remote_repository') {
      throw new ConflictException('GITHUB_DELIVERY_REFRESH_NOT_READY');
    }
    if (current.state === 'resolving_conflict') return current;
    const remote = await this.remoteStatus(sessionId, current);
    if (remote.pullRequestNumber !== current.pullRequestNumber) {
      throw new ConflictException('GITHUB_PULL_NUMBER_MISMATCH');
    }
    if (remote.mergedCommitSha && remote.pullRequestState === 'closed') {
      if (current.state === 'merged' && current.mergedCommitSha === remote.mergedCommitSha) return current;
      const merged = { ...current, state: 'merged' as const, version: current.version + 1,
        mergedCommitSha: remote.mergedCommitSha, updatedAt: new Date().toISOString(),
        errorCode: undefined };
      const updated = this.sessions.updateDeliveryRecord(sessionId, current.version, merged);
      this.notifyMerged(sessionId, updated);
      return updated;
    }
    const headChanged = remote.pullRequestHeadSha !== current.commitSha;
    const closed = remote.pullRequestState === 'closed';
    const state = headChanged || closed ? 'blocked'
      : remote.mergeable === true &&
        ['passed', 'not_configured'].includes(remote.ciStatus ?? '') ? 'merge_ready'
        : 'awaiting_ci';
    const errorCode = headChanged ? 'GITHUB_PULL_HEAD_CHANGED'
      : closed ? 'GITHUB_PULL_CLOSED'
        : remote.mergeable === false ? 'GITHUB_PULL_CONFLICT' : undefined;
    if (current.state === state && current.ciStatus === remote.ciStatus &&
        current.mergeable === remote.mergeable && current.errorCode === errorCode) return current;
    return this.sessions.updateDeliveryRecord(sessionId, current.version, {
      ...current, state, version: current.version + 1,
      ciStatus: remote.ciStatus, mergeable: remote.mergeable, errorCode,
      updatedAt: new Date().toISOString()
    });
  }

  private async mergeUnlocked(sessionId: string, expectedVersion: number, expectedHeadSha: string,
    idempotencyKey: string): Promise<DeliveryRecord> {
    const session = this.sessions.get(sessionId);
    let current = session.delivery;
    if (!current || !/^[a-f0-9]{40}$/i.test(expectedHeadSha) ||
        !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
      throw new ConflictException('GITHUB_MERGE_REQUEST_INVALID');
    }
    if (current.state === 'merged' && current.mergeOperationKey === idempotencyKey &&
        current.mergeExpectedHeadSha === expectedHeadSha) return current;
    if (current.version !== expectedVersion &&
        !(current.state === 'blocked' && current.mergeOperationKey === idempotencyKey &&
          current.mergeExpectedHeadSha === expectedHeadSha)) {
      throw new ConflictException('GITHUB_MERGE_VERSION_CONFLICT');
    }
    if (session.sourceBinding?.executionLocation === 'local' &&
        (!session.sourceBinding.deviceId || !session.sourceBinding.workspaceId ||
         !this.localRuntime?.isGitHubDeviceReady(session.sourceBinding.deviceId,
           session.sourceBinding.workspaceId))) {
      throw new ConflictException('GITHUB_LOCAL_RUNTIME_OFFLINE');
    }
    if (!current.pullRequestNumber || current.commitSha !== expectedHeadSha ||
        !['merge_ready', 'awaiting_ci', 'blocked'].includes(current.state) ||
        current.state === 'blocked' && current.mergeOperationKey !== idempotencyKey) {
      throw new ConflictException('GITHUB_MERGE_NOT_READY');
    }
    const remote = await this.remoteStatus(sessionId, current);
    if (remote.pullRequestState === 'closed' && remote.mergedCommitSha) {
      const merged = this.sessions.updateDeliveryRecord(sessionId, current.version, {
        ...current, state: 'merged', version: current.version + 1,
        mergeOperationKey: idempotencyKey, mergeExpectedHeadSha: expectedHeadSha,
        mergedCommitSha: remote.mergedCommitSha, updatedAt: new Date().toISOString()
      });
      this.notifyMerged(sessionId, merged);
      return merged;
    }
    if (remote.pullRequestHeadSha !== expectedHeadSha) {
      throw new ConflictException('GITHUB_PULL_HEAD_CHANGED');
    }
    if (remote.pullRequestState !== 'open' || remote.mergeable !== true ||
        !['passed', 'not_configured'].includes(remote.ciStatus ?? '')) {
      if (remote.mergeable === false && remote.pullRequestState === 'open') {
        const started = await this.startRemoteConflict(sessionId, current);
        if (started.view) {
          const resolving = this.sessions.updateDeliveryRecord(sessionId, current.version, {
            ...current, state: 'resolving_conflict', version: current.version + 1,
            conflictId: started.view.id,
            conflictPaths: started.view.files.map((file) => file.path),
            errorCode: 'GITHUB_PULL_CONFLICT', updatedAt: new Date().toISOString()
          });
          this.events.createOnce(`github-conflict:${sessionId}:${resolving.round}:${started.view.id}`, {
            sessionId, type: 'runtime_progress',
            content: `PR #${resolving.pullRequestNumber} 有 ${started.view.files.length} 个冲突文件。`,
            metadata: createMetadata('system_notice', { code: 'GITHUB_PULL_CONFLICT',
              deliveryRound: resolving.round, conflictId: started.view.id,
              conflictFileCount: started.view.files.length })
          });
          return resolving;
        }
        if (started.treeSha) {
          const ready = this.sessions.updateDeliveryRecord(sessionId, current.version, {
            ...current, state: 'awaiting_validation_input', version: current.version + 1,
            candidateTreeSha: started.treeSha, validation: undefined,
            updatedAt: new Date().toISOString()
          });
          return this.validateUnlocked(sessionId, ready.version, ready.validationCommand);
        }
      }
      return this.sessions.updateDeliveryRecord(sessionId, current.version, {
        ...current, state: 'awaiting_ci', version: current.version + 1,
        ciStatus: remote.ciStatus, mergeable: remote.mergeable,
        errorCode: undefined,
        updatedAt: new Date().toISOString()
      });
    }
    current = this.sessions.updateDeliveryRecord(sessionId, current.version, {
      ...current, state: 'merging', version: current.version + 1,
      mergeOperationKey: idempotencyKey, mergeExpectedHeadSha: expectedHeadSha,
      updatedAt: new Date().toISOString()
    });
    try {
      const mergedCommitSha = await this.remoteMerge(sessionId, current, expectedHeadSha);
      const merged = this.sessions.updateDeliveryRecord(sessionId, current.version, {
        ...current, state: 'merged', version: current.version + 1,
        mergedCommitSha, errorCode: undefined, updatedAt: new Date().toISOString()
      });
      this.notifyMerged(sessionId, merged);
      return merged;
    } catch (error) {
      const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'GITHUB_MERGE_FAILED';
      return this.sessions.updateDeliveryRecord(sessionId, current.version, {
        ...current, state: 'blocked', version: current.version + 1,
        errorCode: code, updatedAt: new Date().toISOString()
      });
    }
  }

  private notifyMerged(sessionId: string, merged: DeliveryRecord): void {
    this.events.createOnce(`github-merged:${sessionId}:${merged.round}:${merged.mergedCommitSha}`, {
      sessionId, type: 'runtime_progress', content: `PR #${merged.pullRequestNumber} 已合并。`,
      metadata: createMetadata('system_notice', { code: 'GITHUB_PULL_REQUEST_MERGED',
        deliveryRound: merged.round, pullRequestNumber: merged.pullRequestNumber,
        mergedCommitSha: merged.mergedCommitSha })
    });
  }

  private async startRemoteConflict(sessionId: string, record: DeliveryRecord): Promise<{
    view?: ConflictView; treeSha?: string
  }> {
    const binding = this.sessions.get(sessionId).sourceBinding!;
    if (!binding.authorizationRef || !record.commitSha) {
      throw new Error('GITHUB_CONFLICT_NOT_READY');
    }
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId || !this.localRuntime) throw new Error('GITHUB_LOCAL_RUNTIME_UNAVAILABLE');
      const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
        action: 'start_conflict', sessionId, authorizationId: binding.authorizationRef,
        repositoryUrl: binding.repositoryUrl, round: record.round,
        headSha: record.commitSha, baseBranch: record.baseBranch
      });
      if (result.outcome === 'conflict_view' && result.conflictView) {
        return { view: result.conflictView };
      }
      if (result.outcome === 'conflict_complete' && result.treeSha) {
        return { treeSha: result.treeSha };
      }
      throw new Error('GITHUB_CONFLICT_RESPONSE_INVALID');
    }
    if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return this.authorizations.withServerToken(binding.authorizationRef,
      binding.repositoryUrl, (token) => this.conflicts.start({ sessionId,
        round: record.round, headSha: record.commitSha!,
        baseBranch: record.baseBranch, token, targetOperation: 'merge_pull_request' }));
  }

  private async remoteStatus(sessionId: string, record: DeliveryRecord): Promise<RemotePullStatus> {
    const binding = this.sessions.get(sessionId).sourceBinding!;
    if (!binding.authorizationRef || !record.pullRequestNumber) {
      throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    }
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId || !this.localRuntime) throw new Error('GITHUB_LOCAL_RUNTIME_UNAVAILABLE');
      const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
        action: 'status', sessionId, authorizationId: binding.authorizationRef,
        repositoryUrl: binding.repositoryUrl, pullRequestNumber: record.pullRequestNumber
      });
      if (result.outcome !== 'status' || !result.pullRequestNumber ||
          !result.pullRequestUrl || !result.pullRequestHeadSha || !result.pullRequestState) {
        throw new Error('GITHUB_PULL_STATUS_INVALID');
      }
      return { pullRequestNumber: result.pullRequestNumber,
        pullRequestUrl: result.pullRequestUrl, pullRequestHeadSha: result.pullRequestHeadSha,
        pullRequestState: result.pullRequestState, mergeable: result.mergeable ?? null,
        mergedCommitSha: result.mergedCommitSha, ciStatus: result.ciStatus };
    }
    if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return this.authorizations.withServerToken(binding.authorizationRef,
      binding.repositoryUrl, async (token) => {
        const pull = await this.pulls.get(token, binding.repositoryUrl, record.pullRequestNumber!);
        const ciStatus = pull.state === 'open' && !pull.merged
          ? await this.pulls.ciStatus(token, binding.repositoryUrl, pull.headSha) : undefined;
        return { pullRequestNumber: pull.number, pullRequestUrl: pull.url,
          pullRequestHeadSha: pull.headSha, pullRequestState: pull.state,
          mergeable: pull.mergeable, mergedCommitSha: pull.merged ? pull.mergeCommitSha : undefined,
          ciStatus };
      });
  }

  private async remoteMerge(sessionId: string, record: DeliveryRecord,
    expectedHeadSha: string): Promise<string> {
    const binding = this.sessions.get(sessionId).sourceBinding!;
    if (!binding.authorizationRef || !record.pullRequestNumber) {
      throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    }
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId || !this.localRuntime) throw new Error('GITHUB_LOCAL_RUNTIME_UNAVAILABLE');
      const result = await this.localRuntime.requestGitHubDelivery(binding.deviceId, {
        action: 'merge', sessionId, authorizationId: binding.authorizationRef,
        repositoryUrl: binding.repositoryUrl, pullRequestNumber: record.pullRequestNumber,
        expectedHeadSha
      });
      if (result.outcome !== 'merged' || !result.mergedCommitSha) {
        throw new Error('GITHUB_MERGE_RESPONSE_INVALID');
      }
      return result.mergedCommitSha;
    }
    if (!this.authorizations) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return this.authorizations.withServerToken(binding.authorizationRef,
      binding.repositoryUrl, (token) => this.pulls.squashMerge(token, binding.repositoryUrl,
        record.pullRequestNumber!, expectedHeadSha));
  }

  private async validateLocal(sessionId: string, deviceId: string | undefined, baseSha: string,
    record: DeliveryRecord, command?: RepositoryValidationCommand): Promise<ValidationOutcome> {
    if (!deviceId || !this.localRuntime) throw new Error('GITHUB_LOCAL_RUNTIME_UNAVAILABLE');
    const action = record.candidateTreeSha
      ? { action: 'validate' as const, sessionId, treeSha: record.candidateTreeSha,
          comparisonSha: record.publishParentSha ?? record.commitSha ?? baseSha,
          ...(command ? { command } : {}) }
      : { action: 'integrate_validate' as const, sessionId, baseSha,
          round: record.round, candidates: record.candidates!, ...(command ? { command } : {}) };
    return await this.localRuntime.requestGitHubDelivery(deviceId, action) as ValidationOutcome;
  }

  private async validateServer(sessionId: string, baseSha: string, record: DeliveryRecord,
    command?: RepositoryValidationCommand): Promise<ValidationOutcome> {
    const path = await this.workspaces.prepareDelivery(sessionId, baseSha,
      !record.candidateTreeSha, Boolean(record.publishParentSha ||
        record.commitSha && record.candidateTreeSha));
    let treeSha = record.candidateTreeSha;
    let changedPaths = record.changedPaths;
    if (!treeSha) {
      const integrated = await integrateGitTaskCandidates({ worktreePath: path,
        sessionId, baseCommit: baseSha, candidates: record.candidates! });
      if (integrated.conflicts.length) {
        const conflictView = await this.conflicts.captureExisting(sessionId, record.round,
          'integrate_task_branch');
        return { outcome: 'conflict', conflicts: integrated.conflicts, conflictView };
      }
      treeSha = integrated.treeSha;
      changedPaths = integrated.changedPaths;
    } else if (await this.git.run(path, ['write-tree']) !== treeSha) {
      throw new Error('GITHUB_VALIDATION_CANDIDATE_CHANGED');
    } else {
      changedPaths = await changedGitPaths(path,
        record.publishParentSha ?? record.commitSha ?? baseSha, treeSha, this.git);
    }
    if (!changedPaths?.length) return { outcome: 'no_changes', treeSha, changedPaths: [] };
    const selected = command ?? await detectRepositoryValidation(path);
    if (!selected) return { outcome: 'needs_input', treeSha, changedPaths };
    const validation = await runRepositoryValidation({ root: path, candidateSha: treeSha!,
      command: selected });
    return { outcome: 'validated', treeSha, changedPaths, validation, command: selected };
  }
}
