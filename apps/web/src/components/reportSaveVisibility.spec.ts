import { test } from 'vitest';
import assert from 'node:assert/strict';
import { canShowSaveMarkdownButton, type SaveableReport } from './reportSaveVisibility';

function report(overrides: Partial<SaveableReport> = {}): SaveableReport {
  return {
    kind: 'project_analysis_report',
    format: 'markdown',
    content: '# report',
    userConfirmed: true,
    ...overrides
  };
}

test('canShowSaveMarkdownButton returns true for a confirmed markdown report with content', () => {
  assert.equal(canShowSaveMarkdownButton(report()), true);
});

test('canShowSaveMarkdownButton hides button when the report is not user-confirmed', () => {
  assert.equal(canShowSaveMarkdownButton(report({ userConfirmed: false })), false);
});

test('canShowSaveMarkdownButton hides button for non-markdown formats', () => {
  assert.equal(canShowSaveMarkdownButton(report({ format: 'html' })), false);
});

test('canShowSaveMarkdownButton hides button when content is empty or whitespace only', () => {
  assert.equal(canShowSaveMarkdownButton(report({ content: '' })), false);
  assert.equal(canShowSaveMarkdownButton(report({ content: '   \n  ' })), false);
});

test('canShowSaveMarkdownButton returns false for unsupported report kinds', () => {
  assert.equal(canShowSaveMarkdownButton(report({ kind: 'chat_transcript' })), false);
});
