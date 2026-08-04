import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunResult, InvocationPlan } from '@agent-cluster/shared';
import { createRuntimeArtifactOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { WorktreeExecutionService } from './worktree-execution.service.js';

async function withRepository(
  callback: (input: { root: string; repository: string; staging: string; bindings: InvocationWorkspaceBindingsService }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-worktree-'));
  const repository = join(root, 'repository');
  const staging = join(root, 'staging');
  await mkdir(repository, { recursive: true });
  git(repository, ['init']);
  git(repository, ['config', 'user.name', 'Test User']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repository, 'tracked.txt'), 'base\n', 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'base']);
  const previousRoot = process.env.AGENT_CLUSTER_WORKTREE_ROOT;
  process.env.AGENT_CLUSTER_WORKTREE_ROOT = staging;
  try {
    await callback({ root, repository, staging, bindings: new InvocationWorkspaceBindingsService() });
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_CLUSTER_WORKTREE_ROOT;
    else process.env.AGENT_CLUSTER_WORKTREE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

function plan(bindings: InvocationWorkspaceBindingsService, repository: string, patch: Partial<InvocationPlan> = {}) {
  const input = makeInvocationPlan({
    sessionId: 'session-a',
    taskId: 'task-a',
    phase: 'task_execution',
    executionTarget: {
      runtimeType: 'codex',
      workspaceProviderKind: 'server_local',
      writeMode: 'propose_changes',
      requiredCapabilities: ['read', 'write', 'command']
    },
    ...patch
  });
  bindings.bindSession({
    id: input.sessionId,
    workspaceId: input.contextEnvelope.workspaceId,
    workingDirectory: {
      kind: 'server_local',
      id: input.contextEnvelope.workspaceId,
      name: 'repository',
      path: repository,
      selectedAt: new Date().toISOString()
    }
  } as never);
  return input;
}

function completed(input: InvocationPlan): AgentRunResult {
  const proposal = createRuntimeArtifactOutput({
    type: 'code_diff',
    title: 'adapter changes',
    content: 'update tracked.txt',
    metadata: {
      validationEvidence: null,
      summaryMemoryCheckpoint: null,
      fileChanges: [{
        path: 'tracked.txt',
        operation: 'update',
        content: 'agent\n',
        previousContent: 'base\n',
        encoding: 'utf-8',
        source: 'runtime_proposed_change'
      }]
    }
  });
  return {
    invocationId: input.invocationId,
    runtimeType: input.executionTarget.runtimeType,
    status: 'completed',
    output: {
      schemaVersion: '1.0',
      kind: 'task_execution_result',
      status: 'completed',
      summary: 'done',
      completedItems: [],
      changedArtifacts: [proposal],
      requestedContext: null,
      agentMessages: [],
      nextSuggestedActions: [],
      risks: []
    },
    events: [],
    artifacts: [proposal],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'codex' }
  };
}

test('runs a task in an isolated worktree and captures an authoritative ChangeSet', async () => {
  await withRepository(async ({ repository, bindings }) => {
    await writeFile(join(repository, 'tracked.txt'), 'dirty baseline\n', 'utf8');
    await writeFile(join(repository, 'untracked.txt'), 'untracked baseline\n', 'utf8');
    const input = plan(bindings, repository);
    const service = new WorktreeExecutionService(bindings);
    const lease = await service.prepare(input);

    assert.notEqual(lease.manifest.executionWorkDir, repository);
    assert.equal(
      (await readFile(join(lease.manifest.executionWorkDir, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n'),
      'dirty baseline\n'
    );
    assert.equal(await readFile(join(lease.manifest.executionWorkDir, 'untracked.txt'), 'utf8'), 'untracked baseline\n');
    assert.equal(bindings.resolveServerRoot(input), lease.manifest.executionWorkDir);

    await writeFile(join(lease.manifest.executionWorkDir, 'tracked.txt'), 'agent update\n', 'utf8');
    await writeFile(join(lease.manifest.executionWorkDir, 'created.txt'), 'created by agent\n', 'utf8');
    const result = await service.capture(lease, completed(input));
    lease.release();

    assert.equal(await readFile(join(repository, 'tracked.txt'), 'utf8'), 'dirty baseline\n');
    assert.equal(result.workspaceExecution?.mode, 'git_worktree');
    assert.equal(result.systemEvidence.workspaceChangeSet?.id, result.workspaceExecution?.changeSet.id);
    assert.equal(result.artifacts.some((artifact) => artifact.title.includes('ChangeSet')), false);
    assert.equal(result.workspaceExecution?.dirtyBaseline, true);
    assert.deepEqual(
      result.workspaceExecution?.changeSet.changes.map((change) => [change.operation, 'path' in change ? change.path : change.toPath]),
      [['create', 'created.txt'], ['update', 'tracked.txt']]
    );
    const update = result.workspaceExecution?.changeSet.changes.find(
      (change) => change.operation === 'update' && change.path === 'tracked.txt'
    );
    assert.equal(update?.operation, 'update');
    if (!update || update.operation !== 'update') throw new Error('Expected tracked.txt update ChangeSet entry.');
    assert.equal(
      update.expectedHash.value,
      createHash('sha256').update(await readFile(join(repository, 'tracked.txt'))).digest('hex')
    );
    const changedArtifacts = result.output.kind === 'task_execution_result' ? result.output.changedArtifacts : [];
    const adapterChange = changedArtifacts[0]?.metadata?.fileChanges?.[0];
    assert.equal(adapterChange?.source, 'runtime_proposed_change');
    assert.ok(result.workspaceExecution?.changeSet.id);
    assert.equal(result.artifacts[0]?.metadata.fileChanges[0]?.source, 'runtime_proposed_change');
    assert.equal(bindings.resolveServerRoot(input), repository);
  });
});

test('creates separate worktrees for different sessions using the same repository', async () => {
  await withRepository(async ({ repository, bindings }) => {
    const service = new WorktreeExecutionService(bindings);
    const first = plan(bindings, repository, { sessionId: 'session-a', taskId: 'task-a', invocationId: 'invocation-a' });
    const second = plan(bindings, repository, { sessionId: 'session-b', taskId: 'task-b', invocationId: 'invocation-b' });
    const [firstLease, secondLease] = await Promise.all([service.prepare(first), service.prepare(second)]);
    assert.notEqual(firstLease.manifest.worktreeRoot, secondLease.manifest.worktreeRoot);
    assert.equal(firstLease.manifest.repositoryId, secondLease.manifest.repositoryId);
    firstLease.release();
    secondLease.release();
  });
});

test('deleting a Session removes its managed worktrees and manifests only', async () => {
  await withRepository(async ({ repository, staging, bindings }) => {
    const service = new WorktreeExecutionService(bindings);
    const first = plan(bindings, repository, { sessionId: 'session-a', taskId: 'task-a', invocationId: 'invocation-a' });
    const second = plan(bindings, repository, { sessionId: 'session-b', taskId: 'task-b', invocationId: 'invocation-b' });
    const firstLease = await service.prepare(first);
    const secondLease = await service.prepare(second);
    firstLease.release();
    secondLease.release();

    await service.deleteSessionDirectory('session-a');

    await assert.rejects(() => access(firstLease.manifest.worktreeRoot));
    await assert.rejects(() => access(join(staging, 'manifests', firstLease.manifest.worktreeRoot.split(/[\\/]/).at(-2)!)));
    await access(secondLease.manifest.worktreeRoot);
  });
});

test('uses an isolated staging copy when the selected server-local directory is not a Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-non-git-'));
  const staging = await mkdtemp(join(tmpdir(), 'agent-cluster-non-git-staging-'));
  const previousRoot = process.env.AGENT_CLUSTER_WORKTREE_ROOT;
  process.env.AGENT_CLUSTER_WORKTREE_ROOT = staging;
  try {
    await writeFile(join(root, 'source.txt'), 'base\n', 'utf8');
    const bindings = new InvocationWorkspaceBindingsService();
    const input = plan(bindings, root);
    const service = new WorktreeExecutionService(bindings);
    const lease = await service.prepare(input);
    assert.equal(lease.manifest.mode, 'staging_copy');
    assert.notEqual(lease.manifest.executionWorkDir, root);
    await writeFile(join(lease.manifest.executionWorkDir, 'source.txt'), 'agent\n', 'utf8');
    const result = await service.capture(lease, completed(input));
    assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'base\n');
    assert.equal(result.workspaceExecution?.mode, 'staging_copy');
    assert.equal(result.workspaceExecution?.changeSet.changes[0]?.operation, 'update');
    service.releaseWriteLease(result.workspaceExecution!.changeSet.id);
    lease.release();
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_CLUSTER_WORKTREE_ROOT;
    else process.env.AGENT_CLUSTER_WORKTREE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('supports a selected directory below the Git repository root', async () => {
  await withRepository(async ({ repository, bindings }) => {
    const nested = join(repository, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    const input = plan(bindings, nested);
    const service = new WorktreeExecutionService(bindings);
    const lease = await service.prepare(input);
    assert.equal(lease.manifest.mode, 'git_worktree');
    assert.match(lease.manifest.executionWorkDir.replace(/\\/g, '/'), /packages\/app$/);
    await writeFile(join(lease.manifest.executionWorkDir, 'nested.txt'), 'nested change\n', 'utf8');
    const result = await service.capture(lease, completed(input));
    assert.deepEqual(result.workspaceExecution?.changeSet.changes.map((change) =>
      change.operation === 'move' ? change.toPath : change.path
    ), ['nested.txt']);
    lease.release();
  });
});

test('resetTaskDirectory removes the old isolated baseline before an Agent conflict retry', async () => {
  await withRepository(async ({ repository, staging, bindings }) => {
    const input = plan(bindings, repository);
    const service = new WorktreeExecutionService(bindings);
    const lease = await service.prepare(input);
    const oldWorktree = lease.manifest.worktreeRoot;
    lease.release();

    await service.resetTaskDirectory(input.sessionId, input.taskId!);

    await assert.rejects(access(oldWorktree));
    const manifests = join(staging, 'manifests');
    const next = await service.prepare(input);
    assert.equal(next.manifest.mode, 'git_worktree');
    assert.equal(next.manifest.worktreeRoot, oldWorktree);
    assert.equal(await access(manifests).then(() => true, () => false), true);
    next.release();
  });
});

test('refuses to copy sensitive untracked files into a managed worktree', async () => {
  await withRepository(async ({ repository, bindings }) => {
    await writeFile(join(repository, 'secret-notes.txt'), 'do not expose\n', 'utf8');
    const input = plan(bindings, repository);
    await assert.rejects(
      () => new WorktreeExecutionService(bindings).prepare(input),
      /sensitive untracked paths/i
    );
  });
});

function git(cwd: string, args: string[]) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true });
}
