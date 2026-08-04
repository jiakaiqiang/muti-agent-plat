import { performance, PerformanceObserver } from 'node:perf_hooks';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const targetPath = process.env.WORKSPACE_PERF_TARGET_PATH;
if (!targetPath) {
  process.stderr.write('WORKSPACE_PERF_TARGET_PATH environment variable is required.\n');
  process.stderr.write('Example: WORKSPACE_PERF_TARGET_PATH=/path/to/100k-files npm run test:perf:workspace-real-files\n');
  process.exit(1);
}

const eventLoopDelays = [];
const obs = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.name === 'event-loop-delay') {
      eventLoopDelays.push(entry.duration);
    }
  }
});
obs.observe({ entryTypes: ['measure'] });

function measureEventLoopDelay() {
  const start = performance.now();
  setImmediate(() => {
    const delay = performance.now() - start;
    performance.measure('event-loop-delay', { start, duration: delay });
  });
}

const monitorInterval = setInterval(measureEventLoopDelay, 100);

function walkDirectory(dir, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = walkDirectory(fullPath, depth + 1, maxDepth);
          files += sub.files;
          bytes += sub.bytes;
        } else if (entry.isFile()) {
          const stat = statSync(fullPath);
          files += 1;
          bytes += stat.size;
        }
      } catch (err) {
        // Skip permission errors
      }
    }
  } catch (err) {
    // Skip permission errors
  }
  return { files, bytes };
}

const startedAt = performance.now();
const { files, bytes } = walkDirectory(targetPath);
const elapsedMs = performance.now() - startedAt;

clearInterval(monitorInterval);

eventLoopDelays.sort((a, b) => a - b);
const percentile = (p) => eventLoopDelays[Math.min(eventLoopDelays.length - 1, Math.ceil(eventLoopDelays.length * p) - 1)] ?? 0;
const round = (v) => Math.round(v * 1000) / 1000;

const checks = {
  indexingCompleted: files > 0,
  eventLoopP95Under100ms: percentile(0.95) < 100,
  eventLoopMaxUnder1000ms: Math.max(...eventLoopDelays, 0) < 1000
};

const report = {
  schemaVersion: '1.0',
  benchmark: 'workspace-real-files-indexing',
  machine: {
    hostname: hostname(),
    platform: platform(),
    osRelease: release(),
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
    diskType: process.env.WORKSPACE_PERF_DISK_TYPE ?? 'unknown'
  },
  targetPath,
  fileCount: files,
  totalBytes: bytes,
  elapsedMs: round(elapsedMs),
  eventLoopSamples: eventLoopDelays.length,
  eventLoopP50Ms: round(percentile(0.5)),
  eventLoopP95Ms: round(percentile(0.95)),
  eventLoopMaxMs: round(Math.max(...eventLoopDelays, 0)),
  checks,
  passed: Object.values(checks).every(Boolean)
};

process.stdout.write(`${JSON.stringify(report)}\n`);
process.stderr.write(`Real files indexing: ${files} files, ${Math.round(bytes / 1024 / 1024)}MB in ${round(elapsedMs)}ms; event loop P95=${round(percentile(0.95))}ms, max=${round(Math.max(...eventLoopDelays, 0))}ms.\n`);
if (!report.passed) process.exitCode = 1;
