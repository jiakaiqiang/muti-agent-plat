import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepositoryWorkspaceManager } from './repository-workspace-manager.js';
import { candidateRefPrefix, captureGitTaskCandidate } from '@agent-cluster/shared/node/git-task-candidate';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('repository cache is shared while Session worktrees and cleanup stay isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-github-workspaces-'));
  try {
    const source = join(root, 'source');
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '-b', 'develop', source], { windowsHide: true });
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.test');
    await writeFile(join(source, '.gitattributes'), '* text eol=lf\n');
    await writeFile(join(source, 'README.md'), 'base\n');
    git(source, 'add', '.gitattributes', 'README.md');
    git(source, 'commit', '-m', 'fixture');
    git(source, 'branch', 'feature');
    execFileSync('git', ['clone', '--bare', source, remote], { windowsHide: true });

    const manager = new GitRepositoryWorkspaceManager(join(root, 'managed'),
      () => remote);
    const [first, second] = await Promise.all([
      manager.prepare('11111111-1111-4111-8111-111111111111',
        '42', 'https://github.com/example/project', '73', 'test-token', 'develop'),
      manager.prepare('22222222-2222-4222-8222-222222222222',
        '42', 'https://github.com/example/project', '73', 'test-token', 'develop')
    ]);
    assert.equal(first.cacheKey, second.cacheKey);
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.equal(await readFile(join(first.workspacePath, 'README.md'), 'utf8'), 'base\n');
    await writeFile(join(first.workspacePath, 'session-only.txt'), 'private');
    assert.equal((await readdir(second.workspacePath)).includes('session-only.txt'), false);
    assert.equal(git(first.workspacePath, 'remote', 'get-url', 'origin').includes('test-token'), false);
    assert.deepEqual((await manager.listBranches(first.sessionId)).map((branch) => branch.name).sort(),
      ['develop', 'feature']);
    await assert.rejects(manager.selectBaseBranch(first.sessionId, 'feature'),
      /GITHUB_BASE_BRANCH_WORKSPACE_DIRTY/);
    await rm(join(first.workspacePath, 'session-only.txt'));
    const selected = await manager.selectBaseBranch(first.sessionId, 'feature');
    assert.match(selected.baseSha, /^[a-f0-9]{40}$/);
    const deliveryPath = await manager.prepareDelivery(first.sessionId, selected.baseSha);
    assert.equal(await readFile(join(deliveryPath, 'README.md'), 'utf8'), 'base\n');
    await writeFile(join(deliveryPath, 'stale.txt'), 'old candidate');
    assert.equal(await manager.prepareDelivery(first.sessionId, selected.baseSha, true), deliveryPath);
    assert.equal((await readdir(deliveryPath)).includes('stale.txt'), false);
    const task = await manager.prepareTask(first.sessionId, '33333333-3333-4333-8333-333333333333');
    assert.equal(task.baseCommit, selected.baseSha);
    assert.equal(await readFile(join(task.workspacePath, 'README.md'), 'utf8'), 'base\n');
    await writeFile(join(first.workspacePath, 'outside-change.txt'), 'not part of task');
    assert.equal((await readdir(task.workspacePath)).includes('outside-change.txt'), false);
    const resumedTask = await manager.prepareTask(first.sessionId, '33333333-3333-4333-8333-333333333333');
    assert.equal(resumedTask.workspacePath, task.workspacePath);
    await writeFile(join(task.workspacePath, 'candidate.bin'), Buffer.from([0, 1, 255]));
    const candidate = await captureGitTaskCandidate({ worktreePath: task.workspacePath,
      sessionId: first.sessionId, taskId: '33333333-3333-4333-8333-333333333333',
      baseCommit: task.baseCommit });
    assert.ok(candidate);
    await manager.cleanupSession(first.sessionId);
    assert.equal((await readdir(join(root, 'managed', 'sessions'))).includes(first.sessionId), false);
    assert.equal((await readdir(join(root, 'managed', 'tasks'))).includes(first.sessionId), false);
    assert.equal((await readdir(join(root, 'managed', 'deliveries'))).includes(first.sessionId), false);
    assert.equal(git(second.workspacePath, 'for-each-ref', '--format=%(refname)',
      candidateRefPrefix(first.sessionId)).trim(), '');
    assert.equal(await readFile(join(second.workspacePath, 'README.md'), 'utf8'), 'base\n');
    assert.equal((await readdir(join(root, 'managed', 'cache'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
