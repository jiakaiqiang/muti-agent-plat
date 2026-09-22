import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRelationalMigrationState } from './relational-migration.cli.js';

test('migration comparison accepts relational empty projections omitted by file state', () => {
  const comparison = compareRelationalMigrationState(
    { sessions: [] },
    {
      sessions: [],
      workItemsBySession: {},
      workflowRuntime: {
        schemaVersion: 2,
        runs: [],
        nodeRunsByRunId: {},
        approvalsByRunId: {},
        effectsByRunId: {}
      }
    }
  );

  assert.deepEqual(comparison.mismatchedCollections, []);
});

test('migration comparison rejects non-empty data in a collection omitted by file state', () => {
  const comparison = compareRelationalMigrationState(
    { sessions: [] },
    { sessions: [], workItemsBySession: { 'session-1': [{ id: 'work-item-1' }] } }
  );

  assert.deepEqual(comparison.mismatchedCollections, ['workItemsBySession']);
});

test('migration comparison rejects changed values in collections present on both sides', () => {
  const comparison = compareRelationalMigrationState(
    { sessions: [{ id: 'session-1', status: 'RUNNING' }] },
    { sessions: [{ id: 'session-1', status: 'COMPLETED' }] }
  );

  assert.deepEqual(comparison.mismatchedCollections, ['sessions']);
});
