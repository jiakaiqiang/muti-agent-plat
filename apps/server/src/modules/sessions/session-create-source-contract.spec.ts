import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionsController, assertSessionCreateContract } from './sessions.controller.js';

test('create contract accepts separate source and execution location but no token', () => {
  assert.doesNotThrow(() => assertSessionCreateContract({
    input: 'Implement a change', executionLocation: 'server',
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/a/b' }
  }));
  assert.throws(() => assertSessionCreateContract({
    input: 'Implement a change', token: 'secret'
  }), /Unsupported Session create fields: token/);
});

test('GitHub Session create endpoint remains closed until the delivery rollout is enabled', () => {
  const previous = process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
  delete process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
  try {
    const controller = new SessionsController({ create() { throw new Error('must not create'); } } as never);
    assert.throws(() => controller.create({
      input: 'Implement a change', executionLocation: 'server',
      codeSource: { kind: 'remote_repository', provider: 'github',
        repositoryUrl: 'https://github.com/example/project' }
    }), /GITHUB_SESSION_CREATE_NOT_ENABLED/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
    else process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED = previous;
  }
});

test('code source capability reflects the same server gate as create', () => {
  const previous = process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
  const controller = new SessionsController({} as never);
  try {
    delete process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
    assert.equal(controller.codeSourceCapabilities().data.githubCreateEnabled, false);
    process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED = 'true';
    assert.equal(controller.codeSourceCapabilities().data.githubCreateEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
    else process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED = previous;
  }
});

test('enabled rollout rejects a new server directory Session', () => {
  const previous = process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
  process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED = 'true';
  try {
    const controller = new SessionsController({ create() { throw new Error('must not create'); } } as never);
    assert.throws(() => controller.create({ input: 'Implement a change', executionLocation: 'server' }),
      /SERVER_SESSION_REQUIRES_GITHUB_SOURCE/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED;
    else process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED = previous;
  }
});

test('OAuth callback returns a result page without exposing the source binding', async () => {
  const controller = new SessionsController({} as never, undefined,
    { completeOAuth: async () => ({ authorizationRef: 'private-reference' }) } as never);
  const html = await controller.finishGitHubOAuth('code', 'state');
  assert.match(html, /GitHub 授权已完成/);
  assert.doesNotMatch(html, /private-reference|code|state/);
});

test('local GitHub authorization disconnect requires a device and repository pair', async () => {
  const calls: unknown[] = [];
  const controller = new SessionsController({} as never, undefined,
    { async disconnectLocalAuthorization(...args: unknown[]) { calls.push(args); return { state: 'disconnected' }; } } as never);
  await assert.rejects(controller.disconnectGitHubAuthorization('auth-a', 'device-a', undefined),
    /deviceId and repositoryUrl/);
  const result = await controller.disconnectGitHubAuthorization('auth-a', 'device-a',
    'https://github.com/example/project');
  assert.deepEqual(result.data, { state: 'disconnected' });
  assert.deepEqual(calls, [['auth-a', 'device-a', 'https://github.com/example/project']]);
});
