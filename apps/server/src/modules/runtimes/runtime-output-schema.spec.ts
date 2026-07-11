import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_TYPES } from '@agent-cluster/shared';
import { validateRuntimeOutput } from './runtime-output-schema.js';

function executionResult(changedArtifacts: unknown[]) {
  return {
    kind: 'task_execution_result',
    status: 'completed',
    summary: 'Completed the requested work.',
    completedItems: [],
    changedArtifacts,
    nextSuggestedActions: [],
    risks: []
  };
}

test('Runtime Artifact schema accepts every canonical type with required fields', () => {
  for (const type of ARTIFACT_TYPES) {
    const result = validateRuntimeOutput(
      executionResult([{ type, title: `${type} artifact`, content: `${type} content` }]),
      'task_execution_result'
    );
    assert.equal(result.valid, true, `${type}: ${result.errors.join('; ')}`);
  }
});

test('Runtime Artifact schema rejects missing type, title, or content', () => {
  for (const artifact of [
    { title: 'Missing type', content: 'body' },
    { type: 'markdown', content: 'body' },
    { type: 'markdown', title: 'Missing content' }
  ]) {
    const result = validateRuntimeOutput(executionResult([artifact]), 'task_execution_result');
    assert.equal(result.valid, false, JSON.stringify(artifact));
  }
});

test('Runtime Artifact schema rejects types outside the canonical enum', () => {
  const result = validateRuntimeOutput(
    executionResult([{ type: 'architecture_analysis', title: 'Architecture', content: '# Architecture' }]),
    'task_execution_result'
  );

  assert.equal(result.valid, false);
});

test('Runtime Artifact schema rejects metadata.content as a second body source', () => {
  const result = validateRuntimeOutput(
    executionResult([
      {
        type: 'markdown',
        title: 'Architecture',
        content: '# Canonical body',
        metadata: { content: '# Legacy body', reportKind: 'project_architecture_analysis' }
      }
    ]),
    'task_execution_result'
  );

  assert.equal(result.valid, false);
});

test('Post Review schema accepts a traceable workspace-context request', () => {
  const result = validateRuntimeOutput(
    {
      kind: 'post_review_report',
      isConsistentWithBrief: false,
      matchedItems: [],
      mismatchedItems: [],
      missingItems: ['Missing source evidence for src/feature.ts.'],
      outOfScopeChanges: [],
      testResults: [],
      recommendation: 'ask_user',
      actions: [
        {
          action: 'request_workspace_context',
          reason: 'Review needs the implementation source before it can verify completion.',
          missingPaths: ['src/feature.ts']
        }
      ]
    },
    'post_review_report'
  );

  assert.equal(result.valid, true, result.errors.join('; '));
});

test('Post Review schema rejects workspace-context requests without missing paths', () => {
  const result = validateRuntimeOutput(
    {
      kind: 'post_review_report',
      isConsistentWithBrief: false,
      matchedItems: [],
      mismatchedItems: [],
      missingItems: ['Missing source evidence.'],
      outOfScopeChanges: [],
      testResults: [],
      recommendation: 'ask_user',
      actions: [
        {
          action: 'request_workspace_context',
          reason: 'Review needs source evidence.',
          missingPaths: []
        }
      ]
    },
    'post_review_report'
  );

  assert.equal(result.valid, false);
});
