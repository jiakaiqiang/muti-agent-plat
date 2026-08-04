import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  LocalRuntimeProviderConnectionSummary,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  LocalRuntimeTokenResponse,
  WorkspaceIndexSnapshot
} from '@agent-cluster/shared';
import { renameWithRetry } from './atomic-file.js';

export type LocalWorkspaceState = {
  workspaceId: string;
  displayName: string;
  rootPath: string;
  permissions: LocalRuntimePermissionPolicy;
  permissionPolicyVersion?: 2;
  oneTimePermissions?: Partial<Record<LocalRuntimePermission, true>>;
  index?: WorkspaceIndexSnapshot;
  registeredAt: string;
};

export type LocalRuntimeState = {
  schemaVersion: 2;
  deviceId: string;
  displayName: string;
  serverUrl: string;
  tokens?: LocalRuntimeTokenResponse;
  workspaces: LocalWorkspaceState[];
  providerConnections: LocalRuntimeProviderConnectionSummary[];
};

export function defaultState(serverUrl = 'http://127.0.0.1:8099'): LocalRuntimeState {
  return {
    schemaVersion: 2,
    deviceId: randomUUID(),
    displayName: hostname() || 'local-runtime',
    serverUrl,
    workspaces: [],
    providerConnections: []
  };
}

export function stateFilePath() {
  const configured = process.env.AGENT_RUNTIME_STATE_FILE?.trim();
  if (configured) return resolve(configured);
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'agent-runtime', 'state.json');
}

export async function loadState(): Promise<LocalRuntimeState> {
  const path = stateFilePath();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as LocalRuntimeState;
    if (![1, 2].includes(parsed.schemaVersion as number) || !parsed.deviceId || !Array.isArray(parsed.workspaces)) {
      throw new Error('Unsupported Local Runtime state schema.');
    }
    let migrated = parsed.schemaVersion !== 2;
    if (!Array.isArray(parsed.providerConnections)) parsed.providerConnections = [];
    parsed.schemaVersion = 2;
    for (const workspace of parsed.workspaces) {
      if (workspace.permissionPolicyVersion === 2) continue;
      workspace.permissions = {
        ...workspace.permissions,
        command_execute: workspace.permissions.command_execute === 'deny' ? 'deny' : 'allow'
      };
      workspace.permissionPolicyVersion = 2;
      if (workspace.oneTimePermissions) delete workspace.oneTimePermissions.command_execute;
      migrated = true;
    }
    if (migrated) await saveState(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return defaultState();
  }
}

export async function saveState(state: LocalRuntimeState): Promise<void> {
  const path = stateFilePath();
  const previous = stateWriteQueues.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeStateFile(path, state));
  stateWriteQueues.set(path, operation);
  try {
    await operation;
  } finally {
    if (stateWriteQueues.get(path) === operation) stateWriteQueues.delete(path);
  }
}

const stateWriteQueues = new Map<string, Promise<void>>();

async function writeStateFile(path: string, state: LocalRuntimeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
