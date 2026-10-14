import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail, SourceBinding } from '@agent-cluster/shared';
import { SourcePreparationCoordinator } from './source-preparation-coordinator.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_URL = 'https://github.com/example/project';

function fixture() {
  const now = new Date().toISOString();
  const binding: SourceBinding = {
    sessionId: SESSION_ID, provider: 'github', repositoryUrl: REPOSITORY_URL,
    repositoryId: 'example/project', executionLocation: 'server',
    state: 'awaiting_auth', version: 1, createdAt: now, updatedAt: now
  };
  const session = {
    id: SESSION_ID, codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: REPOSITORY_URL },
    sourceBinding: binding
  } as SessionDetail;
  const transitions: string[] = [];
  let agentStarts = 0;
  let authorizationAvailable = false;
  const authorization = { id: 'auth-1', accountId: '42', repositoryUrl: REPOSITORY_URL };
  const sessions = {
    list: () => [{ id: SESSION_ID }],
    get: () => session,
    updateServerSourcePreparation(_id: string, expected: number, update: Partial<SourceBinding>) {
      assert.equal(session.sourceBinding?.version, expected);
      session.sourceBinding = { ...session.sourceBinding!, ...update, version: expected + 1 };
      transitions.push(session.sourceBinding.state);
      return session.sourceBinding;
    },
    async completeServerSourcePreparation(_id: string, expected: number,
      prepared: { baseBranch: string; baseSha: string }) {
      assert.equal(session.sourceBinding?.version, expected);
      assert.equal(prepared.baseBranch, 'feature');
      assert.equal(prepared.baseSha, 'b'.repeat(40));
      session.sourceBinding = { ...session.sourceBinding!, state: 'ready',
        baseBranch: prepared.baseBranch, baseSha: prepared.baseSha, version: expected + 1 };
      transitions.push('ready');
      agentStarts += 1;
      return session.sourceBinding;
    }
  };
  const auth = {
    async findReusableServerAuthorization() { return authorizationAvailable ? authorization : undefined; },
    async saveServerPat() { authorizationAvailable = true; return authorization; },
    async withServerToken(_id: string, _url: string, run: (token: string) => Promise<unknown>) {
      return run('fixture-token');
    }
  };
  const github = { async inspectRepository() {
    return { id: '73', defaultBranch: 'develop', canPush: true };
  } };
  const workspaces = {
    async prepare() { return { cacheKey: 'cache-1', workspaceId: `github-session:${SESSION_ID}` }; },
    async listBranches() { return [
      { name: 'develop', sha: 'a'.repeat(40) }, { name: 'feature', sha: 'b'.repeat(40) }
    ]; },
    async selectBaseBranch() { return { baseSha: 'b'.repeat(40) }; },
    sessionWorkspacePath() { return 'C:\\managed\\session'; }
  };
  const coordinator = new SourcePreparationCoordinator(sessions as never, auth as never,
    github as never, workspaces as never);
  return { coordinator, transitions, get agentStarts() { return agentStarts; } };
}

test('server source waits for authorization and actual branch selection before Agent starts', async () => {
  const state = fixture();
  assert.equal((await state.coordinator.prepare(SESSION_ID)).state, 'awaiting_auth');
  assert.equal(state.agentStarts, 0);
  const cloned = await state.coordinator.savePat(SESSION_ID, 'fixture-token');
  assert.equal(cloned.state, 'awaiting_base_branch');
  assert.equal(state.agentStarts, 0);
  const branches = await state.coordinator.branches(SESSION_ID);
  assert.equal(branches.defaultBranch, 'develop');
  assert.deepEqual(branches.branches.map((branch) => branch.name), ['develop', 'feature']);
  await assert.rejects(state.coordinator.selectBranch(SESSION_ID, 'feature', branches.version - 1),
    /SOURCE_PREPARATION_VERSION_CONFLICT/);
  assert.equal(state.agentStarts, 0);
  assert.equal((await state.coordinator.selectBranch(SESSION_ID, 'feature', branches.version)).state, 'ready');
  assert.equal(state.agentStarts, 1);
  assert.deepEqual(state.transitions, ['cloning', 'awaiting_base_branch', 'ready']);
});

test('local source saves PAT only on its device and waits for branch selection before Agent starts', async () => {
  const now = new Date().toISOString();
  const session = {
    id: SESSION_ID,
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: REPOSITORY_URL,
      deviceId: 'device-a' },
    sourceBinding: { sessionId: SESSION_ID, provider: 'github', repositoryUrl: REPOSITORY_URL,
      repositoryId: 'example/project', executionLocation: 'local', deviceId: 'device-a',
      state: 'awaiting_auth', version: 1, createdAt: now, updatedAt: now }
  } as SessionDetail;
  let starts = 0;
  const actions: string[] = [];
  const sessions = {
    list: () => [{ id: SESSION_ID }], get: () => session,
    updateLocalSourcePreparation(_id: string, version: number, update: Partial<SourceBinding>) {
      assert.equal(version, session.sourceBinding!.version);
      session.sourceBinding = { ...session.sourceBinding!, ...update, version: version + 1 };
      return session.sourceBinding;
    },
    async completeLocalSourcePreparation(_id: string, version: number,
      prepared: { baseBranch: string; baseSha: string }) {
      assert.equal(version, session.sourceBinding!.version);
      assert.equal(prepared.baseBranch, 'feature');
      assert.equal(prepared.baseSha, 'b'.repeat(40));
      session.sourceBinding = { ...session.sourceBinding!, state: 'ready', version: version + 1 };
      starts += 1;
      return session.sourceBinding;
    }
  };
  const localRuntime = {
    async requestGitHubAuthorization(deviceId: string, action: { action: string; token?: string }) {
      assert.equal(deviceId, 'device-a');
      actions.push(action.action);
      return action.action === 'save_pat' || action.action === 'find_reusable' && actions.includes('save_pat')
        ? { id: 'auth-a', deviceId: 'device-a', accountId: '42', repositoryId: '73',
            repositoryUrl: REPOSITORY_URL, state: 'active' }
        : undefined;
    },
    async requestGitHubSource(deviceId: string, action: { action: string }) {
      assert.equal(deviceId, 'device-a');
      actions.push(action.action);
      if (action.action === 'prepare') return { repositoryId: '73', defaultBranch: 'develop',
        workspaceId: `github-session:${SESSION_ID}`, cacheKey: 'cache-a' };
      if (action.action === 'branches') return { branches: [
        { name: 'develop', sha: 'a'.repeat(40) }, { name: 'feature', sha: 'b'.repeat(40) }
      ] };
      return { baseSha: 'b'.repeat(40) };
    }
  };
  const coordinator = new SourcePreparationCoordinator(sessions as never, {} as never,
    {} as never, {} as never, localRuntime as never);
  assert.equal((await coordinator.prepare(SESSION_ID)).state, 'awaiting_auth');
  assert.equal(starts, 0);
  const cloned = await coordinator.savePat(SESSION_ID, 'fixture-token');
  assert.equal(cloned.state, 'awaiting_base_branch');
  assert.equal(starts, 0);
  const branches = await coordinator.branches(SESSION_ID);
  assert.equal(branches.defaultBranch, 'develop');
  assert.deepEqual(branches.branches.map((branch) => branch.name), ['develop', 'feature']);
  assert.equal((await coordinator.selectBranch(SESSION_ID, 'feature', branches.version)).state, 'ready');
  assert.equal(starts, 1);
  assert.deepEqual(actions, ['find_reusable', 'save_pat', 'prepare', 'branches', 'select_branch']);
});

test('local source remains retryable when its device is offline during authorization lookup', async () => {
  const now = new Date().toISOString();
  const session = {
    id: SESSION_ID,
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: REPOSITORY_URL,
      deviceId: 'device-a' },
    sourceBinding: { sessionId: SESSION_ID, provider: 'github', repositoryUrl: REPOSITORY_URL,
      repositoryId: 'example/project', executionLocation: 'local', deviceId: 'device-a',
      state: 'cloning', version: 2, createdAt: now, updatedAt: now }
  } as SessionDetail;
  let connected = false;
  const sessions = {
    get: () => session,
    updateLocalSourcePreparation(_id: string, version: number, update: Partial<SourceBinding>) {
      assert.equal(version, session.sourceBinding?.version);
      session.sourceBinding = { ...session.sourceBinding!, ...update, version: version + 1 };
      return session.sourceBinding;
    }
  };
  const localRuntime = {
    async requestGitHubAuthorization() {
      if (!connected) throw new Error('device offline');
      return undefined;
    }
  };
  const coordinator = new SourcePreparationCoordinator(sessions as never, {} as never,
    {} as never, {} as never, localRuntime as never);
  const blocked = await coordinator.prepare(SESSION_ID);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.errorCode, 'LOCAL_RUNTIME_UNAVAILABLE');
  connected = true;
  const retried = await coordinator.prepare(SESSION_ID);
  assert.equal(retried.state, 'awaiting_auth');
  assert.equal(retried.errorCode, undefined);
});
