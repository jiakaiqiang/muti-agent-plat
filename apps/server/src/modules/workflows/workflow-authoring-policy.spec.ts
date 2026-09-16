import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowAuthoring } from './workflow-authoring-policy.js';

test('consumer service rejects all definition writes even with an author token', () => {
  assert.throws(() => assertWorkflowAuthoring('valid', { WORKFLOW_AUTHORING_MODE: 'read_only', WORKFLOW_AUTHORING_TOKEN: 'valid' }), /只读/);
});
test('shared service checks the server-configured capability and fails closed when unconfigured', () => {
  assert.throws(() => assertWorkflowAuthoring(undefined, { WORKFLOW_AUTHORING_MODE: 'token' }), /尚未配置/);
  assert.throws(() => assertWorkflowAuthoring('client', { WORKFLOW_AUTHORING_TOKEN: 'author' }), /没有/);
  assert.throws(() => assertWorkflowAuthoring(undefined, { WORKFLOW_AUTHORING_TOKEN: 'author' }), /没有/);
  assert.doesNotThrow(() => assertWorkflowAuthoring('author', { WORKFLOW_AUTHORING_TOKEN: 'author' }));
});
