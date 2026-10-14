import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryRecord, GitTaskCandidate } from '@agent-cluster/shared';
import { recordDeliveryCandidate } from './delivery-candidate.js';

const candidate = (id: string, taskId = 'task-a'): GitTaskCandidate => ({
  id, sessionId: 'session-a', taskId, baseCommit: 'a'.repeat(40),
  treeSha: 'b'.repeat(40), ref: `refs/agent-cluster/candidates/session-a/${taskId}/${id}`,
  changedPaths: ['binary.dat'], createdAt: '2026-09-28T00:00:00.000Z'
});

test('delivery candidates replace stale task output and preserve other task candidates', () => {
  const first = recordDeliveryCandidate(undefined, candidate('one'), 'main', '2026-09-28T00:00:01.000Z');
  const second = recordDeliveryCandidate(first, candidate('two', 'task-b'), 'main', '2026-09-28T00:00:02.000Z');
  const latest = recordDeliveryCandidate(second, candidate('three'), 'main', '2026-09-28T00:00:03.000Z');
  assert.deepEqual(latest.candidates?.map((item) => item.id), ['two', 'three']);
  assert.equal(latest.state, 'awaiting_validation_input');
  assert.equal(latest.version, 3);
  assert.deepEqual(recordDeliveryCandidate(latest, candidate('three'), 'main',
    '2026-09-28T00:00:04.000Z'), latest);
});

test('a merged delivery starts a new round for the next candidate', () => {
  const previous: DeliveryRecord = {
    ...recordDeliveryCandidate(undefined, candidate('one'), 'main', '2026-09-28T00:00:01.000Z'),
    state: 'merged', round: 2, mergedCommitSha: 'c'.repeat(40)
  };
  const next = recordDeliveryCandidate(previous, candidate('two'), 'main', '2026-09-28T00:00:02.000Z');
  assert.equal(next.round, 3);
  assert.equal(next.mergedCommitSha, undefined);
  assert.deepEqual(next.candidates?.map((item) => item.id), ['two']);
});

test('an open PR keeps its branch while a merged round clears remote identity', () => {
  const first = recordDeliveryCandidate(undefined, candidate('one'), 'main', '2026-09-28T00:00:01.000Z');
  const published: DeliveryRecord = { ...first, state: 'pr_open', taskBranch: 'agent-cluster/session-a/1',
    commitSha: 'c'.repeat(40), pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12' };
  const updated = recordDeliveryCandidate(published, candidate('two'), 'main', '2026-09-28T00:00:02.000Z');
  assert.equal(updated.taskBranch, published.taskBranch);
  assert.equal(updated.pullRequestNumber, 12);
  assert.equal(updated.commitSha, published.commitSha);
  const next = recordDeliveryCandidate({ ...published, state: 'merged' }, candidate('three'),
    'main', '2026-09-28T00:00:03.000Z');
  assert.equal(next.taskBranch, undefined);
  assert.equal(next.pullRequestNumber, undefined);
  assert.equal(next.commitSha, undefined);
});
