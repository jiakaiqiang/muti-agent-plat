import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_START_CONTRACT_VERSION,
  workflowStartLogicalKey,
  isWorkflowStartBindingCurrent,
  type WorkflowStartBinding
} from './workflow-start-contracts.js';

function binding(overrides: Partial<WorkflowStartBinding> = {}): WorkflowStartBinding {
  return {
    sessionId: 'session-1',
    workItemId: 'wi-1',
    workItemRevision: 3,
    confirmationId: 'confirm-1',
    documentId: 'doc-1',
    documentRevision: 2,
    contentHash: 'hash-doc-2',
    workflowId: 'wf-1',
    workflowVersion: 4,
    definitionHash: 'hash-wf-4',
    ...overrides
  };
}

test('contract version is pinned so a key shape change cannot reuse old start requests', () => {
  assert.equal(WORKFLOW_START_CONTRACT_VERSION, 'workflow-start-v1');
});

test('the logical key carries every version a start decision depends on', () => {
  const key = workflowStartLogicalKey(binding());

  for (const part of ['session-1', 'confirm-1', 'doc-1', 'wf-1', 'hash-doc-2', 'hash-wf-4']) {
    assert.match(key, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(key, /workflow-start-v1/);
});

test('a new document revision is a different start request, not a replay of the old one', () => {
  // The pre-phase-4 key was sessionId:confirmationId only. A revised document
  // reusing that confirmation would have replayed the old run instead of being
  // refused, which is exactly the stale-approval hole AC6 closes.
  const first = workflowStartLogicalKey(binding({ documentRevision: 2, contentHash: 'hash-doc-2' }));
  const revised = workflowStartLogicalKey(binding({ documentRevision: 3, contentHash: 'hash-doc-3' }));

  assert.notEqual(first, revised);
});

test('a republished workflow version is a different start request', () => {
  const first = workflowStartLogicalKey(binding());
  const republished = workflowStartLogicalKey(binding({ workflowVersion: 5, definitionHash: 'hash-wf-5' }));

  assert.notEqual(first, republished);
});

test('the same decision produces the same key so a retried submit is idempotent', () => {
  assert.equal(workflowStartLogicalKey(binding()), workflowStartLogicalKey(binding()));
});

test('a binding is current only when every version still matches the live state', () => {
  const current = {
    workItemRevision: 3,
    documentRevision: 2,
    contentHash: 'hash-doc-2',
    definitionHash: 'hash-wf-4'
  };

  assert.equal(isWorkflowStartBindingCurrent(binding(), current), true);
  assert.equal(
    isWorkflowStartBindingCurrent(binding(), { ...current, documentRevision: 3 }),
    false,
    'a newer document revision invalidates the start'
  );
  assert.equal(
    isWorkflowStartBindingCurrent(binding(), { ...current, contentHash: 'hash-other' }),
    false,
    'same revision with different content is still a different document'
  );
  assert.equal(
    isWorkflowStartBindingCurrent(binding(), { ...current, definitionHash: 'hash-wf-5' }),
    false,
    'a republished graph invalidates the start'
  );
  assert.equal(
    isWorkflowStartBindingCurrent(binding(), { ...current, workItemRevision: 4 }),
    false,
    'a revised requirement invalidates the start'
  );
});
