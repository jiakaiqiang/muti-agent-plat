import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { buildReportChangeSet } from './build-report-change-set.js';
import { applyServerLocalChangeSet } from '../workspace-apply-change-set.js';

const baseRevision: WorkspaceRevision = { id: 'rev-116', observedAt: '2026-07-11T00:00:00.000Z' };

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t116-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('server-local save report creates agent-output/project-architecture-analysis.md end-to-end', async () => {
  await withTempRoot(async (root) => {
    const content = '# Report\nsection A\nsection B\n';
    const changeSet = buildReportChangeSet({
      changeSetId: '00000000-0000-4000-8000-000000000116',
      baseRevision,
      path: 'agent-output/project-architecture-analysis.md',
      content,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      changeSet
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.appliedCount, 1);
    const savedPath = join(root, 'agent-output', 'project-architecture-analysis.md');
    const stats = await stat(savedPath);
    assert.equal(stats.isFile(), true);
    const written = await readFile(savedPath, 'utf8');
    assert.equal(written, content);
  });
});
