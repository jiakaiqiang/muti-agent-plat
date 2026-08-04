import { performance } from 'node:perf_hooks';
import { cpus, hostname, platform, release } from 'node:os';
import type { WorkspaceNavigationEntry } from '@agent-cluster/shared';
import { workspaceRegistration } from './transport.js';
import { LocalWorkspace } from './workspace.js';

const fileCount = 100_000;
const sampleCount = 100;
const observedAt = '2026-07-28T00:00:00.000Z';
const entries: WorkspaceNavigationEntry[] = Array.from({ length: fileCount }, (_, index) => ({
  path: `src/file-${index}.ts`, kind: 'file', size: 1, language: 'typescript', generated: false, sensitive: false
}));
const workspace = new LocalWorkspace({
  workspaceId: 'workspace-registration-performance',
  displayName: 'large-project',
  rootPath: 'D:/large-project',
  permissions: {
    workspace_read: 'allow', workspace_write: 'allow', workspace_delete: 'confirm',
    command_execute: 'allow', test_execute: 'allow', dependency_install: 'confirm'
  },
  permissionPolicyVersion: 2,
  registeredAt: observedAt,
  index: {
    workspaceId: 'workspace-registration-performance',
    revision: { id: 'revision-registration-performance', observedAt },
    generation: 1, status: 'ready', complete: true, entries,
    entrypoints: ['src/file-0.ts'], detectedStack: ['node'], indexedEntries: fileCount,
    truncated: false, updatedAt: observedAt,
    coverage: {
      visitedEntries: fileCount,
      indexedEntries: fileCount,
      excludedGenerated: 0,
      sensitiveEntries: 0,
      skippedSymlinks: 0,
      failedEntries: 0
    }
  }
}, { watch: false, index: false });

const samples: number[] = [];
let serializedEntries = false;
for (let sample = 0; sample < sampleCount; sample += 1) {
  const startedAt = performance.now();
  const registration = await workspaceRegistration(workspace);
  samples.push(performance.now() - startedAt);
  serializedEntries ||= 'entries' in (registration.index ?? {});
}
workspace.close();

samples.sort((left, right) => left - right);
const percentile = (value: number) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)] ?? 0;
const round = (value: number) => Math.round(value * 1_000) / 1_000;
const timing = { count: sampleCount, p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)) };
const checks = {
  perf01WorkspaceRegistrationP95Under500ms: timing.p95Ms < 500,
  registrationOmitsIndexEntries: !serializedEntries
};
const report = {
  schemaVersion: '1.0', benchmark: 'workspace-registration', fixtureMode: '100k_metadata_index_summary',
  machine: {
    hostname: hostname(), platform: platform(), osRelease: release(), node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
    diskType: process.env.WORKSPACE_PERF_DISK_TYPE ?? 'unknown'
  },
  fileCount, sampleCount, timing, checks, passed: Object.values(checks).every(Boolean)
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.stderr.write(`Workspace registration: 100K metadata P95=${timing.p95Ms}ms; entries serialized=${serializedEntries}.\n`);
if (!report.passed) process.exitCode = 1;
