import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStreamMetricsCollector } from './runtime-stream-metrics.js';

test('RuntimeStreamMetricsCollector records first frame latency and maximum inter-frame gap', () => {
  let now = 1_000;
  const collector = new RuntimeStreamMetricsCollector(() => now);
  now = 1_120;
  collector.notifyFrame();
  now = 1_350;
  collector.notifyFrame();
  now = 1_500;
  collector.notifyFrame();
  now = 1_900;

  const metrics = collector.complete();
  assert.equal(metrics.firstFrameLatencyMs, 120);
  assert.equal(metrics.maxInterFrameGapMs, 230);
  assert.equal(metrics.frameCount, 3);
  assert.equal(metrics.durationMs, 900);
  assert.equal(metrics.lastActivityAt, new Date(1_500).toISOString());
});

test('RuntimeStreamMetricsCollector keeps process start as last activity when no frame arrives', () => {
  let now = 5_000;
  const collector = new RuntimeStreamMetricsCollector(() => now);
  now = 5_800;
  const metrics = collector.complete();
  assert.equal(metrics.frameCount, 0);
  assert.equal(metrics.firstFrameLatencyMs, undefined);
  assert.equal(metrics.lastActivityAt, new Date(5_000).toISOString());
});
