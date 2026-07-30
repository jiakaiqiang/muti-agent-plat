import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileRevisionRun, SessionDetail } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ServerLocalWorkspaceProvider } from '../workspaces/server-local-workspace-provider.js';
import type { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { FileRevisionsService } from './file-revisions.service.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'file-revisions-'));
  const contentRoot = join(root, 'content-store');
  const persistence = new PersistenceService({ enabled: false });
  const provider = new ServerLocalWorkspaceProvider(root);
  const contentStore = new LocalContentStore({ rootDir: contentRoot });
  const service = new FileRevisionsService(
    persistence,
    contentStore,
    { resolve: () => provider } as unknown as WorkspaceProviderResolver
  );
  const session = {
    id: 'session-revision',
    dataEpoch: persistence.currentDataEpoch(),
    ownerId: 'user-revision',
    workspaceId: 'workspace-revision',
    workingDirectory: {
      kind: 'server_local',
      id: 'workspace-revision',
      name: 'revision-workspace',
      path: root,
      selectedAt: '2026-07-28T00:00:00.000Z'
    }
  } as SessionDetail;
  return { root, service, session, persistence, contentStore, provider };
}

async function persistentFixture() {
  const root = await mkdtemp(join(tmpdir(), 'file-revisions-persisted-'));
  const contentRoot = join(root, 'content-store');
  const stateFile = join(root, 'state.json');
  const dataEpoch = '11111111-1111-4111-8111-111111111111';
  await writeFile(stateFile, JSON.stringify({
    systemDataMetadata: {
      dataSchemaVersion: 3,
      dataEpoch,
      pipelineVersion: 'v2',
      cutoverAt: '2026-07-29T00:00:00.000Z',
      cutoverAuditId: 'file-revision-recovery-test'
    }
  }), 'utf8');
  const provider = new ServerLocalWorkspaceProvider(root);
  const resolver = { resolve: () => provider } as unknown as WorkspaceProviderResolver;
  const makeService = async () => {
    const persistence = new PersistenceService({ enabled: true, filePath: stateFile });
    await persistence.initialize();
    return {
      persistence,
      service: new FileRevisionsService(
        persistence,
        new LocalContentStore({ rootDir: contentRoot }),
        resolver
      )
    };
  };
  const session = {
    id: 'session-revision-recovery',
    dataEpoch,
    ownerId: 'user-revision',
    workspaceId: 'workspace-revision',
    workingDirectory: {
      kind: 'server_local',
      id: 'workspace-revision',
      name: 'revision-workspace',
      path: root,
      selectedAt: '2026-07-29T00:00:00.000Z'
    }
  } as SessionDetail;
  return { root, stateFile, session, makeService, provider };
}

async function publishCandidate(service: FileRevisionsService, run: FileRevisionRun, content: string) {
  await service.markProcessing(run.sessionId, run.id);
  await service.markSynthesizing(run.sessionId, run.id);
  return service.markAwaitingConfirmation(run.sessionId, run.id, {
    candidateContent: content,
    confirmationId: `confirm-${run.iteration}`,
    receiverInvocationId: `receiver-${run.iteration}`,
    synthesisTaskId: `synthesis-${run.iteration}`
  });
}

test('FileRevisionsService structured transition logs contain identities without revision content', async () => {
  const { root, service, session } = await fixture();
  const messages: string[] = [];
  (service as unknown as { logger: { log(message: string): void } }).logger = {
    log(message: string) {
      messages.push(message);
    }
  };
  try {
    await writeFile(join(root, 'logged.md'), 'BASELINE_LOG_SECRET\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'logged.md' });
    await writeFile(join(root, 'logged.md'), 'USER_DRAFT_LOG_SECRET\n', 'utf8');
    const run = await service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a']
    });
    await publishCandidate(service, run, 'CANDIDATE_LOG_SECRET\n');

    assert.ok(messages.length >= 4);
    assert.doesNotMatch(messages.join('\n'), /BASELINE_LOG_SECRET|USER_DRAFT_LOG_SECRET|CANDIDATE_LOG_SECRET/);
    const records = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
    for (const record of records) {
      assert.equal(record.event, 'file_revision_transition');
      assert.equal(record.sessionId, session.id);
      assert.equal(record.chainId, run.chainId);
      assert.equal(record.revisionId, run.id);
      assert.equal(record.iteration, 1);
      assert.equal(typeof record.status, 'string');
      assert.equal(typeof record.stateVersion, 'number');
    }
    assert.equal(records.at(-1)?.invocationId, 'receiver-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService preserves W0 -> U1 -> G1 -> U2 -> G2 -> U3 -> G3 and writes only G3', async () => {
  workspaceMetrics.resetForTests();
  const { root, service, session } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, '# Result\n\nW0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, '# Result\n\nU1\n', 'utf8');

    const first = await service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a'],
      instruction: '  Preserve approved terminology.  '
    });
    assert.equal(first.iteration, 1);
    assert.equal(first.baseKind, 'workspace_baseline');
    assert.equal(first.instruction, 'Preserve approved terminology.');
    assert.match(service.evidence(session.id, first.id).base.content, /W0/);
    assert.match(service.evidence(session.id, first.id).userDraft.content, /U1/);
    const firstCandidate = await publishCandidate(service, first, '# Result\n\nG1\n');
    const chainAfterFirst = service.getChain(session.id, first.chainId);
    assert.equal(chainAfterFirst.stateVersion, 2);

    const draft2 = await service.saveDraft(session.id, first.id, {
      expectedCandidateHash: firstCandidate.candidateHash!,
      content: '# Result\n\nU2\n'
    }, { type: 'user', id: 'user-revision' });
    assert.equal(await readFile(path, 'utf8'), '# Result\n\nU1\n');
    const second = await service.reprocess(session.id, first.id, {
      draftHash: draft2.contentHash,
      expectedCandidateHash: firstCandidate.candidateHash!,
      expectedStateVersion: chainAfterFirst.stateVersion
    });
    const retriedSecond = await service.reprocess(session.id, first.id, {
      draftHash: draft2.contentHash,
      expectedCandidateHash: firstCandidate.candidateHash!,
      expectedStateVersion: chainAfterFirst.stateVersion
    });
    assert.equal(retriedSecond.id, second.id);
    assert.equal(service.listRuns(session.id).filter((item) => item.parentRevisionId === first.id).length, 1);
    assert.equal(second.iteration, 2);
    assert.equal(second.parentRevisionId, first.id);
    assert.equal(second.baseKind, 'previous_candidate');
    assert.equal(service.getRun(session.id, first.id).status, 'superseded');
    assert.match(service.evidence(session.id, second.id).base.content, /G1/);
    assert.match(service.evidence(session.id, second.id).userDraft.content, /U2/);

    const secondCandidate = await publishCandidate(service, second, '# Result\n\nG2\n');
    const chainAfterSecond = service.getChain(session.id, second.chainId);
    const draft3 = await service.saveDraft(session.id, second.id, {
      expectedCandidateHash: secondCandidate.candidateHash!,
      content: '# Result\n\nU3\n'
    }, { type: 'user', id: 'user-revision' });
    const third = await service.reprocess(session.id, second.id, {
      draftHash: draft3.contentHash,
      expectedCandidateHash: secondCandidate.candidateHash!,
      expectedStateVersion: chainAfterSecond.stateVersion
    });
    assert.equal(third.iteration, 3);
    assert.match(service.evidence(session.id, third.id).base.content, /G2/);
    assert.match(service.evidence(session.id, third.id).userDraft.content, /U3/);

    const thirdCandidate = await publishCandidate(service, third, '# Result\n\nG3\n');
    assert.equal(await readFile(path, 'utf8'), '# Result\n\nU1\n');
    const finalChain = service.getChain(session.id, third.chainId);
    const applied = await service.applyCandidate(session, third.id, {
      confirmationId: thirdCandidate.confirmationId!,
      candidateHash: thirdCandidate.candidateHash!,
      expectedStateVersion: finalChain.stateVersion,
      decision: 'apply_candidate'
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.run.status, 'applied');
    assert.equal(await readFile(path, 'utf8'), '# Result\n\nG3\n');
    assert.equal(applied.baseline?.source, 'post_apply');
    const metrics = workspaceMetrics.snapshot().series;
    assert.equal(metrics.find((item) => item.name === 'file_revision_chain_total')?.value, 1);
    assert.equal(
      metrics.filter((item) => item.name === 'file_revision_iteration_total')
        .reduce((sum, item) => sum + (item.value ?? 0), 0),
      3
    );
    assert.equal(metrics.find((item) => item.name === 'file_revision_iteration_duration_ms')?.count, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService deletes only Session content that has no remaining revision references', async () => {
  const { root, service, session, contentStore } = await fixture();
  try {
    await writeFile(join(root, 'shared.md'), 'shared baseline\n', 'utf8');
    const first = await service.captureBaseline(session, { filePath: 'shared.md' });
    const secondSession = { ...session, id: 'session-revision-second' };
    const second = await service.captureBaseline(secondSession, { filePath: 'shared.md' });
    assert.equal(first.contentRef, second.contentRef);

    await service.deleteSession(session.id);
    assert.equal(contentStore.exists(first.contentRef), true);

    await service.deleteSession(secondSession.id);
    assert.equal(contentStore.exists(first.contentRef), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService rejects stale Workspace and concurrent duplicate decisions', async () => {
  const { root, service, session } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const chain = service.getChain(session.id, run.chainId);
    const decision = {
      confirmationId: candidate.confirmationId!,
      candidateHash: candidate.candidateHash!,
      expectedStateVersion: chain.stateVersion,
      decision: 'apply_candidate' as const
    };

    const duplicate = await Promise.allSettled([
      service.applyCandidate(session, run.id, decision),
      service.applyCandidate(session, run.id, decision)
    ]);
    assert.equal(duplicate.filter((item) => item.status === 'fulfilled').length, 2);
    assert.equal(duplicate.filter((item) => item.status === 'rejected').length, 0);
    assert.equal(await readFile(path, 'utf8'), 'G1\n');

    await writeFile(path, 'W0-again\n', 'utf8');
    const baseline2 = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1-again\n', 'utf8');
    const staleRun = await service.createRun(session, { baselineId: baseline2.id, targetAgentIds: ['agent-a'] });
    const staleCandidate = await publishCandidate(service, staleRun, 'G-stale\n');
    await writeFile(path, 'external edit\n', 'utf8');
    const stale = await service.applyCandidate(session, staleRun.id, {
      confirmationId: staleCandidate.confirmationId!,
      candidateHash: staleCandidate.candidateHash!,
      expectedStateVersion: service.getChain(session.id, staleRun.chainId).stateVersion,
      decision: 'apply_candidate'
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.run.status, 'stale');
    assert.equal(await readFile(path, 'utf8'), 'external edit\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService does not publish in-memory mutations when persistence rejects a write', async () => {
  workspaceMetrics.resetForTests();
  const { root, service, session, persistence } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const originalSetCollection = persistence.setCollection.bind(persistence);
    persistence.setCollection = async () => false;
    await assert.rejects(
      service.saveDraft(session.id, run.id, {
        expectedCandidateHash: candidate.candidateHash!,
        content: 'U2\n'
      }, { type: 'user', id: 'user-revision' }),
      /REVISION_PERSISTENCE_FAILED/
    );
    assert.equal(service.listDrafts(session.id).length, 0);
    assert.equal(
      workspaceMetrics.snapshot().series.find((item) => item.name === 'file_revision_persistence_failure_total')?.value,
      1
    );
    persistence.setCollection = originalSetCollection;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService reconciles provider exceptions without leaving applying stuck', async () => {
  const { root, service, session, provider } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const decision = {
      confirmationId: candidate.confirmationId!,
      candidateHash: candidate.candidateHash!,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'apply_candidate' as const
    };

    const originalRead = provider.readFile.bind(provider);
    let readCalls = 0;
    provider.readFile = async (input) => {
      readCalls += 1;
      if (readCalls === 1) throw new Error('temporary read failure');
      return originalRead(input);
    };
    await assert.rejects(service.applyCandidate(session, run.id, decision), /REVISION_APPLY_RETRYABLE/);
    assert.equal(service.getRun(session.id, run.id).status, 'awaiting_confirmation');
    assert.equal(await readFile(path, 'utf8'), 'U1\n');

    provider.readFile = async (input) => ({
      ...await originalRead(input),
      truncated: true
    });
    await assert.rejects(service.applyCandidate(session, run.id, {
      ...decision,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion
    }), /REVISION_APPLY_RETRYABLE/);
    assert.equal(service.getRun(session.id, run.id).status, 'awaiting_confirmation');

    provider.readFile = originalRead;
    const originalApply = provider.applyChangeSet.bind(provider);
    provider.applyChangeSet = async (changeSet) => {
      await originalApply(changeSet);
      throw new Error('response lost after write');
    };
    const reconciled = await service.applyCandidate(session, run.id, {
      ...decision,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion
    });
    assert.equal(reconciled.applied, true);
    assert.equal(reconciled.run.status, 'applied');
    assert.equal(await readFile(path, 'utf8'), 'G1\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService exposes explicit reconciliation when apply outcome cannot be read', async () => {
  const { root, service, session, provider } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const originalRead = provider.readFile.bind(provider);
    let readCalls = 0;
    provider.readFile = async (input) => {
      readCalls += 1;
      if (readCalls > 1) throw new Error('reconciliation unavailable');
      return originalRead(input);
    };
    provider.applyChangeSet = async () => {
      throw new Error('apply connection lost');
    };

    await assert.rejects(service.applyCandidate(session, run.id, {
      confirmationId: candidate.confirmationId!,
      candidateHash: candidate.candidateHash!,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'apply_candidate'
    }), /REVISION_APPLY_OUTCOME_UNKNOWN/);
    assert.equal(service.getRun(session.id, run.id).status, 'interrupted');

    provider.readFile = originalRead;
    const retried = await service.retryInterrupted(session, run.id, {
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      retryKey: 'reconcile-unknown-apply'
    });
    assert.equal(retried.mode, 'apply_reconcile');
    assert.equal(retried.run.status, 'awaiting_confirmation');
    assert.equal(await readFile(path, 'utf8'), 'U1\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService treats a reconciliation response without a full hash as outcome unknown', async () => {
  const { root, service, session, provider } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const originalRead = provider.readFile.bind(provider);
    let readCalls = 0;
    provider.readFile = async (input) => {
      readCalls += 1;
      const result = await originalRead(input);
      return readCalls > 1 ? { ...result, hash: undefined } : result;
    };
    provider.applyChangeSet = async () => {
      throw new Error('apply connection lost');
    };

    await assert.rejects(service.applyCandidate(session, run.id, {
      confirmationId: candidate.confirmationId!,
      candidateHash: candidate.candidateHash!,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'apply_candidate'
    }), /REVISION_APPLY_OUTCOME_UNKNOWN/);
    assert.equal(service.getRun(session.id, run.id).status, 'interrupted');
    assert.equal(service.getRun(session.id, run.id).errorCode, 'REVISION_APPLY_OUTCOME_UNKNOWN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService stores only a stable code when post-apply baseline capture fails', async () => {
  const { root, service, session, provider } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    const candidate = await publishCandidate(service, run, 'G1\n');
    const originalRead = provider.readFile.bind(provider);
    let readCalls = 0;
    provider.readFile = async (input) => {
      readCalls += 1;
      if (readCalls > 1) throw new Error('POST_APPLY_PROVIDER_SECRET');
      return originalRead(input);
    };

    const applied = await service.applyCandidate(session, run.id, {
      confirmationId: candidate.confirmationId!,
      candidateHash: candidate.candidateHash!,
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'apply_candidate'
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.postApplyBaselineError, 'REVISION_POST_APPLY_BASELINE_FAILED');
    assert.equal(applied.chain.postApplyBaselineError, 'REVISION_POST_APPLY_BASELINE_FAILED');
    assert.doesNotMatch(JSON.stringify(applied), /POST_APPLY_PROVIDER_SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService serializes retry, continue, and abandon decisions after partial Agent failure', async () => {
  const { root, service, session } = await fixture();
  try {
    const path = join(root, 'result.md');
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a', 'agent-b']
    });
    await service.markProcessing(session.id, run.id);
    await service.recordAgentResult(session.id, run.id, {
      id: 'result-success',
      taskId: 'task-success',
      agentId: 'agent-a',
      status: 'completed',
      artifactIds: [],
      summary: 'success',
      proposedContentRef: service.storeProposedContent('G1 from A\n', 'result.md'),
      completedAt: '2026-07-29T00:00:00.000Z'
    });
    await service.recordAgentResult(session.id, run.id, {
      id: 'result-failed',
      taskId: 'task-failed',
      agentId: 'agent-b',
      status: 'failed',
      artifactIds: [],
      summary: 'failed',
      completedAt: '2026-07-29T00:00:00.000Z',
      error: 'runtime failed'
    });
    await service.markFailed(
      session.id,
      run.id,
      'REVISION_PARTIAL_AGENT_FAILURE',
      '1/2 Agents completed.'
    );

    const failedChain = service.getChain(session.id, run.chainId);
    const continued = await service.resolvePartialFailure(session.id, run.id, {
      expectedStateVersion: failedChain.stateVersion,
      decision: 'continue_with_successful',
      instruction: 'Use the successful proposal and record the failed Agent.'
    });
    assert.equal(continued.run.status, 'processing');
    assert.equal(continued.run.agentResults.length, 2);
    assert.equal(continued.chain.status, 'active');
    await assert.rejects(
      service.resolvePartialFailure(session.id, run.id, {
        expectedStateVersion: failedChain.stateVersion,
        decision: 'retry_agents'
      }),
      /REVISION_STATE_CONFLICT/
    );

    await service.markFailed(session.id, run.id, 'REVISION_PARTIAL_AGENT_FAILURE', '1/2 Agents completed.');
    const retried = await service.resolvePartialFailure(session.id, run.id, {
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'retry_agents'
    });
    assert.equal(retried.run.status, 'submitted');
    assert.deepEqual(retried.run.agentResults, []);

    await service.markProcessing(session.id, run.id);
    await service.recordAgentResult(session.id, run.id, {
      id: 'retry-failed',
      taskId: 'retry-task-failed',
      agentId: 'agent-a',
      status: 'failed',
      artifactIds: [],
      summary: 'failed again',
      completedAt: '2026-07-29T00:00:01.000Z',
      error: 'runtime failed again'
    });
    await service.markFailed(session.id, run.id, 'REVISION_PARTIAL_AGENT_FAILURE', '0/2 Agents completed.');
    const abandoned = await service.resolvePartialFailure(session.id, run.id, {
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      decision: 'abandon_revision'
    });
    assert.equal(abandoned.run.status, 'abandoned');
    assert.equal(abandoned.chain.status, 'abandoned');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService allows only one of two concurrent opposite failure decisions', async () => {
  const { root, service, session } = await fixture();
  try {
    await writeFile(join(root, 'result.md'), 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(join(root, 'result.md'), 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    await service.markProcessing(session.id, run.id);
    await service.markFailed(session.id, run.id, 'REVISION_PARTIAL_AGENT_FAILURE', 'Agent failed.');
    const stateVersion = service.getChain(session.id, run.chainId).stateVersion;

    const decisions = await Promise.allSettled([
      service.resolvePartialFailure(session.id, run.id, {
        expectedStateVersion: stateVersion,
        decision: 'retry_agents'
      }),
      service.resolvePartialFailure(session.id, run.id, {
        expectedStateVersion: stateVersion,
        decision: 'abandon_revision'
      })
    ]);
    assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(decisions.filter((result) => result.status === 'rejected').length, 1);
    assert.ok(['submitted', 'abandoned'].includes(service.getRun(session.id, run.id).status));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService restores awaiting candidate and editor draft after a process restart', async () => {
  const { root, session, makeService } = await persistentFixture();
  try {
    const path = join(root, 'result.md');
    const firstProcess = await makeService();
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await firstProcess.service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const run = await firstProcess.service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a']
    });
    const candidate = await publishCandidate(firstProcess.service, run, 'G1\n');
    assert.equal(firstProcess.service.getDraft(session.id, run.id), null);
    const draft = await firstProcess.service.saveDraft(session.id, run.id, {
      expectedCandidateHash: candidate.candidateHash!,
      content: 'U2 saved but not submitted\n'
    }, { type: 'user', id: 'user-revision' });

    const secondProcess = await makeService();
    assert.equal(secondProcess.service.getCandidate(session.id, run.id).content, 'G1\n');
    assert.equal(secondProcess.service.getDraft(session.id, run.id)!.content, 'U2 saved but not submitted\n');
    assert.equal(secondProcess.service.getDraft(session.id, run.id)!.contentHash.value, draft.contentHash.value);
    assert.equal(secondProcess.service.getRun(session.id, run.id).status, 'awaiting_confirmation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService recovery interrupts in-flight work and reconciles every applying hash outcome', async () => {
  workspaceMetrics.resetForTests();
  const { root, session, makeService, provider } = await persistentFixture();
  try {
    const path = join(root, 'result.md');
    const firstProcess = await makeService();
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await firstProcess.service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const interruptedRun = await firstProcess.service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a']
    });
    await firstProcess.service.markProcessing(session.id, interruptedRun.id);

    const interruptedProcess = await makeService();
    const interrupted = await interruptedProcess.service.recoverSession(session);
    assert.deepEqual(interrupted.map((item) => item.to), ['interrupted']);
    assert.equal(interruptedProcess.service.getRun(session.id, interruptedRun.id).status, 'interrupted');

    await interruptedProcess.service.markProcessing(session.id, interruptedRun.id);
    await interruptedProcess.service.markSynthesizing(session.id, interruptedRun.id);
    const candidate = await interruptedProcess.service.markAwaitingConfirmation(session.id, interruptedRun.id, {
      candidateContent: 'G1\n',
      confirmationId: 'confirm-recovery',
      receiverInvocationId: 'receiver-recovery',
      synthesisTaskId: 'synthesis-recovery'
    });

    async function persistApplyingState() {
      const currentProcess = await makeService();
      const state = currentProcess.persistence.getCollection<any>('fileRevisions', {});
      state.runs = state.runs.map((item: FileRevisionRun) =>
        item.id === interruptedRun.id ? { ...item, status: 'applying' } : item
      );
      state.chains = state.chains.map((item: { id: string }) =>
        item.id === interruptedRun.chainId ? { ...item, status: 'applying' } : item
      );
      await currentProcess.persistence.setCollection('fileRevisions', state);
    }

    await persistApplyingState();
    const expectedHashProcess = await makeService();
    assert.equal((await expectedHashProcess.service.recoverSession(session))[0]?.to, 'awaiting_confirmation');

    await persistApplyingState();
    await writeFile(path, 'G1\n', 'utf8');
    const candidateHashProcess = await makeService();
    assert.equal((await candidateHashProcess.service.recoverSession(session))[0]?.to, 'applied');
    assert.equal(candidateHashProcess.service.getRun(session.id, interruptedRun.id).candidateHash?.value, candidate.candidateHash?.value);

    await persistApplyingState();
    const unavailableProcess = await makeService();
    const originalRead = provider.readFile.bind(provider);
    provider.readFile = async () => {
      throw new Error('provider unavailable during startup recovery');
    };
    assert.equal((await unavailableProcess.service.recoverSession(session))[0]?.to, 'interrupted');
    assert.equal(unavailableProcess.service.getRun(session.id, interruptedRun.id).status, 'interrupted');
    assert.equal(
      unavailableProcess.service.getRun(session.id, interruptedRun.id).errorCode,
      'REVISION_APPLY_OUTCOME_UNKNOWN'
    );
    provider.readFile = originalRead;

    await persistApplyingState();
    await writeFile(path, 'external edit\n', 'utf8');
    const staleProcess = await makeService();
    assert.equal((await staleProcess.service.recoverSession(session))[0]?.to, 'stale');
    const metrics = workspaceMetrics.snapshot().series;
    assert.equal(
      metrics.filter((item) => item.name === 'file_revision_recovery_total')
        .reduce((sum, item) => sum + (item.value ?? 0), 0),
      5
    );
    assert.equal(metrics.find((item) => item.name === 'file_revision_stale_total')?.value, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService retries interrupted work idempotently and resumes at the correct stage', async () => {
  const { root, service, session } = await fixture();
  try {
    await writeFile(join(root, 'result.md'), 'W0\n', 'utf8');
    const baseline = await service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(join(root, 'result.md'), 'U1\n', 'utf8');
    const run = await service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });
    await service.markProcessing(session.id, run.id);
    await service.recoverSession(session);

    const agentRetry = await service.retryInterrupted(session, run.id, {
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      retryKey: 'retry-agents'
    });
    const duplicateAgentRetry = await service.retryInterrupted(session, run.id, {
      expectedStateVersion: run.iteration,
      retryKey: 'retry-agents'
    });
    assert.equal(agentRetry.mode, 'run_agents');
    assert.equal(agentRetry.run.status, 'submitted');
    assert.equal(duplicateAgentRetry.run.id, agentRetry.run.id);

    await service.markProcessing(session.id, run.id);
    await service.recordAgentResult(session.id, run.id, {
      id: 'result-a',
      taskId: 'task-a',
      agentId: 'agent-a',
      status: 'completed',
      artifactIds: [],
      summary: 'completed',
      completedAt: '2026-07-29T00:00:00.000Z'
    });
    await service.markSynthesizing(session.id, run.id);
    await service.recoverSession(session);

    const receiverRetry = await service.retryInterrupted(session, run.id, {
      expectedStateVersion: service.getChain(session.id, run.chainId).stateVersion,
      retryKey: 'retry-receiver'
    });
    assert.equal(receiverRetry.mode, 'receiver_only');
    assert.equal(receiverRetry.run.status, 'processing');
    assert.equal(receiverRetry.run.agentResults.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService returns the winning child after a cross-instance reprocess CAS conflict', async () => {
  const { root, session, makeService } = await persistentFixture();
  try {
    const path = join(root, 'result.md');
    const creator = await makeService();
    await writeFile(path, 'W0\n', 'utf8');
    const baseline = await creator.service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(path, 'U1\n', 'utf8');
    const parent = await creator.service.createRun(session, {
      baselineId: baseline.id,
      targetAgentIds: ['agent-a']
    });
    const candidate = await publishCandidate(creator.service, parent, 'G1\n');
    const draft = await creator.service.saveDraft(session.id, parent.id, {
      expectedCandidateHash: candidate.candidateHash!,
      content: 'U2\n'
    }, { type: 'user', id: 'user-revision' });
    const losingProcess = await makeService();
    const input = {
      draftHash: draft.contentHash,
      expectedCandidateHash: candidate.candidateHash!,
      expectedStateVersion: creator.service.getChain(session.id, parent.chainId).stateVersion
    };

    const winner = await creator.service.reprocess(session.id, parent.id, input);
    const winnerState = creator.persistence.getCollection('fileRevisions', {});
    losingProcess.persistence.compareAndSetCollection = async () => ({ status: 'conflict' });
    losingProcess.persistence.getCollection = () => structuredClone(winnerState) as never;
    const duplicate = await losingProcess.service.reprocess(session.id, parent.id, input);

    assert.equal(duplicate.id, winner.id);
    assert.equal(duplicate.reprocessKey, winner.reprocessKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileRevisionsService refreshes its in-memory snapshot after a persistence CAS conflict', async () => {
  const { root, session, makeService } = await persistentFixture();
  try {
    await writeFile(join(root, 'result.md'), 'W0\n', 'utf8');
    const creator = await makeService();
    const baseline = await creator.service.captureBaseline(session, { filePath: 'result.md' });
    await writeFile(join(root, 'result.md'), 'U1\n', 'utf8');
    const run = await creator.service.createRun(session, { baselineId: baseline.id, targetAgentIds: ['agent-a'] });

    const losingProcess = await makeService();
    await creator.service.markProcessing(session.id, run.id);
    const refreshedPersistence = await makeService();
    const winnerState = refreshedPersistence.persistence.getCollection('fileRevisions', {});
    losingProcess.persistence.compareAndSetCollection = async () => ({ status: 'conflict' });
    const originalGetCollection = losingProcess.persistence.getCollection.bind(losingProcess.persistence);
    losingProcess.persistence.getCollection = ((key: string, fallback: unknown) =>
      key === 'fileRevisions' ? structuredClone(winnerState) : originalGetCollection(key, fallback)) as never;

    await assert.rejects(
      losingProcess.service.markProcessing(session.id, run.id),
      /REVISION_PERSISTENCE_CONFLICT/
    );
    assert.equal(losingProcess.service.getRun(session.id, run.id).status, 'processing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
