import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from './contracts.js';
import { DEFAULT_CONTEXT_PIPELINE_VERSION } from './contracts.js';

function baseSession(): Omit<SessionDetail, 'contextPipelineVersion'> {
  return {
    id: 'session-1',
    title: 'Pipeline version',
    originalInput: 'Use context pipeline',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  };
}

test('SessionDetail accepts a fixed Context Pipeline version while legacy data can omit it', () => {
  const legacySession: SessionDetail = baseSession();
  assert.equal(legacySession.contextPipelineVersion, undefined);

  const versionedSession: SessionDetail = {
    ...baseSession(),
    contextPipelineVersion: DEFAULT_CONTEXT_PIPELINE_VERSION
  };
  assert.equal(versionedSession.contextPipelineVersion, 'v1');
});
