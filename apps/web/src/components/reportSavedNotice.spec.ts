import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReportSavedNotice } from './reportSavedNotice';

test('buildReportSavedNotice includes the actual write path in message and payload', () => {
  const notice = buildReportSavedNotice({
    path: 'agent-output/project-architecture-analysis.md',
    revisionId: 'rev-118',
    appliedCount: 1,
    savedAt: '2026-07-11T00:00:00.000Z'
  });
  assert.equal(notice.kind, 'report_saved');
  assert.equal(notice.path, 'agent-output/project-architecture-analysis.md');
  assert.match(notice.message, /agent-output\/project-architecture-analysis\.md/);
  assert.equal(notice.revisionId, 'rev-118');
  assert.equal(notice.appliedCount, 1);
  assert.equal(notice.savedAt, '2026-07-11T00:00:00.000Z');
});

test('buildReportSavedNotice omits optional fields when not provided', () => {
  const notice = buildReportSavedNotice({
    path: 'docs/summary.md',
    appliedCount: 1
  });
  assert.equal(notice.revisionId, undefined);
  assert.equal(notice.savedAt, undefined);
});
