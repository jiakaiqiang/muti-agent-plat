import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_REVISION_METRIC_NAMES,
  WORKSPACE_METRIC_NAMES,
  workspaceMetrics
} from './workspace-metrics.js';

test('workspace metrics expose counters, gauges and bounded duration aggregates without payload data', () => {
  workspaceMetrics.resetForTests();
  workspaceMetrics.increment('supplemental_context_retry_total', 1);
  workspaceMetrics.set('workspace_index_entries_total', 42, { providerKind: 'server_local' });
  workspaceMetrics.observe('session_create_duration_ms', 12);
  workspaceMetrics.observe('session_create_duration_ms', 8);

  const snapshot = workspaceMetrics.snapshot();
  assert.deepEqual(snapshot.names, WORKSPACE_METRIC_NAMES);
  assert.deepEqual(snapshot.series.find((item) => item.name === 'supplemental_context_retry_total'), {
    name: 'supplemental_context_retry_total', type: 'counter', labels: {}, value: 1
  });
  assert.equal(snapshot.series.find((item) => item.name === 'workspace_index_entries_total')?.value, 42);
  const duration = snapshot.series.find((item) => item.name === 'session_create_duration_ms');
  assert.equal(duration?.count, 2);
  assert.equal(duration?.sum, 20);
  assert.equal(duration?.min, 8);
  assert.equal(duration?.max, 12);
  assert.equal(WORKSPACE_METRIC_NAMES.length, 35);
  for (const metric of [
    'routing_idempotency_replay_total',
    'decision_inheritance_total',
    'event_outbox_lag_ms',
    'runtime_stop_pending_sync_count',
    'runtime_stop_pending_sync_oldest_ms',
    'runtime_stop_receipt_replay_total',
    'runtime_stop_event_idempotency_conflict_total'
  ]) {
    assert.ok(WORKSPACE_METRIC_NAMES.includes(metric as typeof WORKSPACE_METRIC_NAMES[number]));
  }
  assert.equal(FILE_REVISION_METRIC_NAMES.length, 10);
  assert.ok(FILE_REVISION_METRIC_NAMES.includes('file_revision_persistence_conflict_total'));
  assert.deepEqual(
    WORKSPACE_METRIC_NAMES.filter((name) => name.startsWith('file_revision_')),
    FILE_REVISION_METRIC_NAMES
  );
});
