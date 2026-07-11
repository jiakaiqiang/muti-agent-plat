export function collectWatchdogSamples(report) {
  const checkpoints = Array.isArray(report?.checkpoints) ? report.checkpoints : [];
  return checkpoints.flatMap((checkpoint) => {
    const execution = checkpoint?.execution;
    const metrics = execution?.streamMetrics;
    if (execution?.status !== 'completed' || !metrics || typeof checkpoint.runtimeType !== 'string') return [];
    if (
      !Number.isFinite(metrics.durationMs) ||
      !Number.isFinite(metrics.firstFrameLatencyMs) ||
      !Number.isFinite(metrics.maxInterFrameGapMs)
    ) {
      return [];
    }
    return [{
      runtimeType: checkpoint.runtimeType,
      stage: checkpoint.stage,
      durationMs: metrics.durationMs,
      firstFrameLatencyMs: metrics.firstFrameLatencyMs,
      maxInterFrameGapMs: metrics.maxInterFrameGapMs,
      frameCount: metrics.frameCount
    }];
  });
}

export function buildWatchdogBaseline(samples, options = {}) {
  const minSamples = Number(options.minSamples ?? 20);
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error('minSamples must be a positive integer.');
  const selectedRuntime = options.runtimeType;
  const filtered = selectedRuntime ? samples.filter((sample) => sample.runtimeType === selectedRuntime) : samples;
  const grouped = new Map();
  for (const sample of filtered) {
    grouped.set(sample.runtimeType, [...(grouped.get(sample.runtimeType) ?? []), sample]);
  }
  if (!grouped.size) throw new Error('No completed real CLI stream-metric samples were found.');

  const runtimes = [];
  for (const [runtimeType, runtimeSamples] of grouped) {
    if (runtimeSamples.length < minSamples) {
      throw new Error(`${runtimeType} has ${runtimeSamples.length} samples; at least ${minSamples} are required.`);
    }
    const firstFrames = runtimeSamples.map((sample) => sample.firstFrameLatencyMs);
    const gaps = runtimeSamples.map((sample) => sample.maxInterFrameGapMs);
    const durations = runtimeSamples.map((sample) => sample.durationMs);
    const firstFrameP95 = percentile(firstFrames, 0.95);
    const firstFrameP99 = percentile(firstFrames, 0.99);
    const gapP95 = percentile(gaps, 0.95);
    const gapP99 = percentile(gaps, 0.99);
    const durationP95 = percentile(durations, 0.95);
    const durationP99 = percentile(durations, 0.99);
    runtimes.push({
      runtimeType,
      sampleCount: runtimeSamples.length,
      observed: {
        firstFrameLatencyMs: { p50: percentile(firstFrames, 0.5), p95: firstFrameP95, p99: firstFrameP99, max: Math.max(...firstFrames) },
        maxInterFrameGapMs: { p50: percentile(gaps, 0.5), p95: gapP95, p99: gapP99, max: Math.max(...gaps) },
        durationMs: { p50: percentile(durations, 0.5), p95: durationP95, p99: durationP99, max: Math.max(...durations) }
      },
      recommended: {
        firstFrameTimeoutMs: roundUp(Math.max(30_000, firstFrameP99 * 1.5, firstFrameP95 + 5_000), 5_000),
        idleTimeoutMs: roundUp(Math.max(60_000, gapP99 * 2, gapP95 + 30_000), 30_000),
        absoluteTimeoutMs: null
      },
      rationale: {
        firstFrame: 'max(30s, P99×1.5, P95+5s), rounded up to 5s.',
        idle: 'max(60s, frame-gap P99×2, frame-gap P95+30s), rounded up to 30s.',
        absolute: 'Disabled by default; enable only for an approved cost or compliance ceiling.'
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    minimumSamplesPerRuntime: minSamples,
    sourceSampleCount: filtered.length,
    runtimes: runtimes.sort((left, right) => left.runtimeType.localeCompare(right.runtimeType))
  };
}

export function baselineMarkdown(baseline) {
  const lines = [
    '# Watchdog 参数基线报告',
    '',
    `> 生成时间：${baseline.generatedAt}`,
    `> 每个 Runtime 最小样本数：${baseline.minimumSamplesPerRuntime}`,
    '',
    '| Runtime | 样本 | 首帧 P95 / P99 | 最大帧间隔 P95 / P99 | 总时长 P95 / P99 | 推荐 first-frame | 推荐 idle | absolute |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const item of baseline.runtimes) {
    lines.push(
      `| ${item.runtimeType} | ${item.sampleCount} | ${item.observed.firstFrameLatencyMs.p95} / ${item.observed.firstFrameLatencyMs.p99} ms | ${item.observed.maxInterFrameGapMs.p95} / ${item.observed.maxInterFrameGapMs.p99} ms | ${item.observed.durationMs.p95} / ${item.observed.durationMs.p99} ms | ${item.recommended.firstFrameTimeoutMs} ms | ${item.recommended.idleTimeoutMs} ms | 默认关闭 |`
    );
  }
  lines.push(
    '',
    '## 应用规则',
    '',
    '- 推荐值必须经过 staging 慢任务和故障注入复核后才能写入生产配置。',
    '- absolute timeout 默认关闭；只有明确的成本或合规上限获批后才允许设置。',
    '- 参数变更后保留上一组配置，出现误杀时立即回滚并保留 timeout invocation 证据。',
    ''
  );
  return `${lines.join('\n')}\n`;
}

function percentile(values, ratio) {
  if (!values.length) throw new Error('Cannot calculate a percentile from an empty sample set.');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function roundUp(value, step) {
  return Math.ceil(value / step) * step;
}
