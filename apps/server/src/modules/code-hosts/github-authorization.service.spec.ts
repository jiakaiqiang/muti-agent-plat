import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAuthorizationService } from './github-authorization.service.js';
import { GitHubCodeHostAdapter } from './github-code-host.adapter.js';

function fixture() {
  const state: Record<string, unknown> = {};
  const persistence = {
    getCollection<T>(key: string, fallback: T): T { return structuredClone((state[key] ?? fallback) as T); },
    async setCollection<T>(key: string, value: T) { state[key] = structuredClone(value); return true; },
    async compareAndSetCollection<T>(key: string, expected: T, value: T) {
      if (JSON.stringify(state[key] ?? []) !== JSON.stringify(expected)) return { status: 'conflict' as const };
      state[key] = structuredClone(value);
      return { status: 'applied' as const };
    }
  };
  const adapter = new GitHubCodeHostAdapter();
  (adapter as any).identify = async () => ({ id: '42', login: 'octocat', email: 'octo@example.com' });
  (adapter as any).inspectRepository = async () => ({ id: '73', defaultBranch: 'develop', canPush: true });
  return { state, adapter, service: new GitHubAuthorizationService(persistence as never, adapter) };
}

test('server PAT is checked, encrypted, reusable and omitted from public record', async () => {
  const previous = process.env.AGENT_CLUSTER_SECRET_KEY;
  process.env.AGENT_CLUSTER_SECRET_KEY = 'test-only-secret-key';
  try {
    const { state, service } = fixture();
    const first = await service.saveServerPat('ghp_example_secret', 'https://github.com/example/project');
    const second = await service.findReusableServerAuthorization('https://github.com/example/project');
    assert.equal(second?.id, first.id);
    assert.equal(second?.accountLogin, 'octocat');
    assert.equal(JSON.stringify(first).includes('ghp_example_secret'), false);
    const saved = JSON.stringify(state);
    assert.equal(saved.includes('ghp_example_secret'), false);
    assert.match(saved, /enc-v2:/);
    await service.disconnect(first.id);
    assert.equal(await service.findReusableServerAuthorization('https://github.com/example/project'), undefined);
    assert.equal(JSON.stringify(state).includes('enc-v2:'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_SECRET_KEY;
    else process.env.AGENT_CLUSTER_SECRET_KEY = previous;
  }
});

test('failed repository write preflight leaves no saved authorization', async () => {
  const { state, adapter, service } = fixture();
  (adapter as any).inspectRepository = async () => { throw new Error('GITHUB_REPOSITORY_WRITE_REQUIRED'); };
  await assert.rejects(service.saveServerPat('secret', 'https://github.com/example/project'),
    /GITHUB_REPOSITORY_WRITE_REQUIRED/);
  assert.deepEqual(state, {});
});

test('GitHub App URL and code exchange keep client secret and tokens out of public state', async () => {
  const previous = {
    key: process.env.AGENT_CLUSTER_SECRET_KEY,
    id: process.env.GITHUB_APP_CLIENT_ID,
    secret: process.env.GITHUB_APP_CLIENT_SECRET,
    callback: process.env.GITHUB_APP_CALLBACK_URL
  };
  process.env.AGENT_CLUSTER_SECRET_KEY = 'test-only-secret-key';
  process.env.GITHUB_APP_CLIENT_ID = 'client-id';
  process.env.GITHUB_APP_CLIENT_SECRET = 'client-secret';
  process.env.GITHUB_APP_CALLBACK_URL = 'https://app.example.test/github/callback';
  try {
    const { state, service } = fixture();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    (service as any).request = async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ access_token: 'github-app-access', refresh_token: 'github-app-refresh',
        expires_in: 3600, refresh_token_expires_in: 86400 });
    };
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const authorizationUrl = new URL(await service.startServerOAuth(sessionId,
      'https://github.com/example/project'));
    assert.equal(authorizationUrl.origin, 'https://github.com');
    const oauthState = authorizationUrl.searchParams.get('state')!;
    assert.ok(oauthState.length >= 32);
    assert.equal(JSON.stringify(state).includes(oauthState), false);
    assert.equal(authorizationUrl.href.includes('client-secret'), false);
    const saved = await service.exchangeOAuthCode('one-time-code', oauthState);
    assert.equal(saved.executionLocation, 'server');
    if (saved.executionLocation !== 'server') return;
    assert.equal(saved.authorization.kind, 'github_app');
    assert.equal(saved.sessionId, sessionId);
    assert.equal(saved.repositoryUrl, 'https://github.com/example/project');
    await assert.rejects(service.exchangeOAuthCode('one-time-code', oauthState),
      /GITHUB_OAUTH_STATE_INVALID/);
    assert.equal(requests[0]?.url, 'https://github.com/login/oauth/access_token');
    assert.equal(requests[0]?.init.redirect, 'manual');
    assert.equal(JSON.stringify(state).includes('github-app-access'), false);
    assert.equal(JSON.stringify(state).includes('github-app-refresh'), false);
    assert.equal(JSON.stringify(saved).includes('github-app-access'), false);
  } finally {
    for (const [key, value] of Object.entries({
      AGENT_CLUSTER_SECRET_KEY: previous.key,
      GITHUB_APP_CLIENT_ID: previous.id,
      GITHUB_APP_CLIENT_SECRET: previous.secret,
      GITHUB_APP_CALLBACK_URL: previous.callback
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('local GitHub OAuth binds its device and never persists the exchanged token on the server', async () => {
  const previous = {
    id: process.env.GITHUB_APP_CLIENT_ID,
    secret: process.env.GITHUB_APP_CLIENT_SECRET,
    callback: process.env.GITHUB_APP_CALLBACK_URL
  };
  process.env.GITHUB_APP_CLIENT_ID = 'client-id';
  process.env.GITHUB_APP_CLIENT_SECRET = 'client-secret';
  process.env.GITHUB_APP_CALLBACK_URL = 'https://app.example.test/github/callback';
  try {
    const { state, service } = fixture();
    (service as any).request = async () => Response.json({ access_token: 'local-oauth-secret',
      expires_in: 3600 });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const url = new URL(await service.startLocalOAuth(sessionId,
      'https://github.com/example/project', 'device-a'));
    const result = await service.exchangeOAuthCode('one-time-code', url.searchParams.get('state')!);
    assert.equal(result.executionLocation, 'local');
    if (result.executionLocation !== 'local') return;
    assert.equal(result.deviceId, 'device-a');
    assert.equal(result.accessToken, 'local-oauth-secret');
    assert.equal(JSON.stringify(state).includes('local-oauth-secret'), false);
    assert.equal(JSON.stringify(state).includes(url.searchParams.get('state')!), false);
  } finally {
    for (const [key, value] of Object.entries({
      GITHUB_APP_CLIENT_ID: previous.id,
      GITHUB_APP_CLIENT_SECRET: previous.secret,
      GITHUB_APP_CALLBACK_URL: previous.callback
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
