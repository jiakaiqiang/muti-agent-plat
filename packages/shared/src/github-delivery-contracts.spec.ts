import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartSessionAgent, type SessionDetail, type SourceBinding } from './contracts.js';

const binding: SourceBinding = {
  sessionId: 'session-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/example/project',
  repositoryId: 'example/project',
  executionLocation: 'server',
  state: 'ready',
  version: 4,
  workspaceId: 'workspace-1',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z'
};

test('remote Session cannot start Agent until source and workspace are ready', () => {
  const session = {
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: binding.repositoryUrl },
    sourceBinding: { ...binding, state: 'awaiting_base_branch' }
  } as Pick<SessionDetail, 'codeSource' | 'sourceBinding' | 'workingDirectory'>;
  assert.equal(canStartSessionAgent(session), false);
  session.sourceBinding = { ...binding };
  assert.equal(canStartSessionAgent(session), false);
  session.workingDirectory = {
    kind: 'server_local', id: binding.workspaceId!, name: 'project',
    selectedAt: binding.updatedAt
  };
  assert.equal(canStartSessionAgent(session), true);
  session.sourceBinding = { ...binding, workspaceId: 'different-workspace' };
  assert.equal(canStartSessionAgent(session), false);
});

test('legacy and ordinary local-directory Sessions retain their start path', () => {
  assert.equal(canStartSessionAgent({}), true);
  assert.equal(canStartSessionAgent({ codeSource: { kind: 'local_directory' } }), true);
});
