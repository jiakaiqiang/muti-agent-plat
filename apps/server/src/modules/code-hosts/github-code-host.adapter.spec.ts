import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCodeHostAdapter } from './github-code-host.adapter.js';
import { normalizeGitHubRepositoryUrl } from './github-repository-url.js';

test('GitHub adapter checks identity, write access and the actual default branch', async () => {
  const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect }> = [];
  const adapter = new GitHubCodeHostAdapter();
  (adapter as any).request = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get('authorization'), redirect: init.redirect! });
    if (url.endsWith('/user')) return Response.json({ id: 42, login: 'octocat', name: 'Octo Cat', email: 'octo@example.com' });
    if (url.endsWith('/repos/example/project')) return Response.json({
      id: 73, default_branch: 'develop', permissions: { pull: true, push: true }
    });
    return Response.json([{ name: 'develop', commit: { sha: 'a'.repeat(40) } }]);
  };
  const repository = normalizeGitHubRepositoryUrl('https://github.com/example/project');
  assert.equal((await adapter.identify('secret')).login, 'octocat');
  assert.equal((await adapter.inspectRepository('secret', repository)).defaultBranch, 'develop');
  assert.deepEqual((await adapter.listBranches('secret', repository)).map((branch) => branch.name), ['develop']);
  assert.equal(calls.every((call) => call.authorization === 'Bearer secret' && call.redirect === 'manual'), true);
  assert.equal(calls.every((call) => !call.url.includes('secret')), true);
});

test('GitHub adapter rejects missing write permission and never echoes response secrets', async () => {
  const adapter = new GitHubCodeHostAdapter();
  (adapter as any).request = async () => Response.json({
    id: 73, default_branch: 'main', permissions: { pull: true, push: false }
  });
  await assert.rejects(adapter.inspectRepository('secret', normalizeGitHubRepositoryUrl('https://github.com/a/b')),
    /GITHUB_REPOSITORY_WRITE_REQUIRED/);
  (adapter as any).request = async () => new Response('secret-from-github', { status: 401 });
  await assert.rejects(adapter.identify('secret'), (error: unknown) => {
    assert.equal(String(error).includes('secret'), false);
    return true;
  });
  (adapter as any).request = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
  await assert.rejects(adapter.identify('secret'), /GITHUB_API_HTTP_302/);
});
