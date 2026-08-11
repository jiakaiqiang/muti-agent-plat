import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  LocalRuntimeProviderConnectionSummary,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  LocalRuntimeTokenResponse,
  WorkspaceNavigationEntry,
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
      if (workspace.index) {
        const inlineEntries = Array.isArray(workspace.index.entries) ? workspace.index.entries : [];
        const persistedEntries = await loadWorkspaceIndex(workspace.workspaceId);
        workspace.index.entries = persistedEntries ?? inlineEntries;
        if (!persistedEntries && inlineEntries.length) {
          await saveWorkspaceIndex(workspace.workspaceId, inlineEntries);
          migrated = true;
        }
      }
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

export async function saveWorkspaceIndex(
  workspaceId: string,
  entries: readonly WorkspaceNavigationEntry[]
): Promise<void> {
  const path = workspaceIndexFilePath(workspaceId);
  await enqueueJsonWrite(path, entries);
}

export async function loadWorkspaceIndex(
  workspaceId: string
): Promise<WorkspaceNavigationEntry[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(workspaceIndexFilePath(workspaceId), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as WorkspaceNavigationEntry[] : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function loadPersistedWorkspaceIds(): Promise<Set<string>> {
  const parsed = JSON.parse(await readFile(stateFilePath(), 'utf8')) as { workspaces?: unknown };
  if (!Array.isArray(parsed.workspaces)) throw new Error('Local Runtime state has no workspace list.');
  return new Set(parsed.workspaces.flatMap((workspace) => {
    const workspaceId = (workspace as { workspaceId?: unknown })?.workspaceId;
    return typeof workspaceId === 'string' ? [workspaceId] : [];
  }));
}

export async function removeWorkspace(
  state: LocalRuntimeState,
  workspaceId: string
): Promise<LocalWorkspaceState | undefined> {
  const index = state.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
  if (index < 0) return undefined;
  const [removed] = state.workspaces.splice(index, 1);
  await saveState(state);
  await unlink(workspaceIndexFilePath(workspaceId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return removed;
}

const stateWriteQueues = new Map<string, Promise<void>>();

async function writeStateFile(path: string, state: LocalRuntimeState): Promise<void> {
  const persisted = {
    ...state,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      ...(workspace.index
        ? { index: withoutEntries(workspace.index) }
        : {})
    }))
  };
  await writeJsonFile(path, persisted);
}

function workspaceIndexFilePath(workspaceId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(workspaceId)) {
    throw new Error(`Invalid Local Runtime workspace ID: ${workspaceId}`);
  }
  return join(dirname(stateFilePath()), `${workspaceId}-index.json`);
}

function withoutEntries(snapshot: WorkspaceIndexSnapshot): Omit<WorkspaceIndexSnapshot, 'entries'> {
  const { entries: _entries, ...metadata } = snapshot;
  return metadata;
}

async function enqueueJsonWrite(path: string, value: unknown): Promise<void> {
  const previous = stateWriteQueues.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeJsonFile(path, value));
  stateWriteQueues.set(path, operation);
  try {
    await operation;
  } finally {
    if (stateWriteQueues.get(path) === operation) stateWriteQueues.delete(path);
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
