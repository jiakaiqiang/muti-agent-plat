import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureWorkspacePermission,
  queryWorkspacePermission,
  type PermissionCapableHandle
} from './workspaceBrokerPermission';

function fakeHandle(overrides: Partial<PermissionCapableHandle>): PermissionCapableHandle {
  return overrides;
}

test('queryWorkspacePermission maps granted state for read mode', async () => {
  const handle = fakeHandle({
    queryPermission: async ({ mode }) => {
      assert.equal(mode, 'read');
      return 'granted' as PermissionState;
    }
  });
  const state = await queryWorkspacePermission(handle, 'read');
  assert.equal(state, 'granted');
});

test('queryWorkspacePermission maps denied state for readwrite mode', async () => {
  const handle = fakeHandle({
    queryPermission: async ({ mode }) => {
      assert.equal(mode, 'readwrite');
      return 'denied' as PermissionState;
    }
  });
  const state = await queryWorkspacePermission(handle, 'readwrite');
  assert.equal(state, 'denied');
});

test('queryWorkspacePermission returns unsupported when handle lacks the API', async () => {
  const state = await queryWorkspacePermission({}, 'read');
  assert.equal(state, 'unsupported');
});

test('ensureWorkspacePermission requests permission when initial state is prompt', async () => {
  let requested = false;
  const handle = fakeHandle({
    queryPermission: async () => 'prompt' as PermissionState,
    requestPermission: async () => {
      requested = true;
      return 'granted' as PermissionState;
    }
  });
  const state = await ensureWorkspacePermission(handle, 'readwrite');
  assert.equal(state, 'granted');
  assert.equal(requested, true);
});

test('ensureWorkspacePermission does not request again when already granted', async () => {
  let requestCount = 0;
  const handle = fakeHandle({
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => {
      requestCount += 1;
      return 'granted' as PermissionState;
    }
  });
  const state = await ensureWorkspacePermission(handle, 'read');
  assert.equal(state, 'granted');
  assert.equal(requestCount, 0);
});
