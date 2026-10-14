import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateRefPrefix, captureGitTaskCandidate } from './git-task-candidate.js';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args]);
}

test('Git candidate preserves binary changes in a private worktree without changing its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-candidate-'));
  const repository = join(root, 'repository');
  const worktree = join(root, 'task');
  try {
    await mkdir(repository);
    git(repository, 'init');
    git(repository, 'config', 'user.name', 'Test User');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', 'base');
    const baseCommit = git(repository, 'rev-parse', 'HEAD').toString('utf8').trim();
    git(repository, 'worktree', 'add', '--detach', worktree, baseCommit);
    await writeFile(join(worktree, 'binary.dat'), Buffer.from([0, 3, 4, 255]));
    await writeFile(join(worktree, 'created.txt'), 'candidate\n');

    const candidate = await captureGitTaskCandidate({
      worktreePath: worktree, sessionId: 'session-a', taskId: 'task-a', baseCommit
    });
    assert.ok(candidate);
    assert.ok(candidate.ref.length <= 70);
    assert.deepEqual(candidate.changedPaths, ['binary.dat', 'created.txt']);
    assert.deepEqual(git(repository, 'show', `${candidate.ref}:binary.dat`), Buffer.from([0, 3, 4, 255]));
    assert.deepEqual(await readFile(join(repository, 'binary.dat')), Buffer.from([0, 1, 2, 255]));
    assert.equal(git(repository, 'rev-parse', candidate.ref).toString('utf8').trim(), candidate.treeSha);
    assert.equal(await captureGitTaskCandidate({ worktreePath: repository, sessionId: 'session-a',
      taskId: 'task-b', baseCommit }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git candidate rejects sensitive changed paths before creating a durable ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-candidate-denied-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.name', 'Test User');
    git(root, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'README.md'), 'base\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'base');
    const baseCommit = git(root, 'rev-parse', 'HEAD').toString('utf8').trim();
    await writeFile(join(root, '.env'), 'TOKEN=secret');
    await assert.rejects(captureGitTaskCandidate({ worktreePath: root,
      sessionId: 'session-a', taskId: 'task-a', baseCommit }), /GITHUB_CANDIDATE_PATH_DENIED/);
    assert.equal(git(root, 'for-each-ref', '--format=%(refname)',
      candidateRefPrefix('session-a')).toString('utf8').trim(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
