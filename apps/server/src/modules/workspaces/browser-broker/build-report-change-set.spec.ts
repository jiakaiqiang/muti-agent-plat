import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { buildReportChangeSet } from './build-report-change-set.js';

const baseRevision: WorkspaceRevision = { id: 'rev-113', observedAt: '2026-07-11T00:00:00.000Z' };

test('buildReportChangeSet creates a create-op when no existing hash is provided', () => {
  const changeSet = buildReportChangeSet({
    changeSetId: '00000000-0000-4000-8000-000000000113',
    baseRevision,
    path: 'agent-output/project-architecture-analysis.md',
    content: '# report body\nline 2\n',
    createdAt: '2026-07-11T00:00:00.000Z'
  });
  assert.equal(changeSet.changes.length, 1);
  const [only] = changeSet.changes;
  assert.equal(only.operation, 'create');
  if (only.operation !== 'create') return;
  assert.equal(only.content, '# report body\nline 2\n');
  assert.equal(only.encoding, 'utf-8');
});

test('buildReportChangeSet creates an update-op with expectedHash when file already exists', () => {
  const changeSet = buildReportChangeSet({
    changeSetId: '00000000-0000-4000-8000-000000000114',
    baseRevision,
    path: 'agent-output/report.md',
    content: 'new content',
    existingHash: { algorithm: 'sha256', value: 'a'.repeat(64) },
    createdAt: '2026-07-11T00:00:01.000Z'
  });
  assert.equal(changeSet.changes.length, 1);
  const [only] = changeSet.changes;
  assert.equal(only.operation, 'update');
  if (only.operation !== 'update') return;
  assert.equal(only.expectedHash.value, 'a'.repeat(64));
  assert.equal(only.content, 'new content');
});

test('buildReportChangeSet preserves content verbatim (no re-encoding)', () => {
  const body = '# 中文标题\n- 项 1\n- 项 2\n';
  const changeSet = buildReportChangeSet({
    changeSetId: '00000000-0000-4000-8000-000000000115',
    baseRevision,
    path: 'agent-output/report.md',
    content: body,
    createdAt: '2026-07-11T00:00:02.000Z'
  });
  const [only] = changeSet.changes;
  if (only.operation !== 'create') return;
  assert.equal(only.content, body);
});
