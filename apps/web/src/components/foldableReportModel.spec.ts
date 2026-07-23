import { test } from 'vitest';
import assert from 'node:assert/strict';
import { foldableReportModel } from './foldableReportModel';

test('foldableReportModel keeps content untouched when total lines below threshold', () => {
  const content = 'a\nb\nc';
  const model = foldableReportModel({ content, threshold: 20 });
  assert.equal(model.canExpand, false);
  assert.equal(model.isFolded, false);
  assert.equal(model.preview, content);
  assert.equal(model.totalLines, 3);
});

test('foldableReportModel folds by default when content exceeds threshold', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const content = lines.join('\n');
  const model = foldableReportModel({ content, threshold: 5 });
  assert.equal(model.canExpand, true);
  assert.equal(model.isFolded, true);
  assert.equal(model.previewLines, 5);
  assert.equal(model.preview.split('\n').length, 5);
  assert.equal(model.fullContent, content);
});

test('foldableReportModel returns the full content when expanded=true', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const content = lines.join('\n');
  const model = foldableReportModel({ content, threshold: 5, expanded: true });
  assert.equal(model.isFolded, false);
  assert.equal(model.preview, content);
  assert.equal(model.previewLines, 30);
});

test('foldableReportModel handles empty content without throwing', () => {
  const model = foldableReportModel({ content: '' });
  assert.equal(model.canExpand, false);
  assert.equal(model.preview, '');
  assert.equal(model.totalLines, 1);
});
