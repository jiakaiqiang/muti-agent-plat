import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from './contracts.js';
import { DEFAULT_CONTEXT_PIPELINE_VERSION } from './contracts.js';

function baseSession(): SessionDetail {
  return {
    id: 'session-1',
    dataEpoch: 'epoch-test',
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

test('SessionDetail no longer stores a pipeline version while product health remains v2', () => {
  const session = baseSession();
  assert.equal('contextPipelineVersion' in session, false);
  assert.equal(DEFAULT_CONTEXT_PIPELINE_VERSION, 'v2');
});
