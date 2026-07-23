import { test } from 'vitest';
import assert from 'node:assert/strict';
import { defaultReportPath } from './defaultReportPath';

test('defaultReportPath returns the fixed project analysis path when reportKind matches', () => {
  const path = defaultReportPath({ reportKind: 'project_analysis_report' });
  assert.equal(path, 'agent-output/project-architecture-analysis.md');
});

test('defaultReportPath returns design/code review defaults for known kinds', () => {
  assert.equal(defaultReportPath({ reportKind: 'design_report' }), 'agent-output/design-review.md');
  assert.equal(defaultReportPath({ reportKind: 'code_review_report' }), 'agent-output/code-review.md');
});

test('defaultReportPath honors an explicit override and normalizes separators', () => {
  const path = defaultReportPath({
    reportKind: 'project_analysis_report',
    override: 'docs\\reports\\custom.md'
  });
  assert.equal(path, 'docs/reports/custom.md');
});

test('defaultReportPath slugifies title as fallback for unknown kinds', () => {
  const path = defaultReportPath({ reportKind: 'unknown', title: 'Refactor Plan v2' });
  assert.equal(path, 'agent-output/refactor-plan-v2.md');
});

test('defaultReportPath falls back to report.md when neither kind nor title yield a name', () => {
  const path = defaultReportPath({ reportKind: 'unknown' });
  assert.equal(path, 'agent-output/report.md');
});
