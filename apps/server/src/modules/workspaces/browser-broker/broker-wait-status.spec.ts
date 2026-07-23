import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBrokerWaitStatus } from './broker-wait-status.js';

test('evaluateBrokerWaitStatus returns RUNNING when the task does not need the workspace', () => {
  const result = evaluateBrokerWaitStatus({
    workspaceKind: 'browser_broker',
    brokerConnected: false,
    taskRequiresWorkspace: false
  });
  assert.equal(result.status, 'RUNNING');
});

test('evaluateBrokerWaitStatus keeps RUNNING for server_local workspaces regardless of broker state', () => {
  const result = evaluateBrokerWaitStatus({
    workspaceKind: 'server_local',
    brokerConnected: false,
    taskRequiresWorkspace: true
  });
  assert.equal(result.status, 'RUNNING');
});

test('evaluateBrokerWaitStatus returns WAIT_WORKSPACE_CLIENT when broker is offline for a workspace-dependent task', () => {
  const result = evaluateBrokerWaitStatus({
    workspaceKind: 'browser_broker',
    brokerConnected: false,
    taskRequiresWorkspace: true
  });
  assert.equal(result.status, 'WAIT_WORKSPACE_CLIENT');
  assert.equal(result.reason, 'broker-offline');
});

test('evaluateBrokerWaitStatus resumes RUNNING once broker connects again', () => {
  const result = evaluateBrokerWaitStatus({
    workspaceKind: 'browser_broker',
    brokerConnected: true,
    taskRequiresWorkspace: true
  });
  assert.equal(result.status, 'RUNNING');
});
