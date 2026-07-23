import {
  ensureWorkspacePermission,
  queryWorkspacePermission,
  type PermissionCapableHandle,
  type WorkspacePermissionMode,
  type WorkspacePermissionState
} from './workspaceBrokerPermission';

export type ReauthorizeTrigger = 'user_click' | 'background';

export interface ReauthorizeArgs {
  handle: PermissionCapableHandle;
  mode: WorkspacePermissionMode;
  trigger: ReauthorizeTrigger;
}

export type ReauthorizeResult =
  | { ok: true; state: WorkspacePermissionState }
  | { ok: false; reason: 'trigger-must-be-user'; state: WorkspacePermissionState };

export async function reauthorizeWorkspaceHandle(args: ReauthorizeArgs): Promise<ReauthorizeResult> {
  const { handle, mode, trigger } = args;
  if (trigger !== 'user_click') {
    const state = await queryWorkspacePermission(handle, mode);
    return { ok: false, reason: 'trigger-must-be-user', state };
  }
  const state = await ensureWorkspacePermission(handle, mode);
  return { ok: true, state };
}
