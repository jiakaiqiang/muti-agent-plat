import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from './state.js';
import { LocalGitHubAuthorizationStore } from './github-authorization-store.js';
import { handleLocalGitHubAuthorizationRequest } from './github-authorization-store.js';

test('local GitHub PAT stays in the device secret store while metadata is reusable', async () => {
  const state = defaultState();
  const secrets = new Map<string, string>();
  const persisted: string[] = [];
  const urls: string[] = [];
  const store = new LocalGitHubAuthorizationStore(state, {
    async set(id, value) { secrets.set(id, value); },
    async get(id) { return secrets.get(id); },
    async delete(id) { secrets.delete(id); }
  }, (async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-token');
    if (url.endsWith('/user')) return Response.json({ id: 42, login: 'octocat' });
    return Response.json({ id: 73, default_branch: 'develop', permissions: { push: true } });
  }) as typeof fetch, async (value) => { persisted.push(JSON.stringify(value)); });
  const first = await store.savePat('fixture-token', 'https://github.com/Example/Project.git');
  assert.equal(first.repositoryUrl, 'https://github.com/example/project');
  assert.equal(first.deviceId, state.deviceId);
  assert.equal(persisted.every((value) => !value.includes('fixture-token')), true);
  assert.equal(JSON.stringify(state).includes('fixture-token'), false);
  assert.equal(secrets.get(`github:${first.id}`), 'fixture-token');
  const reusable = await store.reusable('https://github.com/example/project');
  assert.equal(reusable?.id, first.id);
  assert.equal(await store.withToken(first.id, first.repositoryUrl, async (token) => token), 'fixture-token');
  assert.deepEqual(await store.inspectRepository(first.id, first.repositoryUrl), {
    accountId: '42', repositoryId: '73', defaultBranch: 'develop'
  });
  assert.equal(urls.every((url) => !url.includes('fixture-token')), true);
  await store.disconnect(first.id);
  assert.equal(await store.reusable(first.repositoryUrl), undefined);
  assert.equal(secrets.has(`github:${first.id}`), false);
});

test('local GitHub PAT with no write permission is not stored', async () => {
  const state = defaultState();
  let saved = false;
  const store = new LocalGitHubAuthorizationStore(state, {
    async set() { saved = true; }, async get() { return undefined; }, async delete() {}
  }, (async (url: string) => url.endsWith('/user')
    ? Response.json({ id: 42, login: 'octocat' })
    : Response.json({ id: 73, permissions: { push: false } })) as typeof fetch,
  async () => undefined);
  await assert.rejects(store.savePat('fixture-token', 'https://github.com/example/project'),
    /GITHUB_REPOSITORY_WRITE_REQUIRED/);
  assert.equal(saved, false);
  assert.equal(state.githubAuthorizations, undefined);
});

test('device authorization protocol returns metadata without echoing a PAT', async () => {
  const state = defaultState();
  const token = 'fixture-secret-token';
  const secrets = new Map<string, string>();
  const store = new LocalGitHubAuthorizationStore(state, {
    async set(id, value) { secrets.set(id, value); },
    async get(id) { return secrets.get(id); },
    async delete(id) { secrets.delete(id); }
  }, (async (url: string) => url.endsWith('/user')
    ? Response.json({ id: 42, login: 'octocat' })
    : Response.json({ id: 73, permissions: { push: true } })) as typeof fetch,
  async () => undefined);
  const repositoryUrl = 'https://github.com/example/project';
  const saved = await handleLocalGitHubAuthorizationRequest({
    requestId: 'request-1', action: 'save_pat', repositoryUrl, token
  }, store);
  assert.equal(saved.status, 'ok');
  assert.equal(saved.authorization?.deviceId, state.deviceId);
  assert.equal(JSON.stringify(saved).includes(token), false);
  const reused = await handleLocalGitHubAuthorizationRequest({
    requestId: 'request-2', action: 'find_reusable', repositoryUrl
  }, store);
  assert.equal(reused.authorization?.id, saved.authorization?.id);
  const disconnected = await handleLocalGitHubAuthorizationRequest({
    requestId: 'request-3', action: 'disconnect', repositoryUrl,
    authorizationId: saved.authorization!.id
  }, store);
  assert.equal(disconnected.authorization?.state, 'disconnected');
  assert.equal(secrets.size, 0);
  assert.equal((await handleLocalGitHubAuthorizationRequest({
    requestId: 'request-4', action: 'find_reusable', repositoryUrl
  }, store)).authorization, undefined);
});

test('device authorization protocol exposes only stable failure codes', async () => {
  const store = { async savePat() { throw new Error('secret from upstream'); } };
  const result = await handleLocalGitHubAuthorizationRequest({
    requestId: 'request-failed', action: 'save_pat',
    repositoryUrl: 'https://github.com/example/project', token: 'fixture-secret-token'
  }, store as never);
  assert.deepEqual(result.error, { code: 'GITHUB_AUTHORIZATION_FAILED' });
  assert.equal(JSON.stringify(result).includes('secret from upstream'), false);
});

test('local OAuth access token is reusable only until its expiry', async () => {
  const state = defaultState();
  const secrets = new Map<string, string>();
  const store = new LocalGitHubAuthorizationStore(state, {
    async set(id, value) { secrets.set(id, value); },
    async get(id) { return secrets.get(id); },
    async delete(id) { secrets.delete(id); }
  }, (async (url: string) => url.endsWith('/user')
    ? Response.json({ id: 42, login: 'octocat' })
    : Response.json({ id: 73, permissions: { push: true } })) as typeof fetch,
  async () => undefined);
  const repositoryUrl = 'https://github.com/example/project';
  const authorization = await store.saveOAuth('local-oauth-secret', repositoryUrl,
    new Date(Date.now() + 120_000).toISOString());
  assert.equal(authorization.kind, 'github_app');
  assert.equal((await store.reusable(repositoryUrl))?.id, authorization.id);
  assert.equal(JSON.stringify(state).includes('local-oauth-secret'), false);
  authorization.expiresAt = new Date(Date.now() - 1000).toISOString();
  state.githubAuthorizations![0].expiresAt = authorization.expiresAt;
  assert.equal(await store.reusable(repositoryUrl), undefined);
  await assert.rejects(store.withToken(authorization.id, repositoryUrl, async (token) => token),
    /GITHUB_AUTHORIZATION_EXPIRED/);
});
