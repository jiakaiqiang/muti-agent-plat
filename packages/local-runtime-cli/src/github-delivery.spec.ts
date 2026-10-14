import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepositoryWorkspaceManager } from '@agent-cluster/shared/node/repository-workspace-manager';
import { captureGitTaskCandidate } from '@agent-cluster/shared/node/git-task-candidate';
import { LocalGitHubDelivery } from './github-delivery.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('device delivery validates captured tree and does not use a changed Session source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-github-delivery-'));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const taskId = '22222222-2222-4222-8222-222222222222';
  try {
    const source = join(root, 'source');
    const remote = join(root, 'remote.git');
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(source, 'binary.dat'), Buffer.from([0, 1, 255]));
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    execFileSync('git', ['clone', '--bare', source, remote], { windowsHide: true });
    const manager = new GitRepositoryWorkspaceManager(join(root, 'managed'), () => remote);
    const prepared = await manager.prepare(sessionId, '42',
      'https://github.com/example/project', '73', 'fixture-token', 'main');
    const task = await manager.prepareTask(sessionId, taskId);
    await writeFile(join(task.workspacePath, 'binary.dat'), Buffer.from([0, 2, 255]));
    const candidate = await captureGitTaskCandidate({ worktreePath: task.workspacePath,
      sessionId, taskId, baseCommit: prepared.baseSha });
    assert.ok(candidate);
    await writeFile(join(prepared.workspacePath, 'outside.txt'), 'external');
    const delivery = new LocalGitHubDelivery(manager);
    const result = await delivery.handle({ requestId: 'one', action: 'integrate_validate',
      sessionId, baseSha: prepared.baseSha, round: 1, candidates: [candidate],
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], relativeCwd: '.' } });
    assert.equal(result.status, 'ok');
    assert.equal(result.outcome, 'validated');
    assert.equal(result.validation?.exitCode, 0);
    assert.deepEqual(result.changedPaths, ['binary.dat']);
    const revalidated = await delivery.handle({ requestId: 'revalidate', action: 'validate',
      sessionId, treeSha: result.treeSha!, comparisonSha: prepared.baseSha,
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], relativeCwd: '.' } });
    assert.equal(revalidated.outcome, 'validated');
    assert.deepEqual(revalidated.changedPaths, ['binary.dat']);
    const stale = await delivery.handle({ requestId: 'two', action: 'validate',
      sessionId, treeSha: 'a'.repeat(40), comparisonSha: prepared.baseSha,
      command: { program: process.execPath, args: ['-e', 'process.exit(0)'], relativeCwd: '.' } });
    assert.equal(stale.error?.code, 'GITHUB_VALIDATION_CANDIDATE_CHANGED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
