export type WorkspaceMetricLabels = Record<string, string>;

export const FILE_REVISION_METRIC_NAMES = [
  'file_revision_chain_total',
  'file_revision_iteration_total',
  'file_revision_iteration_duration_ms',
  'file_revision_synthesis_duration_ms',
  'file_revision_stale_total',
  'file_revision_context_incomplete_total',
  'file_revision_model_capacity_rejected_total',
  'file_revision_persistence_failure_total',
  'file_revision_persistence_conflict_total',
  'file_revision_recovery_total'
] as const;

export const INTENT_ROUTING_METRIC_NAMES = [
  'intent_route_total',
  'intent_route_latency_ms',
  'intent_route_runtime_failure_total',
  'intent_route_schema_repair_total',
  'intent_route_clarification_total',
  'intent_route_stale_snapshot_total',
  'routing_idempotency_replay_total',
  'decision_inheritance_total',
  'work_item_created_total',
  'event_outbox_lag_ms'
] as const;

export const WORKSPACE_METRIC_NAMES = [
  'workspace_authorization_duration_ms',
  'session_create_duration_ms',
  'workspace_index_status_total',
  'workspace_index_entries_total',
  'workspace_index_generation_duration_ms',
  'supplemental_context_duration_ms',
  'supplemental_context_bytes_total',
  'supplemental_context_retry_total',
  'context_insufficient_terminal_total',
  'workspace_writeback_conflict_total',
  'workspace_revision_unstable_total',
  'runtime_stop_pending_sync_count',
  'runtime_stop_pending_sync_oldest_ms',
  'runtime_stop_receipt_replay_total',
  'runtime_stop_event_idempotency_conflict_total',
  ...INTENT_ROUTING_METRIC_NAMES,
  ...FILE_REVISION_METRIC_NAMES
] as const;

export type WorkspaceMetricName = typeof WORKSPACE_METRIC_NAMES[number];

type MetricSeries = {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  labels: WorkspaceMetricLabels;
  value?: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  last?: number;
};

function seriesKey(name: string, labels: WorkspaceMetricLabels): string {
  return `${name}:${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(',')}`;
}

class WorkspaceMetricsRegistry {
  private readonly series = new Map<string, MetricSeries>();

  increment(name: WorkspaceMetricName, value = 1, labels: WorkspaceMetricLabels = {}): void {
    const key = seriesKey(name, labels);
    const current = this.series.get(key);
    this.series.set(key, {
      name,
      type: 'counter',
      labels: { ...labels },
      value: (current?.value ?? 0) + Math.max(0, value)
    });
  }

  set(name: WorkspaceMetricName, value: number, labels: WorkspaceMetricLabels = {}): void {
    this.series.set(seriesKey(name, labels), {
      name,
      type: 'gauge',
      labels: { ...labels },
      value
    });
  }

  observe(name: WorkspaceMetricName, value: number, labels: WorkspaceMetricLabels = {}): void {
    const normalized = Math.max(0, value);
    const key = seriesKey(name, labels);
    const current = this.series.get(key);
    this.series.set(key, {
      name,
      type: 'histogram',
      labels: { ...labels },
      count: (current?.count ?? 0) + 1,
      sum: (current?.sum ?? 0) + normalized,
      min: current?.min === undefined ? normalized : Math.min(current.min, normalized),
      max: current?.max === undefined ? normalized : Math.max(current.max, normalized),
      last: normalized
    });
  }

  snapshot() {
    return {
      generatedAt: new Date().toISOString(),
      names: [...WORKSPACE_METRIC_NAMES],
      series: [...this.series.values()]
        .map((item) => ({ ...item, labels: { ...item.labels } }))
        .sort((left, right) => seriesKey(left.name, left.labels).localeCompare(seriesKey(right.name, right.labels)))
    };
  }

  resetForTests(): void {
    this.series.clear();
  }
}

export const workspaceMetrics = new WorkspaceMetricsRegistry();
