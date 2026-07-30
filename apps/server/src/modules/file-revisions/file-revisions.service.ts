import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  FILE_REVISION_MAX_BYTES,
  type ActorRef,
  type ApplyChangeSetResult,
  type CaptureFileRevisionBaselineInput,
  type CreateFileRevisionRunInput,
  type DecideFileRevisionInput,
  type FileHash,
  type FileRevisionAgentResult,
  type FileRevisionBaseline,
  type FileRevisionCandidate,
  type FileRevisionChain,
  type FileRevisionEditorDraft,
  type FileRevisionEditorDraftContent,
  type FileRevisionEvidence,
  type FileRevisionRun,
  type FileRevisionState,
  type ReprocessFileRevisionInput,
  type ReadFileResult,
  type ResolveFileRevisionFailureInput,
  type RetryInterruptedFileRevisionInput,
  type SaveFileRevisionDraftInput,
  type SessionDetail,
  type WorkspaceChangeSet
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { createFileRevisionDiff } from './file-revision-diff.js';

const COLLECTION_KEY = 'fileRevisions';

type PersistedFileRevisions = FileRevisionState & { schemaVersion?: 2 };
type MutableRevisionState = {
  baselines: Map<string, FileRevisionBaseline>;
  chains: Map<string, FileRevisionChain>;
  runs: Map<string, FileRevisionRun>;
  drafts: Map<string, FileRevisionEditorDraft>;
};

export type ApplyFileRevisionResult = {
  run: FileRevisionRun;
  chain: FileRevisionChain;
  result: ApplyChangeSetResult;
  changeSet: WorkspaceChangeSet;
  applied: boolean;
  baseline?: FileRevisionBaseline;
  persistenceRecoveryRequired?: boolean;
  postApplyBaselineError?: string;
};

@Injectable()
export class FileRevisionsService {
  private readonly logger = new Logger(FileRevisionsService.name);
  private baselines = new Map<string, FileRevisionBaseline>();
  private chains = new Map<string, FileRevisionChain>();
  private runs = new Map<string, FileRevisionRun>();
  private drafts = new Map<string, FileRevisionEditorDraft>();
  private mutationTail = Promise.resolve();
  private readonly chainTails = new Map<string, Promise<void>>();
  private persistedSnapshot: PersistedFileRevisions;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly contentStore: LocalContentStore,
    private readonly workspaceProviders: WorkspaceProviderResolver
  ) {
    const persisted = this.persistence.getCollection<Partial<PersistedFileRevisions>>(COLLECTION_KEY, {});
    const dataEpoch = this.persistence.currentDataEpoch();
    for (const baseline of persisted.baselines ?? []) {
      assertCurrentDataEpoch(dataEpoch, baseline.dataEpoch, `FileRevisionBaseline ${baseline.id}`);
      this.baselines.set(baseline.id, baseline);
    }
    for (const chain of persisted.chains ?? []) {
      assertCurrentDataEpoch(dataEpoch, chain.dataEpoch, `FileRevisionChain ${chain.id}`);
      this.chains.set(chain.id, chain);
    }
    for (const persistedRun of persisted.runs ?? []) {
      assertCurrentDataEpoch(dataEpoch, persistedRun.dataEpoch, `FileRevisionRun ${persistedRun.id}`);
      const run = 'chainId' in persistedRun
        ? persistedRun
        : this.migrateLegacyRun(persistedRun as unknown as Record<string, unknown>);
      this.runs.set(run.id, run);
      if (!this.chains.has(run.chainId)) {
        this.chains.set(
          run.chainId,
          this.chainForMigratedRun(
            run,
            (persistedRun as unknown as { revisedRevision?: FileRevisionChain['workspaceExpectedRevision'] }).revisedRevision
          )
        );
      }
    }
    for (const draft of persisted.drafts ?? []) this.drafts.set(draft.chainId, draft);
    this.persistedSnapshot = this.serializedState({
      baselines: this.baselines,
      chains: this.chains,
      runs: this.runs,
      drafts: this.drafts
    });
  }

  state(sessionId: string): FileRevisionState {
    return {
      baselines: this.listBaselines(sessionId),
      chains: this.listChains(sessionId),
      runs: this.listRuns(sessionId),
      drafts: this.listDrafts(sessionId)
    };
  }

  listBaselines(sessionId: string) {
    return [...this.baselines.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  }

  listChains(sessionId: string) {
    return [...this.chains.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listRuns(sessionId: string) {
    return [...this.runs.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listDrafts(sessionId: string) {
    const chainIds = new Set(this.listChains(sessionId).map((chain) => chain.id));
    return [...this.drafts.values()].filter((draft) => chainIds.has(draft.chainId));
  }

  getBaseline(sessionId: string, baselineId: string) {
    const baseline = this.baselines.get(baselineId);
    if (!baseline || baseline.sessionId !== sessionId) {
      throw new NotFoundException(`File revision baseline not found: ${baselineId}`);
    }
    return baseline;
  }

  getChain(sessionId: string, chainId: string) {
    const chain = this.chains.get(chainId);
    if (!chain || chain.sessionId !== sessionId) {
      throw new NotFoundException(`File revision chain not found: ${chainId}`);
    }
    return chain;
  }

  getRun(sessionId: string, revisionId: string) {
    const run = this.runs.get(revisionId);
    if (!run || run.sessionId !== sessionId) {
      throw new NotFoundException(`File revision run not found: ${revisionId}`);
    }
    return run;
  }

  getCandidate(sessionId: string, revisionId: string): FileRevisionCandidate {
    const run = this.getRun(sessionId, revisionId);
    const chain = this.getChain(sessionId, run.chainId);
    if (!run.candidateContentRef || !run.candidateHash || run.candidateSizeBytes === undefined) {
      throw new NotFoundException(`File revision candidate not found: ${revisionId}`);
    }
    const content = this.contentStore.read(run.candidateContentRef).toString('utf8');
    this.assertHash(run.candidateHash, sha256(content), 'REVISION_CANDIDATE_MISMATCH');
    return {
      revisionId: run.id,
      chainId: run.chainId,
      iteration: run.iteration,
      candidateHash: run.candidateHash,
      content,
      sizeBytes: run.candidateSizeBytes,
      status: run.status,
      stateVersion: chain.stateVersion
    };
  }

  getDraft(sessionId: string, revisionId: string): FileRevisionEditorDraftContent | null {
    const run = this.getRun(sessionId, revisionId);
    const draft = this.drafts.get(run.chainId);
    if (!draft || draft.sourceRevisionId !== run.id) {
      return null;
    }
    return { ...draft, content: this.contentStore.read(draft.contentRef).toString('utf8') };
  }

  async captureBaseline(
    session: SessionDetail,
    input: CaptureFileRevisionBaselineInput
  ): Promise<FileRevisionBaseline> {
    const provider = this.requireProvider(session);
    const filePath = input.filePath?.trim();
    if (!filePath) throw new BadRequestException('File path is required.');
    const file = await provider.readFile({ path: filePath, maxBytes: FILE_REVISION_MAX_BYTES });
    this.assertCompleteText(file.content, file.truncated, file.byteLength);
    const fileHash = this.requireFullFileHash(file.hash);
    const stored = this.contentStore.put(file.content, 'text/plain; charset=utf-8', filePath);
    const baseline: FileRevisionBaseline = {
      id: crypto.randomUUID(),
      dataEpoch: session.dataEpoch,
      sessionId: session.id,
      workspaceId: session.workingDirectory?.id ?? session.workspaceId,
      filePath: file.path,
      workspaceRevision: file.revision,
      hash: fileHash,
      contentRef: stored.contentRef,
      sizeBytes: file.byteLength,
      source: input.source ?? 'user_selected',
      capturedAt: nowIso()
    };
    return this.mutate((state) => {
      state.baselines.set(baseline.id, baseline);
      return baseline;
    });
  }

  async createRun(session: SessionDetail, input: CreateFileRevisionRunInput): Promise<FileRevisionRun> {
    const baseline = this.getBaseline(session.id, input.baselineId);
    const targetAgentIds = this.normalizeAgentIds(input.targetAgentIds);
    const instruction = this.normalizeInstruction(input.instruction);
    const provider = this.requireProvider(session);
    const userDraft = await provider.readFile({ path: baseline.filePath, maxBytes: FILE_REVISION_MAX_BYTES });
    this.assertCompleteText(userDraft.content, userDraft.truncated, userDraft.byteLength);
    const userDraftHash = this.requireFullFileHash(userDraft.hash);
    if (sameHash(userDraftHash, baseline.hash)) {
      throw new BadRequestException('REVISION_NO_CHANGES: the file still matches the captured baseline.');
    }
    const baseContent = this.contentStore.read(baseline.contentRef).toString('utf8');
    const frozen = this.freezeIteration(baseContent, baseline.hash, userDraft.content, userDraftHash, userDraft.path);
    const timestamp = nowIso();
    const chainId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const chain: FileRevisionChain = {
      id: chainId,
      dataEpoch: session.dataEpoch,
      sessionId: session.id,
      workspaceId: baseline.workspaceId,
      filePath: userDraft.path,
      rootBaselineId: baseline.id,
      workspaceExpectedRevision: userDraft.revision,
      workspaceExpectedHash: userDraftHash,
      latestRevisionId: revisionId,
      latestIteration: 1,
      stateVersion: 1,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const run: FileRevisionRun = {
      id: revisionId,
      chainId,
      dataEpoch: session.dataEpoch,
      sessionId: session.id,
      baselineId: baseline.id,
      workspaceId: baseline.workspaceId,
      filePath: userDraft.path,
      iteration: 1,
      status: 'submitted',
      baseKind: 'workspace_baseline',
      baseHash: baseline.hash,
      baseContentRef: baseline.contentRef,
      baseSizeBytes: baseline.sizeBytes,
      userDraftHash,
      userDraftContentRef: frozen.userDraftContentRef,
      userDraftSizeBytes: userDraft.byteLength,
      diffContentRef: frozen.diffContentRef,
      diffHash: frozen.diffHash,
      diffSummary: frozen.diffSummary,
      targetAgentIds,
      ...(instruction ? { instruction } : {}),
      contextSnapshotHash: this.contextSnapshotHash({
        chainId,
        revisionId,
        iteration: 1,
        baseHash: baseline.hash,
        userDraftHash,
        diffHash: frozen.diffHash
      }),
      agentResults: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const created = await this.mutate((state) => {
      state.chains.set(chain.id, chain);
      state.runs.set(run.id, run);
      return run;
    });
    workspaceMetrics.increment('file_revision_chain_total');
    workspaceMetrics.increment('file_revision_iteration_total', 1, { baseKind: run.baseKind });
    this.logTransition('iteration_created', created, this.getChain(session.id, created.chainId));
    return created;
  }

  evidence(sessionId: string, revisionId: string): FileRevisionEvidence {
    const run = this.getRun(sessionId, revisionId);
    const base = this.contentStore.read(run.baseContentRef).toString('utf8');
    const userDraft = this.contentStore.read(run.userDraftContentRef).toString('utf8');
    const hunks = JSON.parse(this.contentStore.read(run.diffContentRef).toString('utf8')) as FileRevisionEvidence['diff']['hunks'];
    this.assertHash(run.baseHash, sha256(base), 'REVISION_CONTEXT_INCOMPLETE');
    this.assertHash(run.userDraftHash, sha256(userDraft), 'REVISION_CONTEXT_INCOMPLETE');
    this.assertHash(run.diffHash, sha256(JSON.stringify(hunks)), 'REVISION_CONTEXT_INCOMPLETE');
    return {
      chainId: run.chainId,
      revisionId: run.id,
      iteration: run.iteration,
      filePath: run.filePath,
      baseKind: run.baseKind,
      base: {
        hash: run.baseHash,
        contentRef: run.baseContentRef,
        content: base,
        byteLength: Buffer.byteLength(base, 'utf8')
      },
      userDraft: {
        hash: run.userDraftHash,
        contentRef: run.userDraftContentRef,
        content: userDraft,
        byteLength: Buffer.byteLength(userDraft, 'utf8')
      },
      diff: {
        hash: run.diffHash,
        contentRef: run.diffContentRef,
        hunks,
        summary: run.diffSummary
      },
      evidenceHash: run.contextSnapshotHash,
      agentResults: run.agentResults.map((result) => ({
        ...result,
        ...(result.proposedContentRef
          ? { proposedContent: this.contentStore.read(result.proposedContentRef).toString('utf8') }
          : {})
      })),
      complete: true,
      truncated: false
    };
  }

  async saveDraft(
    sessionId: string,
    revisionId: string,
    input: SaveFileRevisionDraftInput,
    updatedBy: ActorRef
  ): Promise<FileRevisionEditorDraft> {
    this.assertCompleteText(input.content, false, Buffer.byteLength(input.content, 'utf8'));
    return this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      this.assertEditableHead(run, chain);
      this.assertHash(run.candidateHash, input.expectedCandidateHash, 'REVISION_CANDIDATE_MISMATCH');
      const stored = this.contentStore.put(input.content, 'text/plain; charset=utf-8', run.filePath);
      const draft: FileRevisionEditorDraft = {
        chainId: chain.id,
        sourceRevisionId: run.id,
        sourceCandidateHash: input.expectedCandidateHash,
        contentRef: stored.contentRef,
        contentHash: { algorithm: 'sha256', value: stored.sha256 },
        sizeBytes: stored.sizeBytes,
        updatedBy,
        updatedAt: nowIso()
      };
      state.drafts.set(chain.id, draft);
      return draft;
    });
  }

  async reprocess(
    sessionId: string,
    revisionId: string,
    input: ReprocessFileRevisionInput
  ): Promise<FileRevisionRun> {
    const current = this.getRun(sessionId, revisionId);
    const currentChain = this.getChain(sessionId, current.chainId);
    const targetAgentIds = input.targetAgentIds === undefined
      ? [...current.targetAgentIds]
      : this.normalizeAgentIds(input.targetAgentIds);
    const instruction = input.instruction === undefined
      ? current.instruction
      : this.normalizeInstruction(input.instruction);
    const reprocessKey = this.reprocessKey({
      chainId: currentChain.id,
      parentRevisionId: current.id,
      expectedCandidateHash: input.expectedCandidateHash,
      draftHash: input.draftHash,
      targetAgentIds,
      instruction
    });
    let result: { run: FileRevisionRun; created: boolean };
    try {
      result = await this.withChainLock(current.chainId, () => this.mutate((state) => {
      const parent = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, parent.chainId);
      const existing = [...state.runs.values()].find(
        (candidate) => candidate.parentRevisionId === parent.id && candidate.reprocessKey === reprocessKey
      );
      if (existing) return { run: existing, created: false };

      this.assertEditableHead(parent, chain);
      this.assertStateVersion(chain, input.expectedStateVersion);
      this.assertHash(parent.candidateHash, input.expectedCandidateHash, 'REVISION_CANDIDATE_MISMATCH');
      const draft = state.drafts.get(chain.id);
      if (!draft || draft.sourceRevisionId !== parent.id || !sameHash(draft.sourceCandidateHash, input.expectedCandidateHash)) {
        throw new ConflictException('REVISION_DRAFT_MISMATCH: saved draft does not belong to this candidate.');
      }
      this.assertHash(draft.contentHash, input.draftHash, 'REVISION_DRAFT_MISMATCH');
      if (sameHash(draft.contentHash, parent.candidateHash!)) {
        throw new BadRequestException('REVISION_NO_CHANGES: the draft still matches the generated candidate.');
      }
      const candidateContent = this.contentStore.read(parent.candidateContentRef!).toString('utf8');
      const draftContent = this.contentStore.read(draft.contentRef).toString('utf8');
      const frozen = this.freezeIteration(
        candidateContent,
        parent.candidateHash!,
        draftContent,
        draft.contentHash,
        parent.filePath
      );
      const timestamp = nowIso();
      const id = crypto.randomUUID();
      const iteration = parent.iteration + 1;
      const next: FileRevisionRun = {
        id,
        chainId: chain.id,
        dataEpoch: parent.dataEpoch,
        sessionId,
        baselineId: parent.baselineId,
        workspaceId: parent.workspaceId,
        filePath: parent.filePath,
        iteration,
        parentRevisionId: parent.id,
        reprocessKey,
        status: 'submitted',
        baseKind: 'previous_candidate',
        baseHash: parent.candidateHash!,
        baseContentRef: parent.candidateContentRef!,
        baseSizeBytes: parent.candidateSizeBytes!,
        userDraftHash: draft.contentHash,
        userDraftContentRef: draft.contentRef,
        userDraftSizeBytes: draft.sizeBytes,
        diffContentRef: frozen.diffContentRef,
        diffHash: frozen.diffHash,
        diffSummary: frozen.diffSummary,
        targetAgentIds,
        ...(instruction ? { instruction } : {}),
        contextSnapshotHash: this.contextSnapshotHash({
          chainId: chain.id,
          revisionId: id,
          iteration,
          baseHash: parent.candidateHash!,
          userDraftHash: draft.contentHash,
          diffHash: frozen.diffHash
        }),
        agentResults: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.runs.set(parent.id, { ...parent, status: 'superseded', updatedAt: timestamp, completedAt: timestamp });
      state.runs.set(next.id, next);
      state.chains.set(chain.id, {
        ...chain,
        latestRevisionId: next.id,
        latestIteration: iteration,
        stateVersion: chain.stateVersion + 1,
        updatedAt: timestamp
      });
      state.drafts.delete(chain.id);
      return { run: next, created: true };
      }));
    } catch (error) {
      const winner = [...this.runs.values()].find(
        (candidate) => candidate.parentRevisionId === revisionId && candidate.reprocessKey === reprocessKey
      );
      if (!winner || !(error instanceof ConflictException) || !String(error.message).includes('REVISION_PERSISTENCE_CONFLICT')) {
        throw error;
      }
      result = { run: winner, created: false };
    }
    if (result.created) {
      workspaceMetrics.increment('file_revision_iteration_total', 1, { baseKind: result.run.baseKind });
      this.logTransition('iteration_reprocessed', result.run, this.getChain(sessionId, result.run.chainId));
    }
    return result.run;
  }

  async markProcessing(sessionId: string, revisionId: string) {
    return this.transitionRun(sessionId, revisionId, ['submitted', 'interrupted'], 'processing');
  }

  async markSynthesizing(sessionId: string, revisionId: string) {
    return this.transitionRun(sessionId, revisionId, ['processing'], 'synthesizing');
  }

  async recordAgentResult(sessionId: string, revisionId: string, result: FileRevisionAgentResult) {
    return this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      if (run.status !== 'processing') {
        throw new ConflictException(`REVISION_STATE_CONFLICT: cannot record Agent result while ${run.status}.`);
      }
      const results = run.agentResults.filter((item) => item.id !== result.id && item.taskId !== result.taskId);
      results.push(result);
      const next = { ...run, agentResults: results, updatedAt: nowIso() };
      state.runs.set(run.id, next);
      return next;
    });
  }

  storeProposedContent(content: string, filePath: string) {
    this.assertCompleteText(content, false, Buffer.byteLength(content, 'utf8'));
    return this.contentStore.put(content, 'text/plain; charset=utf-8', filePath).contentRef;
  }

  async markAwaitingConfirmation(
    sessionId: string,
    revisionId: string,
    input: {
      candidateContent: string;
      confirmationId: string;
      receiverInvocationId: string;
      synthesisTaskId: string;
    }
  ) {
    this.assertCompleteText(input.candidateContent, false, Buffer.byteLength(input.candidateContent, 'utf8'));
    const candidate = this.contentStore.put(input.candidateContent, 'text/plain; charset=utf-8');
    const published = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      if (run.status !== 'synthesizing' || chain.latestRevisionId !== run.id || chain.status !== 'active') {
        throw new ConflictException(`REVISION_STATE_CONFLICT: cannot publish candidate while ${run.status}.`);
      }
      const timestamp = nowIso();
      const next: FileRevisionRun = {
        ...run,
        status: 'awaiting_confirmation',
        candidateChangeSetId: crypto.randomUUID(),
        candidateContentRef: candidate.contentRef,
        candidateHash: { algorithm: 'sha256', value: candidate.sha256 },
        candidateSizeBytes: candidate.sizeBytes,
        confirmationId: input.confirmationId,
        receiverInvocationId: input.receiverInvocationId,
        synthesisTaskId: input.synthesisTaskId,
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: timestamp
      };
      state.runs.set(run.id, next);
      state.chains.set(chain.id, { ...chain, stateVersion: chain.stateVersion + 1, updatedAt: timestamp });
      return next;
    });
    workspaceMetrics.observe(
      'file_revision_iteration_duration_ms',
      Date.now() - Date.parse(published.createdAt),
      { outcome: 'candidate' }
    );
    this.logTransition('candidate_published', published, this.getChain(sessionId, published.chainId));
    return published;
  }

  async markFailed(sessionId: string, revisionId: string, errorCode: string, errorMessage?: string) {
    const failed = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      if (isTerminal(run.status)) return run;
      const timestamp = nowIso();
      const next = {
        ...run,
        status: 'failed' as const,
        errorCode,
        errorMessage: errorMessage ?? errorCode,
        updatedAt: timestamp,
        completedAt: timestamp
      };
      state.runs.set(run.id, next);
      if (chain.latestRevisionId === run.id) {
        state.chains.set(chain.id, {
          ...chain,
          status: 'failed',
          stateVersion: chain.stateVersion + 1,
          updatedAt: timestamp,
          completedAt: timestamp
        });
      }
      return next;
    });
    this.logTransition('iteration_failed', failed, this.getChain(sessionId, failed.chainId), { errorCode });
    return failed;
  }

  async resolvePartialFailure(
    sessionId: string,
    revisionId: string,
    input: ResolveFileRevisionFailureInput
  ) {
    const initial = this.getRun(sessionId, revisionId);
    const resolved = await this.withChainLock(initial.chainId, () => this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      if (
        run.status !== 'failed' ||
        run.errorCode !== 'REVISION_PARTIAL_AGENT_FAILURE' ||
        chain.latestRevisionId !== run.id ||
        chain.status !== 'failed'
      ) {
        throw new ConflictException('REVISION_STATE_CONFLICT: this revision is not awaiting a partial-failure decision.');
      }
      this.assertStateVersion(chain, input.expectedStateVersion);
      const timestamp = nowIso();
      if (input.decision === 'abandon_revision') {
        const nextRun: FileRevisionRun = {
          ...run,
          status: 'abandoned',
          updatedAt: timestamp,
          completedAt: timestamp
        };
        const nextChain: FileRevisionChain = {
          ...chain,
          status: 'abandoned',
          stateVersion: chain.stateVersion + 1,
          updatedAt: timestamp,
          completedAt: timestamp
        };
        state.runs.set(run.id, nextRun);
        state.chains.set(chain.id, nextChain);
        state.drafts.delete(chain.id);
        return { run: nextRun, chain: nextChain, decision: input.decision };
      }

      const completedResults = run.agentResults.filter((result) => result.status === 'completed');
      if (input.decision === 'continue_with_successful' && completedResults.length === 0) {
        throw new BadRequestException(
          'REVISION_PARTIAL_AGENT_FAILURE: no successful Agent result is available for Receiver synthesis.'
        );
      }
      const instruction = input.instruction === undefined
        ? run.instruction
        : this.normalizeInstruction(input.instruction);
      const nextRun: FileRevisionRun = {
        ...run,
        status: input.decision === 'retry_agents' ? 'submitted' : 'processing',
        agentResults: input.decision === 'retry_agents' ? [] : run.agentResults,
        ...(instruction ? { instruction } : { instruction: undefined }),
        errorCode: undefined,
        errorMessage: undefined,
        completedAt: undefined,
        updatedAt: timestamp
      };
      const nextChain: FileRevisionChain = {
        ...chain,
        status: 'active',
        stateVersion: chain.stateVersion + 1,
        completedAt: undefined,
        updatedAt: timestamp
      };
      state.runs.set(run.id, nextRun);
      state.chains.set(chain.id, nextChain);
      return { run: nextRun, chain: nextChain, decision: input.decision };
    }));
    this.logTransition('partial_failure_resolved', resolved.run, resolved.chain, { decision: resolved.decision });
    return resolved;
  }

  async abandon(sessionId: string, revisionId: string, input: DecideFileRevisionInput) {
    const run = this.getRun(sessionId, revisionId);
    const abandoned = await this.withChainLock(run.chainId, () => this.mutate((state) => {
      const current = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, current.chainId);
      this.assertDecisionTarget(current, chain, input);
      const timestamp = nowIso();
      const next = { ...current, status: 'abandoned' as const, updatedAt: timestamp, completedAt: timestamp };
      state.runs.set(current.id, next);
      const nextChain: FileRevisionChain = {
        ...chain,
        status: 'abandoned',
        stateVersion: chain.stateVersion + 1,
        updatedAt: timestamp,
        completedAt: timestamp
      };
      state.chains.set(chain.id, nextChain);
      state.drafts.delete(chain.id);
      return { run: next, chain: nextChain };
    }));
    this.logTransition('revision_abandoned', abandoned.run, abandoned.chain);
    return abandoned.run;
  }

  async retryInterrupted(
    session: SessionDetail,
    revisionId: string,
    input: RetryInterruptedFileRevisionInput
  ) {
    const sessionId = session.id;
    const initial = this.getRun(sessionId, revisionId);
    if (initial.errorCode === 'REVISION_APPLY_OUTCOME_UNKNOWN') {
      const retried = await this.withChainLock(initial.chainId, async () => {
        const run = this.getRun(sessionId, revisionId);
        const chain = this.getChain(sessionId, run.chainId);
        if (
          run.recoveryRetryKey === input.retryKey &&
          run.recoveryRetryMode === 'apply_reconcile' &&
          ['applied', 'awaiting_confirmation', 'stale'].includes(run.status)
        ) {
          return { run, chain, mode: 'apply_reconcile' as const };
        }
        if (run.status !== 'interrupted' || chain.latestRevisionId !== run.id) {
          throw new ConflictException(`REVISION_STATE_CONFLICT: interrupted apply cannot be reconciled while ${run.status}.`);
        }
        this.assertStateVersion(chain, input.expectedStateVersion);
        const provider = this.requireProvider(session);
        const file = await provider.readFile({ path: run.filePath, maxBytes: FILE_REVISION_MAX_BYTES });
        this.assertCompleteText(file.content, file.truncated, file.byteLength);
        const fileHash = this.requireFullFileHash(file.hash);
        const nextStatus = sameHash(fileHash, run.candidateHash!)
          ? 'applied' as const
          : sameHash(fileHash, chain.workspaceExpectedHash)
            ? 'awaiting_confirmation' as const
            : 'stale' as const;
        return this.mutate((state) => {
          const currentRun = this.requireRun(state, sessionId, revisionId);
          const currentChain = this.requireChain(state, sessionId, currentRun.chainId);
          const timestamp = nowIso();
          const nextRun: FileRevisionRun = {
            ...currentRun,
            status: nextStatus,
            recoveryRetryKey: input.retryKey,
            recoveryRetryMode: 'apply_reconcile',
            errorCode: nextStatus === 'stale' ? 'REVISION_WORKSPACE_STALE' : undefined,
            errorMessage: nextStatus === 'stale'
              ? 'Workspace changed while an uncertain apply outcome was reconciled.'
              : undefined,
            updatedAt: timestamp,
            ...(['applied', 'stale'].includes(nextStatus) ? { completedAt: timestamp } : { completedAt: undefined })
          };
          const nextChain: FileRevisionChain = {
            ...currentChain,
            status: nextStatus === 'awaiting_confirmation' ? 'active' : nextStatus,
            stateVersion: currentChain.stateVersion + 1,
            updatedAt: timestamp,
            ...(['applied', 'stale'].includes(nextStatus) ? { completedAt: timestamp } : { completedAt: undefined })
          };
          state.runs.set(currentRun.id, nextRun);
          state.chains.set(currentChain.id, nextChain);
          return { run: nextRun, chain: nextChain, mode: 'apply_reconcile' as const };
        });
      });
      this.logTransition('interrupted_retry', retried.run, retried.chain, { retryMode: retried.mode });
      return retried;
    }
    const retried = await this.withChainLock(initial.chainId, () => this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      if (
        run.recoveryRetryKey === input.retryKey &&
        run.recoveryRetryMode &&
        ['submitted', 'processing'].includes(run.status)
      ) {
        return { run, chain, mode: run.recoveryRetryMode };
      }
      if (run.status !== 'interrupted' || chain.latestRevisionId !== run.id || chain.status !== 'active') {
        throw new ConflictException(`REVISION_STATE_CONFLICT: interrupted revision cannot be retried while ${run.status}.`);
      }
      this.assertStateVersion(chain, input.expectedStateVersion);
      const completedAgentIds = new Set(
        run.agentResults.filter((result) => result.status === 'completed').map((result) => result.agentId)
      );
      const allAgentResultsComplete = run.targetAgentIds.every((agentId) => completedAgentIds.has(agentId));
      const mode = allAgentResultsComplete ? 'receiver_only' as const : 'run_agents' as const;
      const timestamp = nowIso();
      const nextRun: FileRevisionRun = {
        ...run,
        status: mode === 'receiver_only' ? 'processing' : 'submitted',
        agentResults: mode === 'receiver_only' ? run.agentResults : [],
        recoveryRetryKey: input.retryKey,
        recoveryRetryMode: mode,
        errorCode: undefined,
        errorMessage: undefined,
        completedAt: undefined,
        updatedAt: timestamp
      };
      const nextChain: FileRevisionChain = {
        ...chain,
        stateVersion: chain.stateVersion + 1,
        updatedAt: timestamp
      };
      state.runs.set(run.id, nextRun);
      state.chains.set(chain.id, nextChain);
      return { run: nextRun, chain: nextChain, mode };
    }));
    this.logTransition('interrupted_retry', retried.run, retried.chain, { retryMode: retried.mode });
    return retried;
  }

  async applyCandidate(
    session: SessionDetail,
    revisionId: string,
    input: DecideFileRevisionInput
  ): Promise<ApplyFileRevisionResult> {
    const initial = this.getRun(session.id, revisionId);
    return this.withChainLock(initial.chainId, async () => {
      const current = this.getRun(session.id, revisionId);
      const currentChain = this.getChain(session.id, current.chainId);
      if (
        current.status === 'applied' &&
        current.confirmationId === input.confirmationId &&
        current.candidateHash !== undefined &&
        sameHash(current.candidateHash, input.candidateHash)
      ) {
        this.logTransition('apply_replayed', current, currentChain);
        return {
          run: current,
          chain: currentChain,
          result: {
            ok: true,
            changeSetId: current.candidateChangeSetId!,
            revision: currentChain.workspaceExpectedRevision,
            appliedCount: 0
          },
          changeSet: this.changeSetFor(current, currentChain, currentChain.workspaceExpectedRevision),
          applied: true
        };
      }
      const applying = await this.mutate((state) => {
        const run = this.requireRun(state, session.id, revisionId);
        const chain = this.requireChain(state, session.id, run.chainId);
        this.assertDecisionTarget(run, chain, input);
        const timestamp = nowIso();
        const nextRun = { ...run, status: 'applying' as const, updatedAt: timestamp };
        const nextChain = {
          ...chain,
          status: 'applying' as const,
          stateVersion: chain.stateVersion + 1,
          updatedAt: timestamp,
          postApplyBaselineStatus: 'pending' as const
        };
        state.runs.set(run.id, nextRun);
        state.chains.set(chain.id, nextChain);
        return { run: nextRun, chain: nextChain };
      });
      this.logTransition('apply_started', applying.run, applying.chain, { fromStatus: current.status });

      let provider;
      let workspaceFile: ReadFileResult;
      try {
        provider = this.requireProvider(session);
        workspaceFile = await provider.readFile({
          path: applying.run.filePath,
          maxBytes: FILE_REVISION_MAX_BYTES
        });
        this.assertCompleteText(workspaceFile.content, workspaceFile.truncated, workspaceFile.byteLength);
        this.requireFullFileHash(workspaceFile.hash);
      } catch (error) {
        await this.markApplyRetryable(session.id, revisionId, error);
        throw new ConflictException('REVISION_APPLY_RETRYABLE: Workspace could not be validated before writeback.');
      }
      const workspaceHash = this.requireFullFileHash(workspaceFile.hash);
      if (!sameHash(workspaceHash, applying.chain.workspaceExpectedHash)) {
        const stale = await this.markApplyStale(session.id, applying.run.id);
        return {
          ...stale,
          result: {
            ok: false,
            changeSetId: applying.run.candidateChangeSetId!,
            revision: workspaceFile.revision,
            conflicts: [{
              code: 'WORKSPACE_BASE_HASH_MISMATCH',
              message: 'REVISION_WORKSPACE_STALE: Workspace file changed after the revision chain started.',
              changeSetId: applying.run.candidateChangeSetId!,
              operation: 'update',
              path: applying.run.filePath,
              baseHash: applying.chain.workspaceExpectedHash,
              actualHash: workspaceFile.hash,
              actualRevision: workspaceFile.revision
            }]
          },
          changeSet: this.changeSetFor(applying.run, applying.chain, workspaceFile.revision),
          applied: false
        };
      }

      const changeSet = this.changeSetFor(applying.run, applying.chain, workspaceFile.revision);
      let result: ApplyChangeSetResult;
      try {
        result = await provider.applyChangeSet(changeSet);
      } catch (error) {
        let reconciledFile: ReadFileResult;
        let reconciledHash: FileHash;
        try {
          reconciledFile = await provider.readFile({
            path: applying.run.filePath,
            maxBytes: FILE_REVISION_MAX_BYTES
          });
          this.assertCompleteText(reconciledFile.content, reconciledFile.truncated, reconciledFile.byteLength);
          reconciledHash = this.requireFullFileHash(reconciledFile.hash);
        } catch (reconcileError) {
          await this.markApplyInterrupted(session.id, revisionId, error, reconcileError);
          throw new ConflictException('REVISION_APPLY_OUTCOME_UNKNOWN: apply failed and Workspace reconciliation is unavailable.');
        }
        if (sameHash(reconciledHash, applying.run.candidateHash!)) {
          result = {
            ok: true,
            changeSetId: applying.run.candidateChangeSetId!,
            revision: reconciledFile.revision,
            appliedCount: 1
          };
        } else if (sameHash(reconciledHash, applying.chain.workspaceExpectedHash)) {
          await this.markApplyRetryable(session.id, revisionId, error);
          throw new ConflictException(`REVISION_APPLY_RETRYABLE: ${error instanceof Error ? error.message : String(error)}`);
        } else {
          const stale = await this.markApplyStale(session.id, applying.run.id);
          return {
            ...stale,
            result: {
              ok: false,
              changeSetId: applying.run.candidateChangeSetId!,
              revision: reconciledFile.revision,
              conflicts: [{
                code: 'WORKSPACE_BASE_HASH_MISMATCH',
                message: 'REVISION_WORKSPACE_STALE: Workspace changed while apply failure was reconciled.',
                changeSetId: applying.run.candidateChangeSetId!,
                operation: 'update',
                path: applying.run.filePath,
                baseHash: applying.chain.workspaceExpectedHash,
                actualHash: reconciledFile.hash,
                actualRevision: reconciledFile.revision
              }]
            },
            changeSet,
            applied: false
          };
        }
      }
      if (!result.ok) {
        const stale = await this.markApplyStale(session.id, applying.run.id);
        return { ...stale, result, changeSet, applied: false };
      }

      let completed: { run: FileRevisionRun; chain: FileRevisionChain };
      try {
        completed = await this.mutate((state) => {
          const run = this.requireRun(state, session.id, revisionId);
          const chain = this.requireChain(state, session.id, run.chainId);
          const timestamp = nowIso();
          const nextRun = { ...run, status: 'applied' as const, updatedAt: timestamp, completedAt: timestamp };
          const nextChain = {
            ...chain,
            status: 'applied' as const,
            stateVersion: chain.stateVersion + 1,
            updatedAt: timestamp,
            completedAt: timestamp
          };
          state.runs.set(run.id, nextRun);
          state.chains.set(chain.id, nextChain);
          state.drafts.delete(chain.id);
          return { run: nextRun, chain: nextChain };
        });
      } catch (error) {
        const interruptedRun = this.getRun(session.id, revisionId);
        const interruptedChain = this.getChain(session.id, initial.chainId);
        this.logTransition('apply_persistence_interrupted', interruptedRun, interruptedChain);
        return {
          run: interruptedRun,
          chain: interruptedChain,
          result,
          changeSet,
          applied: true,
          persistenceRecoveryRequired: true,
          postApplyBaselineError: 'REVISION_APPLY_PERSISTENCE_RECOVERY_REQUIRED'
        };
      }
      this.logTransition('candidate_applied', completed.run, completed.chain, { fromStatus: applying.run.status });

      try {
        const baseline = await this.captureBaseline(session, { filePath: completed.run.filePath, source: 'post_apply' });
        const updated = await this.mutate((state) => {
          const chain = this.requireChain(state, session.id, completed.chain.id);
          const next = {
            ...chain,
            postApplyBaselineStatus: 'captured' as const,
            postApplyBaselineId: baseline.id,
            postApplyBaselineError: undefined,
            updatedAt: nowIso()
          };
          state.chains.set(chain.id, next);
          return next;
        });
        return { run: completed.run, chain: updated, result, changeSet, applied: true, baseline };
      } catch (error) {
        void error;
        const errorCode = 'REVISION_POST_APPLY_BASELINE_FAILED';
        let chain = completed.chain;
        try {
          chain = await this.mutate((state) => {
            const current = this.requireChain(state, session.id, completed.chain.id);
            const next = {
              ...current,
              postApplyBaselineStatus: 'failed' as const,
              postApplyBaselineError: errorCode,
              updatedAt: nowIso()
            };
            state.chains.set(current.id, next);
            return next;
          });
        } catch {
          // The applied result remains authoritative; recovery reconciles the persisted applying state.
        }
        return {
          run: completed.run,
          chain,
          result,
          changeSet,
          applied: true,
          postApplyBaselineError: errorCode
        };
      }
    });
  }

  async recoverSession(session: SessionDetail) {
    const recoveries: Array<{ revisionId: string; from: string; to: string }> = [];
    for (const chain of this.listChains(session.id)) {
      const run = this.getRun(session.id, chain.latestRevisionId);
      await this.withChainLock(chain.id, async () => {
        if (['submitted', 'processing', 'synthesizing'].includes(run.status)) {
          await this.mutate((state) => {
            const current = this.requireRun(state, session.id, run.id);
            state.runs.set(current.id, {
              ...current,
              status: 'interrupted',
              errorCode: 'REVISION_INTERRUPTED_ON_RESTART',
              errorMessage: 'The previous process stopped before this iteration reached a candidate.',
              updatedAt: nowIso()
            });
          });
          recoveries.push({ revisionId: run.id, from: run.status, to: 'interrupted' });
          return;
        }
        if (run.status !== 'applying' || !run.candidateHash) return;
        let fileHash: FileHash;
        try {
          const provider = this.requireProvider(session);
          const file = await provider.readFile({ path: run.filePath, maxBytes: FILE_REVISION_MAX_BYTES });
          this.assertCompleteText(file.content, file.truncated, file.byteLength);
          fileHash = this.requireFullFileHash(file.hash);
        } catch (error) {
          await this.markApplyInterrupted(
            session.id,
            run.id,
            new Error('The service restarted before writeback completion was recorded.'),
            error
          );
          recoveries.push({ revisionId: run.id, from: 'applying', to: 'interrupted' });
          return;
        }
        const nextStatus = sameHash(fileHash, run.candidateHash)
          ? 'applied'
          : sameHash(fileHash, chain.workspaceExpectedHash)
            ? 'awaiting_confirmation'
            : 'stale';
        await this.mutate((state) => {
          const currentRun = this.requireRun(state, session.id, run.id);
          const currentChain = this.requireChain(state, session.id, chain.id);
          const timestamp = nowIso();
          state.runs.set(run.id, {
            ...currentRun,
            status: nextStatus,
            updatedAt: timestamp,
            ...(['applied', 'stale'].includes(nextStatus) ? { completedAt: timestamp } : {})
          });
          state.chains.set(chain.id, {
            ...currentChain,
            status: nextStatus === 'awaiting_confirmation' ? 'active' : nextStatus,
            stateVersion: currentChain.stateVersion + 1,
            updatedAt: timestamp,
            ...(['applied', 'stale'].includes(nextStatus) ? { completedAt: timestamp } : {})
          });
        });
        recoveries.push({ revisionId: run.id, from: 'applying', to: nextStatus });
      });
    }
    for (const recovery of recoveries) {
      workspaceMetrics.increment('file_revision_recovery_total', 1, {
        from: recovery.from,
        to: recovery.to
      });
      if (recovery.to === 'stale') workspaceMetrics.increment('file_revision_stale_total');
      const recoveredRun = this.getRun(session.id, recovery.revisionId);
      this.logTransition('restart_recovery', recoveredRun, this.getChain(session.id, recoveredRun.chainId), {
        fromStatus: recovery.from as FileRevisionRun['status']
      });
    }
    return recoveries;
  }

  async deleteSession(sessionId: string) {
    const removalCandidates = this.contentRefsForSession(sessionId);
    await this.mutate((state) => {
      const chainIds = new Set([...state.chains.values()].filter((item) => item.sessionId === sessionId).map((item) => item.id));
      for (const item of [...state.baselines.values()]) if (item.sessionId === sessionId) state.baselines.delete(item.id);
      for (const item of [...state.runs.values()]) if (item.sessionId === sessionId) state.runs.delete(item.id);
      for (const id of chainIds) {
        state.chains.delete(id);
        state.drafts.delete(id);
      }
    });
    const retained = this.contentRefsInState();
    this.protectContentReferencedOutsideFileRevisions(
      this.persistence.snapshotState(),
      removalCandidates,
      retained
    );
    for (const contentRef of removalCandidates) {
      if (!retained.has(contentRef)) this.contentStore.remove(contentRef);
    }
  }

  private contentRefsForSession(sessionId: string): Set<string> {
    const chainIds = new Set(
      [...this.chains.values()].filter((chain) => chain.sessionId === sessionId).map((chain) => chain.id)
    );
    return collectRevisionContentRefs(
      [...this.baselines.values()].filter((item) => item.sessionId === sessionId),
      [...this.runs.values()].filter((item) => item.sessionId === sessionId),
      [...this.drafts.values()].filter((item) => chainIds.has(item.chainId))
    );
  }

  private contentRefsInState(): Set<string> {
    return collectRevisionContentRefs(
      [...this.baselines.values()],
      [...this.runs.values()],
      [...this.drafts.values()]
    );
  }

  private protectContentReferencedOutsideFileRevisions(
    value: unknown,
    candidates: Set<string>,
    retained: Set<string>
  ): void {
    if (typeof value === 'string') {
      if (candidates.has(value)) retained.add(value);
      const matchingContentRef = `content:${sha256(value).value}`;
      if (candidates.has(matchingContentRef)) retained.add(matchingContentRef);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.protectContentReferencedOutsideFileRevisions(item, candidates, retained);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value as Record<string, unknown>)) {
      this.protectContentReferencedOutsideFileRevisions(item, candidates, retained);
    }
  }

  private async transitionRun(
    sessionId: string,
    revisionId: string,
    allowed: FileRevisionRun['status'][],
    status: FileRevisionRun['status']
  ) {
    const transitioned = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      if (!allowed.includes(run.status)) {
        throw new ConflictException(`REVISION_STATE_CONFLICT: ${run.status} -> ${status} is not allowed.`);
      }
      const next = {
        ...run,
        status,
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: nowIso()
      };
      state.runs.set(run.id, next);
      return { run: next, chain, fromStatus: run.status };
    });
    this.logTransition('status_changed', transitioned.run, transitioned.chain, {
      fromStatus: transitioned.fromStatus
    });
    return transitioned.run;
  }

  private migrateLegacyRun(value: Record<string, unknown>): FileRevisionRun {
    const id = String(value.id);
    const candidateContentRef = typeof value.candidateContentRef === 'string' ? value.candidateContentRef : undefined;
    const candidate = candidateContentRef ? this.contentStore.verify(candidateContentRef) : undefined;
    const diffContentRef = String(value.diffContentRef);
    const diff = this.contentStore.verify(diffContentRef);
    const legacyStatus = String(value.status);
    const status = ({
      confirmed: 'submitted',
      processing: 'interrupted',
      aggregating: 'interrupted',
      awaiting_confirmation: 'awaiting_confirmation',
      applied: 'applied',
      kept_user_revision: 'abandoned',
      stale: 'stale',
      failed: 'failed'
    } as Record<string, FileRevisionRun['status']>)[legacyStatus] ?? 'interrupted';
    const chainId = `legacy-chain:${id}`;
    const baseHash = value.originalHash as FileHash;
    const userDraftHash = value.revisedHash as FileHash;
    const diffHash = { algorithm: 'sha256', value: diff.sha256 } as FileHash;
    return {
      id,
      chainId,
      dataEpoch: String(value.dataEpoch),
      sessionId: String(value.sessionId),
      baselineId: String(value.baselineId),
      workspaceId: String(value.workspaceId),
      filePath: String(value.filePath),
      iteration: 1,
      status,
      baseKind: 'workspace_baseline',
      baseHash,
      baseContentRef: String(value.originalContentRef),
      baseSizeBytes: Number(value.originalSizeBytes),
      userDraftHash,
      userDraftContentRef: String(value.revisedContentRef),
      userDraftSizeBytes: Number(value.revisedSizeBytes),
      diffContentRef,
      diffHash,
      diffSummary: value.diffSummary as FileRevisionRun['diffSummary'],
      targetAgentIds: Array.isArray(value.targetAgentIds) ? value.targetAgentIds.map(String) : [],
      ...(typeof value.instruction === 'string' ? { instruction: value.instruction } : {}),
      contextSnapshotHash: this.contextSnapshotHash({
        chainId,
        revisionId: id,
        iteration: 1,
        baseHash,
        userDraftHash,
        diffHash
      }),
      agentResults: Array.isArray(value.agentResults)
        ? value.agentResults.map((raw) => {
            const result = raw as FileRevisionAgentResult;
            return { ...result, id: result.id ?? result.taskId };
          })
        : [],
      ...(typeof value.synthesisTaskId === 'string' ? { synthesisTaskId: value.synthesisTaskId } : {}),
      ...(typeof value.candidateChangeSetId === 'string' ? { candidateChangeSetId: value.candidateChangeSetId } : {}),
      ...(candidateContentRef && candidate
        ? {
            candidateContentRef,
            candidateHash: { algorithm: 'sha256', value: candidate.sha256 } as FileHash,
            candidateSizeBytes: candidate.sizeBytes
          }
        : {}),
      ...(typeof value.confirmationId === 'string' ? { confirmationId: value.confirmationId } : {}),
      ...(typeof value.error === 'string'
        ? { errorCode: 'LEGACY_FILE_REVISION_ERROR', errorMessage: value.error }
        : {}),
      createdAt: String(value.createdAt),
      updatedAt: String(value.updatedAt),
      ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {})
    };
  }

  private chainForMigratedRun(
    run: FileRevisionRun,
    revisedRevision?: FileRevisionChain['workspaceExpectedRevision']
  ): FileRevisionChain {
    const terminal = ['applied', 'abandoned', 'stale', 'failed'].includes(run.status);
    const status = run.status === 'applied'
      ? 'applied'
      : run.status === 'abandoned'
        ? 'abandoned'
        : run.status === 'stale'
          ? 'stale'
          : run.status === 'failed'
            ? 'failed'
            : 'active';
    return {
      id: run.chainId,
      dataEpoch: run.dataEpoch,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      filePath: run.filePath,
      rootBaselineId: run.baselineId,
      workspaceExpectedRevision: revisedRevision ?? {
        id: `legacy:${run.id}`,
        observedAt: run.createdAt
      },
      workspaceExpectedHash: run.userDraftHash,
      latestRevisionId: run.id,
      latestIteration: 1,
      stateVersion: run.status === 'awaiting_confirmation' ? 2 : 1,
      status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(terminal ? { completedAt: run.completedAt ?? run.updatedAt } : {})
    };
  }

  private async markApplyRetryable(sessionId: string, revisionId: string, error: unknown) {
    const retryable = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      const timestamp = nowIso();
      void error;
      const message = 'Workspace writeback could not be completed safely. Retry after the Workspace is available.';
      const nextRun: FileRevisionRun = {
        ...run,
        status: 'awaiting_confirmation',
        errorCode: 'REVISION_APPLY_RETRYABLE',
        errorMessage: message,
        updatedAt: timestamp,
        completedAt: undefined
      };
      const nextChain: FileRevisionChain = {
        ...chain,
        status: 'active',
        stateVersion: chain.stateVersion + 1,
        postApplyBaselineStatus: undefined,
        updatedAt: timestamp,
        completedAt: undefined
      };
      state.runs.set(run.id, nextRun);
      state.chains.set(chain.id, nextChain);
      return { run: nextRun, chain: nextChain };
    });
    this.logTransition('apply_retryable', retryable.run, retryable.chain, {
      fromStatus: 'applying',
      errorCode: 'REVISION_APPLY_RETRYABLE'
    });
    return retryable;
  }

  private async markApplyInterrupted(
    sessionId: string,
    revisionId: string,
    applyError: unknown,
    reconcileError: unknown
  ) {
    const interrupted = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      const timestamp = nowIso();
      void applyError;
      void reconcileError;
      const nextRun: FileRevisionRun = {
        ...run,
        status: 'interrupted',
        errorCode: 'REVISION_APPLY_OUTCOME_UNKNOWN',
        errorMessage: 'Workspace writeback outcome could not be verified. Reconcile the Workspace before retrying.',
        updatedAt: timestamp,
        completedAt: undefined
      };
      const nextChain: FileRevisionChain = {
        ...chain,
        status: 'active',
        stateVersion: chain.stateVersion + 1,
        updatedAt: timestamp,
        completedAt: undefined
      };
      state.runs.set(run.id, nextRun);
      state.chains.set(chain.id, nextChain);
      return { run: nextRun, chain: nextChain };
    });
    this.logTransition('apply_interrupted', interrupted.run, interrupted.chain, {
      fromStatus: 'applying',
      errorCode: 'REVISION_APPLY_OUTCOME_UNKNOWN'
    });
    return interrupted;
  }

  private async markApplyStale(sessionId: string, revisionId: string) {
    const stale = await this.mutate((state) => {
      const run = this.requireRun(state, sessionId, revisionId);
      const chain = this.requireChain(state, sessionId, run.chainId);
      const timestamp = nowIso();
      const nextRun = {
        ...run,
        status: 'stale' as const,
        errorCode: 'REVISION_WORKSPACE_STALE',
        errorMessage: 'Workspace changed before the candidate could be applied.',
        updatedAt: timestamp,
        completedAt: timestamp
      };
      const nextChain = {
        ...chain,
        status: 'stale' as const,
        stateVersion: chain.stateVersion + 1,
        updatedAt: timestamp,
        completedAt: timestamp
      };
      state.runs.set(run.id, nextRun);
      state.chains.set(chain.id, nextChain);
      return { run: nextRun, chain: nextChain };
    });
    workspaceMetrics.increment('file_revision_stale_total');
    this.logTransition('apply_stale', stale.run, stale.chain, {
      fromStatus: 'applying',
      errorCode: 'REVISION_WORKSPACE_STALE'
    });
    return stale;
  }

  private changeSetFor(run: FileRevisionRun, chain: FileRevisionChain, revision: FileRevisionChain['workspaceExpectedRevision']): WorkspaceChangeSet {
    const content = this.contentStore.read(run.candidateContentRef!).toString('utf8');
    return {
      id: run.candidateChangeSetId!,
      baseRevision: revision,
      changes: [{
        operation: 'update',
        path: run.filePath,
        content,
        encoding: 'utf-8',
        expectedHash: chain.workspaceExpectedHash
      }],
      createdAt: nowIso()
    };
  }

  private freezeIteration(base: string, baseHash: FileHash, userDraft: string, userDraftHash: FileHash, filePath: string) {
    this.assertHash(baseHash, sha256(base), 'REVISION_CONTEXT_INCOMPLETE');
    this.assertHash(userDraftHash, sha256(userDraft), 'REVISION_CONTEXT_INCOMPLETE');
    const diff = createFileRevisionDiff(base, userDraft);
    if (diff.hunks.length === 0) throw new BadRequestException('REVISION_NO_CHANGES: no deterministic changes were found.');
    const userDraftStored = this.contentStore.put(userDraft, 'text/plain; charset=utf-8', filePath);
    const serializedHunks = JSON.stringify(diff.hunks);
    const diffStored = this.contentStore.put(
      serializedHunks,
      'application/vnd.agent-cluster.file-revision-diff+json',
      `${filePath}.diff.json`
    );
    return {
      userDraftContentRef: userDraftStored.contentRef,
      diffContentRef: diffStored.contentRef,
      diffHash: { algorithm: 'sha256', value: diffStored.sha256 } as FileHash,
      diffSummary: diff.summary
    };
  }

  private contextSnapshotHash(input: {
    chainId: string;
    revisionId: string;
    iteration: number;
    baseHash: FileHash;
    userDraftHash: FileHash;
    diffHash: FileHash;
  }) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }

  private assertEditableHead(run: FileRevisionRun, chain: FileRevisionChain) {
    if (chain.latestRevisionId !== run.id) {
      throw new ConflictException('REVISION_NOT_CHAIN_HEAD: only the latest candidate can be edited.');
    }
    if (chain.status !== 'active' || run.status !== 'awaiting_confirmation' || !run.candidateHash || !run.candidateContentRef) {
      throw new ConflictException(`REVISION_STATE_CONFLICT: candidate is not editable while ${run.status}.`);
    }
  }

  private assertDecisionTarget(run: FileRevisionRun, chain: FileRevisionChain, input: DecideFileRevisionInput) {
    this.assertEditableHead(run, chain);
    this.assertStateVersion(chain, input.expectedStateVersion);
    if (run.confirmationId !== input.confirmationId) {
      throw new ConflictException('REVISION_CONFIRMATION_MISMATCH: confirmation does not identify this candidate.');
    }
    this.assertHash(run.candidateHash, input.candidateHash, 'REVISION_CANDIDATE_MISMATCH');
  }

  private assertStateVersion(chain: FileRevisionChain, expected: number) {
    if (!Number.isInteger(expected) || chain.stateVersion !== expected) {
      throw new ConflictException(`REVISION_STATE_CONFLICT: expected ${expected}, actual ${chain.stateVersion}.`);
    }
  }

  private assertHash(actual: FileHash | undefined, expected: FileHash, code: string) {
    if (!actual || !sameHash(actual, expected)) {
      if (code === 'REVISION_CONTEXT_INCOMPLETE') {
        workspaceMetrics.increment('file_revision_context_incomplete_total');
      }
      throw new ConflictException(`${code}: content hash does not match the frozen revision state.`);
    }
  }

  private normalizeAgentIds(values: string[] | undefined) {
    const ids = [...new Set(values?.map((item) => item.trim()).filter(Boolean) ?? [])];
    if (ids.length === 0) throw new BadRequestException('Select at least one Agent.');
    return ids;
  }

  private normalizeInstruction(value: string | undefined) {
    const instruction = value?.trim();
    if (instruction && instruction.length > 2_000) {
      throw new BadRequestException('File revision instruction must not exceed 2000 characters.');
    }
    return instruction || undefined;
  }

  private reprocessKey(input: {
    chainId: string;
    parentRevisionId: string;
    expectedCandidateHash: FileHash;
    draftHash: FileHash;
    targetAgentIds: string[];
    instruction?: string;
  }) {
    return createHash('sha256').update(JSON.stringify({
      chainId: input.chainId,
      parentRevisionId: input.parentRevisionId,
      expectedCandidateHash: input.expectedCandidateHash,
      draftHash: input.draftHash,
      targetAgentIds: [...input.targetAgentIds].sort(),
      instruction: input.instruction ?? ''
    })).digest('hex');
  }

  private assertCompleteText(content: string, truncated: boolean, reportedBytes: number) {
    const actualBytes = Buffer.byteLength(content, 'utf8');
    if (truncated || reportedBytes > FILE_REVISION_MAX_BYTES || actualBytes > FILE_REVISION_MAX_BYTES) {
      throw new BadRequestException(`REVISION_FILE_TOO_LARGE: maximum supported size is ${FILE_REVISION_MAX_BYTES} bytes.`);
    }
    if (content.includes('\0')) throw new BadRequestException('REVISION_BINARY_FILE_UNSUPPORTED: only UTF-8 text is supported.');
  }

  private requireFullFileHash(hash: FileHash | undefined) {
    if (!hash) {
      throw new BadRequestException('REVISION_FILE_HASH_MISSING: Workspace Provider did not return a full-file hash.');
    }
    return hash;
  }

  private requireProvider(session: SessionDetail) {
    const provider = this.workspaceProviders.resolve(session);
    if (!provider) throw new BadRequestException('The session has no readable Workspace Provider.');
    if (!provider.capabilities().read) throw new BadRequestException('The Workspace Provider does not allow reading files.');
    return provider;
  }

  private requireRun(state: MutableRevisionState, sessionId: string, revisionId: string) {
    const run = state.runs.get(revisionId);
    if (!run || run.sessionId !== sessionId) throw new NotFoundException(`File revision run not found: ${revisionId}`);
    return run;
  }

  private requireChain(state: MutableRevisionState, sessionId: string, chainId: string) {
    const chain = state.chains.get(chainId);
    if (!chain || chain.sessionId !== sessionId) throw new NotFoundException(`File revision chain not found: ${chainId}`);
    return chain;
  }

  private logTransition(
    action: string,
    run: FileRevisionRun,
    chain: FileRevisionChain,
    context: {
      fromStatus?: FileRevisionRun['status'];
      retryMode?: FileRevisionRun['recoveryRetryMode'];
      decision?: ResolveFileRevisionFailureInput['decision'];
      errorCode?: string;
    } = {}
  ) {
    this.logger.log(JSON.stringify({
      event: 'file_revision_transition',
      action,
      sessionId: run.sessionId,
      chainId: chain.id,
      revisionId: run.id,
      iteration: run.iteration,
      status: run.status,
      stateVersion: chain.stateVersion,
      ...(run.receiverInvocationId ? { invocationId: run.receiverInvocationId } : {}),
      ...(context.fromStatus ? { fromStatus: context.fromStatus } : {}),
      ...(context.retryMode ? { retryMode: context.retryMode } : {}),
      ...(context.decision ? { decision: context.decision } : {}),
      ...(context.errorCode ? { errorCode: context.errorCode } : {})
    }));
  }

  private async mutate<T>(mutator: (state: MutableRevisionState) => T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const state: MutableRevisionState = {
        baselines: new Map(this.baselines),
        chains: new Map(this.chains),
        runs: new Map(this.runs),
        drafts: new Map(this.drafts)
      };
      const value = mutator(state);
      const nextSnapshot = this.serializedState(state);
      let persisted: Awaited<ReturnType<PersistenceService['compareAndSetCollection']>>;
      try {
        persisted = await this.persistence.compareAndSetCollection<PersistedFileRevisions>(
          COLLECTION_KEY,
          this.persistedSnapshot,
          nextSnapshot
        );
      } catch (error) {
        workspaceMetrics.increment('file_revision_persistence_failure_total');
        throw error;
      }
      if (persisted.status === 'conflict') {
        this.replaceFromPersisted(
          this.persistence.getCollection<Partial<PersistedFileRevisions>>(COLLECTION_KEY, {})
        );
        workspaceMetrics.increment('file_revision_persistence_conflict_total');
        throw new ConflictException('REVISION_PERSISTENCE_CONFLICT: state changed in another process; local state was refreshed.');
      }
      if (persisted.status !== 'applied') {
        workspaceMetrics.increment('file_revision_persistence_failure_total');
        throw persisted.error;
      }
      this.baselines = state.baselines;
      this.chains = state.chains;
      this.runs = state.runs;
      this.drafts = state.drafts;
      this.persistedSnapshot = nextSnapshot;
      return value;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private serializedState(state: MutableRevisionState): PersistedFileRevisions {
    return {
      schemaVersion: 2,
      baselines: [...state.baselines.values()],
      chains: [...state.chains.values()],
      runs: [...state.runs.values()],
      drafts: [...state.drafts.values()]
    };
  }

  private replaceFromPersisted(persisted: Partial<PersistedFileRevisions>) {
    const dataEpoch = this.persistence.currentDataEpoch();
    const baselines = new Map<string, FileRevisionBaseline>();
    const chains = new Map<string, FileRevisionChain>();
    const runs = new Map<string, FileRevisionRun>();
    const drafts = new Map<string, FileRevisionEditorDraft>();
    for (const baseline of persisted.baselines ?? []) {
      assertCurrentDataEpoch(dataEpoch, baseline.dataEpoch, `FileRevisionBaseline ${baseline.id}`);
      baselines.set(baseline.id, baseline);
    }
    for (const chain of persisted.chains ?? []) {
      assertCurrentDataEpoch(dataEpoch, chain.dataEpoch, `FileRevisionChain ${chain.id}`);
      chains.set(chain.id, chain);
    }
    for (const persistedRun of persisted.runs ?? []) {
      assertCurrentDataEpoch(dataEpoch, persistedRun.dataEpoch, `FileRevisionRun ${persistedRun.id}`);
      const run = 'chainId' in persistedRun
        ? persistedRun
        : this.migrateLegacyRun(persistedRun as unknown as Record<string, unknown>);
      runs.set(run.id, run);
    }
    for (const draft of persisted.drafts ?? []) drafts.set(draft.chainId, draft);
    this.baselines = baselines;
    this.chains = chains;
    this.runs = runs;
    this.drafts = drafts;
    this.persistedSnapshot = this.serializedState({ baselines, chains, runs, drafts });
  }

  private async withChainLock<T>(chainId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chainTails.get(chainId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.chainTails.set(chainId, tail);
    try {
      return await result;
    } finally {
      if (this.chainTails.get(chainId) === tail) this.chainTails.delete(chainId);
    }
  }
}

function sha256(content: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') };
}

function sameHash(left: FileHash, right: FileHash) {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function isTerminal(status: FileRevisionRun['status']) {
  return ['superseded', 'applied', 'abandoned', 'stale', 'failed'].includes(status);
}

function collectRevisionContentRefs(
  baselines: FileRevisionBaseline[],
  runs: FileRevisionRun[],
  drafts: FileRevisionEditorDraft[]
): Set<string> {
  const refs = new Set<string>();
  for (const baseline of baselines) refs.add(baseline.contentRef);
  for (const run of runs) {
    refs.add(run.baseContentRef);
    refs.add(run.userDraftContentRef);
    refs.add(run.diffContentRef);
    if (run.candidateContentRef) refs.add(run.candidateContentRef);
    for (const result of run.agentResults) {
      if (result.proposedContentRef) refs.add(result.proposedContentRef);
    }
  }
  for (const draft of drafts) refs.add(draft.contentRef);
  return refs;
}
