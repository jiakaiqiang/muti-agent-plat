import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePermissionWaitStatus } from './permission-wait-status.js';

test('evaluatePermissionWaitStatus returns RUNNING when task does not need workspace', () => {
  const decision = evaluatePermissionWaitStatus({
    requiredMode: 'read_write',
    currentState: 'denied',
    taskRequiresWorkspace: false
  });
  assert.equal(decision.status, 'RUNNING');
});

test('evaluatePermissionWaitStatus returns RUNNING when permission is granted', () => {
  const decision = evaluatePermissionWaitStatus({
    requiredMode: 'read_write',
    currentState: 'granted',
    taskRequiresWorkspace: true
  });
  assert.equal(decision.status, 'RUNNING');
});

test('evaluatePermissionWaitStatus enters WAIT_WORKSPACE_PERMISSION with prompt reason when state is prompt', () => {
  const decision = evaluatePermissionWaitStatus({
    requiredMode: 'read',
    currentState: 'prompt',
    taskRequiresWorkspace: true
  });
  assert.equal(decision.status, 'WAIT_WORKSPACE_PERMISSION');
  assert.equal(decision.reason, 'permission-prompt');
  assert.equal(decision.requiredMode, 'read');
});

test('evaluatePermissionWaitStatus surfaces denied and unsupported reasons distinctly', () => {
  const denied = evaluatePermissionWaitStatus({
    requiredMode: 'read_write',
    currentState: 'denied',
    taskRequiresWorkspace: true
  });
  assert.equal(denied.status, 'WAIT_WORKSPACE_PERMISSION');
  assert.equal(denied.reason, 'permission-denied');

  const unsupported = evaluatePermissionWaitStatus({
    requiredMode: 'read_write',
    currentState: 'unsupported',
    taskRequiresWorkspace: true
  });
  assert.equal(unsupported.status, 'WAIT_WORKSPACE_PERMISSION');
  assert.equal(unsupported.reason, 'permission-unsupported');
});
