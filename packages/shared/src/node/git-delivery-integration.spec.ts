import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGitTaskCandidate } from './git-task-candidate.js';
import { integrateGitTaskCandidates } from './git-delivery-integration.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('controlled integration uses captured binary tree and excludes later task and source edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-delivery-integration-'));
  const source = join(root, 'source');
  const task = join(root, 'task');
  const delivery = join(root, 'delivery');
  try {
    await mkdir(source);
    git(source, 'init');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    git(source, 'config', 'core.autocrlf', 'false');
    await writeFile(join(source, 'binary.dat'), Buffer.from([0, 1, 255]));
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    const baseCommit = git(source, 'rev-parse', 'HEAD');
    git(source, 'worktree', 'add', '--detach', task, baseCommit);
    git(source, 'worktree', 'add', '--detach', delivery, baseCommit);
    await writeFile(join(task, 'binary.dat'), Buffer.from([0, 2, 255]));
    const candidate = await captureGitTaskCandidate({ worktreePath: task,
      sessionId: 'session-a', taskId: 'task-a', baseCommit });
    assert.ok(candidate);
    await writeFile(join(task, 'binary.dat'), Buffer.from([0, 3, 255]));
    await writeFile(join(source, 'outside.txt'), 'external');

    const integrated = await integrateGitTaskCandidates({ worktreePath: delivery,
      sessionId: 'session-a', baseCommit, candidates: [candidate] });
    assert.deepEqual(integrated.conflicts, []);
    assert.deepEqual(integrated.changedPaths, ['binary.dat']);
    assert.deepEqual(await readFile(join(delivery, 'binary.dat')), Buffer.from([0, 2, 255]));
    assert.equal(git(delivery, 'ls-files', '--others', '--exclude-standard'), '');
    assert.equal(git(delivery, 'rev-parse', 'HEAD'), baseCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('controlled integration rejects altered candidate metadata before applying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-delivery-mismatch-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, 'README.md'), 'base\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'base');
    const baseCommit = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'README.md'), 'new\n');
    const candidate = await captureGitTaskCandidate({ worktreePath: root,
      sessionId: 'session-a', taskId: 'task-a', baseCommit });
    assert.ok(candidate);
    await assert.rejects(integrateGitTaskCandidates({ worktreePath: root,
      sessionId: 'session-a', baseCommit,
      candidates: [{ ...candidate, changedPaths: ['unrelated.txt'] }] }),
    /GITHUB_CANDIDATE_MANIFEST_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('overlapping task candidates report every unmerged path without producing a delivery tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-delivery-conflict-'));
  const source = join(root, 'source');
  const firstTask = join(root, 'first');
  const secondTask = join(root, 'second');
  const delivery = join(root, 'delivery');
  try {
    await mkdir(source);
    git(source, 'init');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    git(source, 'config', 'core.autocrlf', 'false');
    await writeFile(join(source, 'a.txt'), 'base\n');
    await writeFile(join(source, 'b.txt'), 'base\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    const baseCommit = git(source, 'rev-parse', 'HEAD');
    for (const path of [firstTask, secondTask, delivery]) {
      git(source, 'worktree', 'add', '--detach', path, baseCommit);
    }
    for (const file of ['a.txt', 'b.txt']) {
      await writeFile(join(firstTask, file), 'first\n');
      await writeFile(join(secondTask, file), 'second\n');
    }
    const first = await captureGitTaskCandidate({ worktreePath: firstTask,
      sessionId: 'session-a', taskId: 'task-a', baseCommit });
    const second = await captureGitTaskCandidate({ worktreePath: secondTask,
      sessionId: 'session-a', taskId: 'task-b', baseCommit });
    assert.ok(first && second);
    const integrated = await integrateGitTaskCandidates({ worktreePath: delivery,
      sessionId: 'session-a', baseCommit, candidates: [first, second] });
    assert.equal(integrated.treeSha, undefined);
    assert.deepEqual(integrated.conflicts, ['a.txt', 'b.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
