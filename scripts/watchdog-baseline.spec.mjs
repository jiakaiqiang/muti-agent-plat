import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineMarkdown, buildWatchdogBaseline, collectWatchdogSamples } from './watchdog-baseline.mjs';

function syntheticReport() {
  return {
    checkpoints: Array.from({ length: 20 }, (_, index) => ({
      stage: `claude_code:sample-${index + 1}`,
      runtimeType: 'claude_code',
      execution: {
        status: 'completed',
        streamMetrics: {
          durationMs: 120_000 + index * 1_000,
          firstFrameLatencyMs: 2_000 + index * 100,
          maxInterFrameGapMs: 10_000 + index * 500,
          frameCount: 8
        }
      }
    }))
  };
}

test('watchdog baseline requires and summarizes 20 completed samples', () => {
  const samples = collectWatchdogSamples(syntheticReport());
  const baseline = buildWatchdogBaseline(samples, { minSamples: 20 });
  assert.equal(baseline.runtimes[0].sampleCount, 20);
  assert.equal(baseline.runtimes[0].recommended.firstFrameTimeoutMs, 30_000);
  assert.equal(baseline.runtimes[0].recommended.idleTimeoutMs, 60_000);
  assert.equal(baseline.runtimes[0].recommended.absoluteTimeoutMs, null);
  assert.match(baselineMarkdown(baseline), /absolute timeout 默认关闭/);
});

test('watchdog baseline refuses an undersized real-run sample set', () => {
  const samples = collectWatchdogSamples(syntheticReport()).slice(0, 19);
  assert.throws(() => buildWatchdogBaseline(samples, { minSamples: 20 }), /at least 20/);
});
