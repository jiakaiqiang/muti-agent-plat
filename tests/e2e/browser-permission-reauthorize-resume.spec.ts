import assert from 'node:assert/strict';
import test from 'node:test';
import { reauthorizeWorkspaceHandle } from '../../apps/web/src/stores/workspaceBrokerReauthorize.ts';
import type { PermissionCapableHandle } from '../../apps/web/src/stores/workspaceBrokerPermission.ts';
import { BrokerSuspensionRegistry } from '../../apps/server/src/modules/workspaces/browser-broker/resume-after-permission.js';

test('browser permission reauthorization resumes the original suspended task after user click', async () => {
  const registry = new BrokerSuspensionRegistry(() => '2026-07-12T00:00:00.000Z');
  registry.suspend({
    taskId: 'task-browser-permission-131',
    sessionId: 'session-browser-permission-131',
    workspaceId: 'browser-ws-131',
    requiredMode: 'read_write',
    reason: 'permission-prompt'
  });

  let permissionState: PermissionState = 'prompt';
  let requestCount = 0;
  const handle: PermissionCapableHandle = {
    queryPermission: async () => permissionState,
    requestPermission: async () => {
      requestCount += 1;
      permissionState = 'granted';
      return permissionState;
    }
  };

  const backgroundAttempt = await reauthorizeWorkspaceHandle({
    handle,
    mode: 'readwrite',
    trigger: 'background'
  });
  assert.equal(backgroundAttempt.ok, false);
  assert.equal(requestCount, 0);
  assert.equal(registry.list().length, 1);

  const userClickAttempt = await reauthorizeWorkspaceHandle({
    handle,
    mode: 'readwrite',
    trigger: 'user_click'
  });
  assert.equal(userClickAttempt.ok, true);
  assert.equal(requestCount, 1);

  const resumed = registry.resumeReadyForWorkspace('browser-ws-131', 'read_write');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].taskId, 'task-browser-permission-131');
  assert.equal(resumed[0].sessionId, 'session-browser-permission-131');
  assert.equal(resumed[0].resumedAt, '2026-07-12T00:00:00.000Z');
  assert.deepEqual(registry.list(), []);
});
