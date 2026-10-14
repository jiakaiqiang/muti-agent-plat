import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishGitDelivery, taskBranchForDelivery } from './git-delivery-publisher.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('publishes only the validated tree and rejects a changed remote head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-publisher-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(source, 'README.md'), 'base\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    git(source, 'clone', '--bare', source, remote);
    git(source, 'remote', 'add', 'origin', remote);
    const baseSha = git(source, 'rev-parse', 'HEAD');
    await writeFile(join(source, 'README.md'), 'delivered\n');
    git(source, 'add', '-A');
    const treeSha = git(source, 'write-tree');
    const input = { worktreePath: source, repositoryUrl: 'https://github.com/example/project',
      sessionId, round: 1, baseSha, treeSha, accountId: '42', accountLogin: 'octocat',
      token: 'fixture-token' };
    const first = await publishGitDelivery(input);
    assert.equal(first.outcome, 'published');
    if (first.outcome !== 'published') throw new Error('Expected publication');
    assert.equal(first.taskBranch, taskBranchForDelivery(sessionId, 1));
    assert.equal(git(remote, 'rev-parse', `refs/heads/${first.taskBranch}`), first.commitSha);
    assert.equal(git(remote, 'show', '-s', '--format=%ae', first.commitSha),
      '42+octocat@users.noreply.github.com');
    assert.match(git(remote, 'show', '-s', '--format=%B', first.commitSha),
      /Agent-Cluster-Session:/);
    const recovered = await publishGitDelivery(input);
    assert.equal(recovered.outcome, 'published');
    if (recovered.outcome !== 'published') throw new Error('Expected recovery');
    assert.equal(recovered.commitSha, first.commitSha);
    const recoveredUpdate = await publishGitDelivery({ ...input,
      previousCommitSha: baseSha });
    assert.equal(recoveredUpdate.outcome, 'published');
    if (recoveredUpdate.outcome !== 'published') throw new Error('Expected update recovery');
    assert.equal(recoveredUpdate.commitSha, first.commitSha);
    await writeFile(join(source, 'README.md'), 'changed after validation\n');
    git(source, 'add', '-A');
    await assert.rejects(publishGitDelivery({ ...input, previousCommitSha: first.commitSha }),
      /GITHUB_VALIDATION_CANDIDATE_CHANGED/);
    git(source, 'reset', '--hard', baseSha);
    await writeFile(join(source, 'README.md'), 'restored delivery\n');
    git(source, 'add', '-A');
    git(remote, 'update-ref', '-d', `refs/heads/${first.taskBranch}`);
    const restored = await publishGitDelivery({ ...input,
      treeSha: git(source, 'write-tree'), previousCommitSha: first.commitSha });
    assert.equal(restored.outcome, 'published');
    if (restored.outcome !== 'published') throw new Error('Expected branch restoration');
    assert.equal(git(remote, 'rev-parse', `refs/heads/${first.taskBranch}`), restored.commitSha);
    git(source, 'merge-base', '--is-ancestor', first.commitSha, restored.commitSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a normal remote advancement returns a new integration candidate without pushing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-publisher-advance-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(source, 'README.md'), 'base\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    git(source, 'clone', '--bare', source, remote);
    git(source, 'remote', 'add', 'origin', remote);
    const baseSha = git(source, 'rev-parse', 'HEAD');
    await writeFile(join(source, 'README.md'), 'first\n');
    git(source, 'add', '-A');
    const identity = { worktreePath: source, repositoryUrl: 'https://github.com/example/project',
      sessionId, round: 1, baseSha, accountId: '42', accountLogin: 'octocat', token: 'fixture-token' };
    const first = await publishGitDelivery({ ...identity, treeSha: git(source, 'write-tree') });
    assert.equal(first.outcome, 'published');
    if (first.outcome !== 'published') throw new Error('Expected publication');
    git(source, 'reset', '--hard', first.commitSha);
    await writeFile(join(source, 'outside.txt'), 'remote addition\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'external edit');
    git(source, 'push', 'origin', `HEAD:refs/heads/${first.taskBranch}`);
    const advancedHead = git(remote, 'rev-parse', `refs/heads/${first.taskBranch}`);
    git(source, 'reset', '--hard', baseSha);
    await writeFile(join(source, 'README.md'), 'second\n');
    git(source, 'add', '-A');
    const changed = await publishGitDelivery({ ...identity, treeSha: git(source, 'write-tree'),
      previousCommitSha: first.commitSha });
    assert.equal(changed.outcome, 'remote_changed');
    if (changed.outcome !== 'remote_changed') throw new Error('Expected integration');
    assert.equal(changed.remoteHeadSha, advancedHead);
    assert.equal(git(remote, 'rev-parse', `refs/heads/${first.taskBranch}`), advancedHead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
