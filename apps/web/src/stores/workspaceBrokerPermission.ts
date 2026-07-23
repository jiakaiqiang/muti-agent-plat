export type WorkspacePermissionMode = 'read' | 'readwrite';

export type WorkspacePermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported';

export interface QueryPermissionOptions {
  mode: WorkspacePermissionMode;
}

export interface PermissionCapableHandle {
  queryPermission?: (options: QueryPermissionOptions) => Promise<PermissionState>;
  requestPermission?: (options: QueryPermissionOptions) => Promise<PermissionState>;
}

export async function queryWorkspacePermission(
  handle: PermissionCapableHandle,
  mode: WorkspacePermissionMode
): Promise<WorkspacePermissionState> {
  if (typeof handle.queryPermission !== 'function') return 'unsupported';
  const state = await handle.queryPermission({ mode });
  return normalizeState(state);
}

export async function ensureWorkspacePermission(
  handle: PermissionCapableHandle,
  mode: WorkspacePermissionMode
): Promise<WorkspacePermissionState> {
  const initial = await queryWorkspacePermission(handle, mode);
  if (initial !== 'prompt') return initial;
  if (typeof handle.requestPermission !== 'function') return 'unsupported';
  const requested = await handle.requestPermission({ mode });
  return normalizeState(requested);
}

function normalizeState(state: PermissionState): WorkspacePermissionState {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
}
