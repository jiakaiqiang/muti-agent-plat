import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { defaultReportPath } from '../../apps/web/src/components/defaultReportPath.ts';
import { canShowSaveMarkdownButton } from '../../apps/web/src/components/reportSaveVisibility.ts';
import { applyServerLocalChangeSet } from '../../apps/server/src/modules/workspaces/workspace-apply-change-set.js';
import { readServerLocalFile } from '../../apps/server/src/modules/workspaces/workspace-read-file.js';
import { statServerLocalFile } from '../../apps/server/src/modules/workspaces/workspace-stat-file.js';
import { buildReportChangeSet } from '../../apps/server/src/modules/workspaces/browser-broker/build-report-change-set.js';

const baseRevision: WorkspaceRevision = { id: 'rev-browser-report-save-132', observedAt: '2026-07-12T00:00:00.000Z' };

test('browser report save writes artifact body verbatim and verifies post-save hash', async () => {
  const artifact = {
    kind: 'project_analysis_report',
    format: 'markdown',
    title: '项目架构分析报告',
    content: '# 项目架构分析报告\n\n- evidence: src/main.ts\n- conclusion: keep full body\n',
    userConfirmed: true
  };
  assert.equal(canShowSaveMarkdownButton(artifact), true);

  const reportPath = defaultReportPath({ reportKind: artifact.kind, title: artifact.title });
  assert.equal(reportPath, 'agent-output/project-architecture-analysis.md');

  const changeSet = buildReportChangeSet({
    changeSetId: '00000000-0000-4000-8000-000000000132',
    baseRevision,
    path: reportPath,
    content: artifact.content,
    createdAt: '2026-07-12T00:00:00.000Z'
  });
  const [change] = changeSet.changes;
  assert.equal(change.operation, 'create');
  if (change.operation !== 'create') return;
  assert.equal(change.content, artifact.content);

  const root = await mkdtemp(join(tmpdir(), 'browser-report-save-'));
  try {
    const applyResult = await applyServerLocalChangeSet({ rootPath: root, currentRevision: baseRevision, changeSet });
    assert.equal(applyResult.ok, true);
    if (!applyResult.ok) return;

    const saved = await readServerLocalFile({
      rootPath: root,
      revision: applyResult.revision,
      input: { path: reportPath }
    });
    assert.equal(saved.content, artifact.content);
    assert.equal(saved.byteLength, Buffer.byteLength(artifact.content, 'utf8'));

    const stat = await statServerLocalFile({
      rootPath: root,
      revision: applyResult.revision,
      input: { path: reportPath }
    });
    assert.equal(stat.kind, 'file');
    if (stat.kind !== 'file') return;
    assert.equal(stat.hash.value, sha256(artifact.content));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
