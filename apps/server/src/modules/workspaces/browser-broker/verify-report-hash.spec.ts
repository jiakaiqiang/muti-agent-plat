import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { applyServerLocalChangeSet } from '../workspace-apply-change-set.js';
import { statServerLocalFile } from '../workspace-stat-file.js';
import { buildReportChangeSet } from './build-report-change-set.js';

const baseRevision: WorkspaceRevision = { id: 'rev-117', observedAt: '2026-07-11T00:00:00.000Z' };

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t117-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('post-save hash matches expected sha256 for a report ChangeSet write', async () => {
  await withTempRoot(async (root) => {
    const content = '# report\nline two\nline three\n';
    const changeSet = buildReportChangeSet({
      changeSetId: '00000000-0000-4000-8000-000000000117',
      baseRevision,
      path: 'agent-output/report.md',
      content,
      createdAt: '2026-07-11T00:00:00.000Z'
    });
    const applyResult = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      changeSet
    });
    assert.equal(applyResult.ok, true);
    if (!applyResult.ok) return;

    const stats = await statServerLocalFile({
      rootPath: root,
      revision: applyResult.revision,
      input: { path: 'agent-output/report.md' }
    });
    assert.equal(stats.kind, 'file');
    if (stats.kind !== 'file') return;
    assert.equal(stats.hash.algorithm, 'sha256');
    assert.equal(stats.hash.value, sha256(content));
    assert.equal(stats.revision.id, applyResult.revision.id);
  });
});
