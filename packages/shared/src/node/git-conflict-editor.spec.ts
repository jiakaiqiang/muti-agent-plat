import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitConflictEditor } from './git-conflict-editor.js';
import { GitRepositoryWorkspaceManager } from './repository-workspace-manager.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('all Git conflicts remain available as versioned drafts until confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-conflict-editor-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    git(source, 'config', 'core.autocrlf', 'false');
    await writeFile(join(source, 'a.txt'), 'base\n');
    await writeFile(join(source, 'b.txt'), 'base\n');
    await writeFile(join(source, 'c.bin'), Buffer.alloc(5 * 1024 * 1024));
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    git(source, 'clone', '--bare', source, remote);
    git(source, 'remote', 'add', 'origin', remote);
    const manager = new GitRepositoryWorkspaceManager(join(root, 'managed'), () => remote);
    await manager.prepare(sessionId, '42', 'https://github.com/example/project', '73',
      'fixture-token', 'main');
    git(source, 'checkout', '-b', 'feature');
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(source, name), 'ours\n');
    await writeFile(join(source, 'c.bin'), Buffer.alloc(5 * 1024 * 1024, 1));
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'feature');
    const headSha = git(source, 'rev-parse', 'HEAD');
    git(source, 'push', 'origin', 'feature');
    git(source, 'checkout', 'main');
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(source, name), 'theirs\n');
    await writeFile(join(source, 'c.bin'), Buffer.alloc(5 * 1024 * 1024, 2));
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'main advanced');
    git(source, 'push', 'origin', 'main');
    await manager.prepare(sessionId, '42', 'https://github.com/example/project', '73',
      'fixture-token', 'main');
    const editor = new GitConflictEditor(manager);
    const started = await editor.start({ sessionId, round: 1, headSha,
      baseBranch: 'main', token: 'fixture-token', targetOperation: 'merge_pull_request' })
      .catch((error: Error & { cause?: unknown }) => {
        throw new Error(`Conflict start failed at ${String(error.cause)}`, { cause: error });
      });
    assert.deepEqual(started.view?.files.map((file) => file.path), ['a.txt', 'b.txt', 'c.bin']);
    assert.equal(started.view?.files[0].kind, 'text');
    assert.equal(started.view?.files[2].kind, 'binary');
    const id = started.view!.id;
    const repeated = await editor.start({ sessionId, round: 1, headSha,
      baseBranch: 'main', token: 'fixture-token', targetOperation: 'merge_pull_request' });
    assert.equal(repeated.view?.id, id);
    const draft = await editor.saveFile({ sessionId, conflictId: id,
      fileId: started.view!.files[0].fileId, expectedVersion: 1,
      resultContent: 'resolved a\n', confirm: false });
    assert.equal((await editor.view(sessionId, id)).files[0].resultContent, 'resolved a\n');
    await assert.rejects(editor.complete(sessionId, id, 1),
      /GITHUB_CONFLICT_VERSION_CONFLICT/);
    const concurrent = await Promise.allSettled([
      editor.saveFile({ sessionId, conflictId: id, fileId: draft.files[0].fileId,
        expectedVersion: draft.version, resultContent: 'first concurrent draft\n', confirm: false }),
      editor.saveFile({ sessionId, conflictId: id, fileId: draft.files[1].fileId,
        expectedVersion: draft.version, resultContent: 'second concurrent draft\n', confirm: false })
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
    const latest = await editor.view(sessionId, id);
    assert.equal(latest.version, draft.version + 1);
    await assert.rejects(editor.saveFile({ sessionId, conflictId: id,
      fileId: started.view!.files[0].fileId, expectedVersion: 1,
      resultContent: 'stale', confirm: true }), /GITHUB_CONFLICT_VERSION_CONFLICT/);
    const first = await editor.saveFile({ sessionId, conflictId: id,
      fileId: draft.files[0].fileId, expectedVersion: latest.version,
      resultContent: 'resolved a\n', confirm: true });
    const second = await editor.saveFile({ sessionId, conflictId: id,
      fileId: first.files[1].fileId, expectedVersion: first.version,
      resultContent: 'resolved b\n', confirm: true });
    const third = await editor.saveFile({ sessionId, conflictId: id,
      fileId: second.files[2].fileId, expectedVersion: second.version,
      binaryChoice: 'ours', confirm: true });
    assert.match(await editor.complete(sessionId, id, third.version), /^[a-f0-9]{40}$/);
    assert.equal(git(manager.deliveryWorkspacePath(sessionId), 'ls-files', '--unmerged'), '');
    git(source, 'checkout', 'main');
    await writeFile(join(source, 'a.txt'), 'new target revision\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'main advanced again');
    git(source, 'push', 'origin', 'main');
    const restarted = await editor.start({ sessionId, round: 1, headSha,
      baseBranch: 'main', token: 'fixture-token', targetOperation: 'merge_pull_request' });
    assert.notEqual(restarted.view?.id, id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rename conflicts are listed as typed decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-rename-conflict-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(source, 'original.txt'), 'shared content\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-m', 'base');
    git(source, 'clone', '--bare', source, remote);
    git(source, 'remote', 'add', 'origin', remote);
    const manager = new GitRepositoryWorkspaceManager(join(root, 'managed'), () => remote);
    await manager.prepare(sessionId, '42', 'https://github.com/example/project', '73',
      'fixture-token', 'main');
    git(source, 'checkout', '-b', 'feature');
    git(source, 'mv', 'original.txt', 'ours.txt');
    git(source, 'commit', '-m', 'rename ours');
    const headSha = git(source, 'rev-parse', 'HEAD');
    git(source, 'push', 'origin', 'feature');
    git(source, 'checkout', 'main');
    git(source, 'mv', 'original.txt', 'theirs.txt');
    git(source, 'commit', '-m', 'rename theirs');
    git(source, 'push', 'origin', 'main');
    await manager.prepare(sessionId, '42', 'https://github.com/example/project', '73',
      'fixture-token', 'main');
    const editor = new GitConflictEditor(manager);
    const started = await editor.start({ sessionId, round: 1, headSha,
      baseBranch: 'main', token: 'fixture-token', targetOperation: 'merge_pull_request' })
      .catch((error: Error & { cause?: unknown }) => {
        throw new Error(`Rename conflict start failed at ${String(error.cause)}`, { cause: error });
      });
    assert.ok(started.view?.files.length);
    assert.ok(started.view!.files.some((file) => file.kind === 'renamed'),
      JSON.stringify(started.view!.files.map((file) => ({ path: file.path, kind: file.kind }))));
    let view = started.view!;
    for (const file of view.files) {
      view = await editor.saveFile({ sessionId, conflictId: view.id, fileId: file.fileId,
        expectedVersion: view.version, binaryChoice: 'ours', confirm: true });
    }
    assert.match(await editor.complete(sessionId, view.id, view.version), /^[a-f0-9]{40}$/);
    assert.deepEqual(git(manager.deliveryWorkspacePath(sessionId), 'ls-files').split('\n'),
      ['ours.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
