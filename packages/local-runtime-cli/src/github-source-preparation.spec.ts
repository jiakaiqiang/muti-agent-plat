import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitRepositoryWorkspaceManager } from '@agent-cluster/shared/node/repository-workspace-manager';
import { LocalGitHubAuthorizationStore } from './github-authorization-store.js';
import { LocalGitHubSourcePreparer } from './github-source-preparation.js';
import { defaultState } from './state.js';
import { LocalWorkspace } from './workspace.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();

test('local GitHub source uses a device worktree and exposes real remote branches before selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-local-github-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const repositoryUrl = 'https://github.com/example/project';
  const state = defaultState();
  const secrets = new Map<string, string>();
  const workspaces = new Map<string, LocalWorkspace>();
  try {
    execFileSync('git', ['init', '-b', 'develop', source], { windowsHide: true });
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.test');
    await writeFile(join(source, 'README.md'), 'base\n');
    git(source, 'add', 'README.md');
    git(source, 'commit', '-m', 'fixture');
    git(source, 'branch', 'feature');
    execFileSync('git', ['clone', '--bare', source, remote], { windowsHide: true });
    const auth = new LocalGitHubAuthorizationStore(state, {
      async set(id, value) { secrets.set(id, value); },
      async get(id) { return secrets.get(id); },
      async delete(id) { secrets.delete(id); }
    }, (async (url: string) => url.endsWith('/user')
      ? Response.json({ id: 42, login: 'octocat' })
      : Response.json({ id: 73, default_branch: 'develop', permissions: { push: true } })) as typeof fetch,
    async () => undefined);
    const authorization = await auth.savePat('fixture-token', repositoryUrl);
    const manager = new GitRepositoryWorkspaceManager(join(root, 'managed'), () => remote);
    const preparer = new LocalGitHubSourcePreparer(state, auth, manager, workspaces,
      async () => undefined);
    const prepared = await preparer.handle({ requestId: 'prepare-1', action: 'prepare',
      sessionId, repositoryUrl, authorizationId: authorization.id });
    assert.equal(prepared.status, 'ok');
    assert.equal(prepared.defaultBranch, 'develop');
    assert.equal(prepared.repositoryId, '73');
    assert.equal(prepared.workspace?.workspaceId, `github-session:${sessionId}`);
    assert.equal(await readFile(join(manager.sessionWorkspacePath(sessionId), 'README.md'), 'utf8'), 'base\n');
    assert.equal(JSON.stringify(prepared).includes('fixture-token'), false);
    assert.equal(JSON.stringify(state).includes('fixture-token'), false);
    const branches = await preparer.handle({ requestId: 'branches-1', action: 'branches', sessionId });
    assert.deepEqual(branches.branches?.map((branch) => branch.name).sort(), ['develop', 'feature']);
    const selected = await preparer.handle({ requestId: 'select-1', action: 'select_branch',
      sessionId, baseBranch: 'feature' });
    assert.match(selected.baseSha ?? '', /^[a-f0-9]{40}$/);
    assert.equal(state.workspaces.length, 1);
    const cleaned = await preparer.handle({ requestId: 'cleanup-1', action: 'cleanup', sessionId });
    assert.equal(cleaned.status, 'ok');
    assert.equal(state.workspaces.length, 0);
    assert.equal(workspaces.size, 0);
    assert.equal(state.githubAuthorizations?.[0]?.state, 'active');
    assert.equal(await readFile(join(root, 'managed', 'cache', prepared.cacheKey!, 'HEAD'), 'utf8')
      .then((content) => content.length > 0), true);
    assert.equal(await readFile(join(manager.sessionWorkspacePath(sessionId), 'README.md')).then(
      () => true, () => false), false);
  } finally {
    for (const workspace of workspaces.values()) workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
