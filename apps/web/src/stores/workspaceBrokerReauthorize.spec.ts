import test from 'node:test';
import assert from 'node:assert/strict';
import { reauthorizeWorkspaceHandle } from './workspaceBrokerReauthorize';
import type { PermissionCapableHandle } from './workspaceBrokerPermission';

test('reauthorizeWorkspaceHandle refuses background triggers and returns current state', async () => {
  let requested = false;
  const handle: PermissionCapableHandle = {
    queryPermission: async () => 'prompt' as PermissionState,
    requestPermission: async () => {
      requested = true;
      return 'granted' as PermissionState;
    }
  };
  const result = await reauthorizeWorkspaceHandle({ handle, mode: 'readwrite', trigger: 'background' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'trigger-must-be-user');
  assert.equal(result.state, 'prompt');
  assert.equal(requested, false);
});

test('reauthorizeWorkspaceHandle proceeds when the trigger is a user click', async () => {
  let requested = false;
  const handle: PermissionCapableHandle = {
    queryPermission: async () => 'prompt' as PermissionState,
    requestPermission: async () => {
      requested = true;
      return 'granted' as PermissionState;
    }
  };
  const result = await reauthorizeWorkspaceHandle({ handle, mode: 'readwrite', trigger: 'user_click' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, 'granted');
  assert.equal(requested, true);
});

test('reauthorizeWorkspaceHandle returns granted immediately when already permitted', async () => {
  const handle: PermissionCapableHandle = {
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => {
      throw new Error('should not be called');
    }
  };
  const result = await reauthorizeWorkspaceHandle({ handle, mode: 'read', trigger: 'user_click' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, 'granted');
});
