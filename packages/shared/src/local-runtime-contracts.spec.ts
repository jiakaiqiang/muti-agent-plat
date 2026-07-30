import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
  LOCAL_RUNTIME_PERMISSION_KEYS,
  LOCAL_RUNTIME_PROTOCOL_VERSION
} from './local-runtime-contracts.js';
import type {
  LocalRuntimeInvocationResult,
  LocalRuntimeWorkspacePermissionGrantRequest,
  LocalRuntimeWorkspaceOperationRequest
} from './local-runtime-contracts.js';

test('local runtime protocol and default permissions are explicit', () => {
  assert.equal(LOCAL_RUNTIME_PROTOCOL_VERSION, 6);
  assert.deepEqual(Object.keys(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY).sort(), [...LOCAL_RUNTIME_PERMISSION_KEYS].sort());
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.workspace_read, 'allow');
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.workspace_write, 'allow');
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.test_execute, 'allow');
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.workspace_delete, 'confirm');
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.command_execute, 'allow');
  assert.equal(DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY.dependency_install, 'confirm');
});

test('Local Runtime workspace operations bind authority and revision snapshots', () => {
  const request: LocalRuntimeWorkspaceOperationRequest = {
    requestId: 'request-1',
    invocationId: 'invocation-1',
    ownerId: 'local-user',
    workspaceId: 'workspace-1',
    workspaceRevision: { id: 'revision-1', observedAt: '2026-07-24T00:00:00.000Z' },
    permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
    operation: 'readFile',
    input: { path: 'README.md' }
  };
  assert.equal(request.invocationId, 'invocation-1');
  assert.equal(request.ownerId, 'local-user');
  assert.equal(request.workspaceRevision.id, 'revision-1');
});

test('Local Runtime dangerous permissions use an explicit one-time grant request', () => {
  const request: LocalRuntimeWorkspacePermissionGrantRequest = {
    requestId: 'permission-request-1',
    workspaceId: 'workspace-1',
    permission: 'workspace_delete',
    scope: 'once'
  };
  assert.equal(request.permission, 'workspace_delete');
  assert.equal(request.scope, 'once');
});

test('Local Runtime invocation results atomically report the post-invocation workspace revision', () => {
  const payload: LocalRuntimeInvocationResult = {
    workspaceId: 'workspace-1',
    workspaceRevision: { id: 'revision-2', observedAt: '2026-07-24T00:01:00.000Z' },
    result: {
      invocationId: 'invocation-1',
      runtimeType: 'codex',
      status: 'completed',
      output: {
        schemaVersion: '1.0',
        kind: 'agent_message',
        messageKind: 'answer',
        content: 'done',
        targetAgentIds: [],
        targetAgentKeys: [],
        mentionedAgentIds: [],
        relatedTaskIds: []
      },
      events: [],
      artifacts: [],
      systemEvidence: {
        workspaceChangeSet: null,
        verifiedTestResults: [],
        capturedAt: '2026-07-24T00:01:00.000Z',
        invocationId: 'invocation-1'
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' }
    }
  };

  assert.equal(payload.result.invocationId, 'invocation-1');
  assert.equal(payload.workspaceRevision.id, 'revision-2');
});
