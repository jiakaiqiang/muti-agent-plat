import { performance } from 'node:perf_hooks';
import { cpus, hostname, platform, release } from 'node:os';
import type { SessionDetail, WorkspaceIndexStatus, WorkspaceIndexSummary } from '@agent-cluster/shared';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

const fileCounts = [1_000, 10_000, 100_000] as const;
const samplesPerScenario = 40;
const now = '2026-07-28T00:00:00.000Z';

type Timing = { count: number; p50Ms: number; p95Ms: number; minMs: number; maxMs: number };

async function benchmarkCreate(fileCount: number, status: WorkspaceIndexStatus): Promise<Timing> {
  const samples: number[] = [];
  for (let sample = 0; sample < samplesPerScenario; sample += 1) {
    const workspaceId = `workspace-${fileCount}-${status}-${sample}`;
    const service = makeService(workspaceId, indexSummary(workspaceId, fileCount, status));
    const startedAt = performance.now();
    await service.create({
      input: 'Analyze the selected project',
      workingDirectory: {
        kind: 'local_bridge', id: workspaceId, name: 'large-project', selectedAt: now
      }
    });
    samples.push(performance.now() - startedAt);
  }
  return timing(samples);
}

function makeService(workspaceId: string, index: WorkspaceIndexSummary) {
  const sessions: SessionDetail[] = [];
  const noOpSubscription = { unsubscribe() {} };
  return new SessionsService(
    { resolveIds: () => ['coordinator'] } as never,
    { create: (input: object) => ({ id: crypto.randomUUID(), createdAt: now, toAgentIds: [], ...input }) } as never,
    {} as never,
    {
      recognizeTask: () => ({ domain: 'coding', intent: 'analysis', requiresCodeChanges: false })
    } as never,
    {
      ensureArchitectureReportSaveConfirmation() {},
      registerSavePendingInvocationCallback() {},
      discussAndCreateBrief: async () => await new Promise<never>(() => {})
    } as never,
    {} as never,
    {} as never,
    {
      assertWritable() {}, currentDataEpoch: () => 'epoch-performance',
      getCollection: () => sessions,
      setCollection: (_key: string, value: SessionDetail[]) => {
        sessions.splice(0, sessions.length, ...value);
      }
    } as never,
    { registerApprovalListener() {} } as never,
    undefined, undefined, undefined, undefined, undefined,
    {
      getWorkspace: (id: string) => id === workspaceId ? {
        workspaceId,
        displayName: 'large-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: index.revision,
        index
      } : undefined,
      interruptions: () => ({ subscribe: () => noOpSubscription })
    } as never,
    undefined,
    undefined
  );
}

function indexSummary(workspaceId: string, fileCount: number, status: WorkspaceIndexStatus): WorkspaceIndexSummary {
  const revision = { id: `revision-${workspaceId}`, observedAt: now };
  return {
    workspaceId,
    revision,
    generation: status === 'empty' ? 0 : 1,
    status,
    complete: status === 'ready',
    entrypoints: status === 'empty' ? [] : ['package.json'],
    detectedStack: status === 'empty' ? [] : ['node'],
    indexedEntries: status === 'empty' ? 0 : fileCount,
    truncated: false,
    updatedAt: now
  };
}

function timing(values: number[]): Timing {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function round(value: number) { return Math.round(value * 1_000) / 1_000; }

const byScale = Object.fromEntries(await Promise.all(fileCounts.map(async (fileCount) => [
  String(fileCount),
  await benchmarkCreate(fileCount, 'ready')
])));
const byStatus = Object.fromEntries(await Promise.all((['empty', 'building', 'ready'] as const).map(async (status) => [
  status,
  await benchmarkCreate(100_000, status)
])));
const scaleP95 = Object.values(byScale).map((value) => value.p95Ms);
const statusP95 = Object.values(byStatus).map((value) => value.p95Ms);
const scaleRatio = Math.max(...scaleP95) / Math.max(0.001, Math.min(...scaleP95));
const statusSpreadMs = Math.max(...statusP95) - Math.min(...statusP95);
const absoluteP95Ms = byScale['100000'].p95Ms;
const checks = {
  perf02SessionCreateP95Under1s: absoluteP95Ms < 1_000,
  perf03ScaleRatioUnder2x: Math.max(...scaleP95) <= Math.max(Math.min(...scaleP95) * 2, Math.min(...scaleP95) + 5),
  perf04IndexStatusSpreadUnder300ms: statusSpreadMs < 300
};
const report = {
  schemaVersion: '1.0',
  benchmark: 'workspace-session-create',
  fixtureMode: 'connected_local_runtime_metadata_summary',
  machine: {
    hostname: hostname(), platform: platform(), osRelease: release(), node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
    diskType: process.env.WORKSPACE_PERF_DISK_TYPE ?? 'unknown'
  },
  samplesPerScenario,
  fileCounts,
  byScale,
  byStatus,
  derived: { scaleRatio: round(scaleRatio), statusSpreadMs: round(statusSpreadMs) },
  checks,
  passed: Object.values(checks).every(Boolean)
};

process.stdout.write(`${JSON.stringify(report)}\n`);
process.stderr.write(
  `Workspace Session create: 100K P95=${absoluteP95Ms}ms, scale ratio=${report.derived.scaleRatio}x, status spread=${report.derived.statusSpreadMs}ms.\n`
);
if (!report.passed) process.exitCode = 1;
