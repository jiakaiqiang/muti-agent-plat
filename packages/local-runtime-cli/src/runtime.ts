import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  AgentRunResult,
  AgentRuntimeEvent,
  FileHash,
  InvocationPlan,
  LocalRuntimeInvocationRequest,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  LocalRuntimeProviderConnectionInput,
  WorkspaceChange,
  WorkspaceChangeSet
} from '@agent-cluster/shared';
import { createAgentMessageOutput, isSensitiveWorkspacePath } from '@agent-cluster/shared';
import { getLocalRuntimeAdapter } from './adapters/registry.js';
export { buildRuntimeProcessEnv } from './runtime-process.js';
import { extractLocalRuntimeError } from './runtime-error.js';
import { LocalWorkspace } from './workspace.js';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const maximumChangeSetTextBytes = 1_000_000;

type WorkspaceFileSnapshot = {
  hash: FileHash;
  content?: string;
  unsupportedReason?: string;
};

export async function executeLocalInvocation(
  request: LocalRuntimeInvocationRequest,
  workspace: LocalWorkspace,
  signal: AbortSignal,
  emit: (event: AgentRuntimeEvent) => void,
  localPermissions: LocalRuntimePermissionPolicy = workspace.permissionPolicy(),
  providerConnection?: LocalRuntimeProviderConnectionInput,
  providerConnectionError?: string
): Promise<AgentRunResult> {
  const { plan } = request;
  const startedAt = new Date().toISOString();
  let stagingRoot: string | undefined;
  try {
    if (providerConnectionError) throw new Error(providerConnectionError);
    if (request.workspaceId !== workspace.state.workspaceId) throw new Error('Invocation workspaceId mismatch.');
    const currentRevision = await workspace.revision();
    if (currentRevision.id !== request.workspaceRevision.id) {
      throw new Error('LOCAL_WORKSPACE_REVISION_CONFLICT: workspace changed after invocation planning.');
    }
    const effectivePermissions = intersectPermissionPolicies(request.permissions, localPermissions);
    assertInvocationPermissions(plan, effectivePermissions);
    const before = await snapshotWorkspaceFiles(workspace.state.rootPath, false);
    stagingRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-invocation-'));
    await copyAuthorizedWorkspace(workspace.state.rootPath, stagingRoot);
    const started: AgentRuntimeEvent = {
      invocationId: plan.invocationId,
      type: 'runtime_started',
      visibility: 'user',
      content: `${plan.agent.name} started ${plan.phase} on the local device.`,
      metadata: { executionLocation: 'local', workspaceId: request.workspaceId },
      createdAt: startedAt
    };
    emit(started);
    const adapterResult = await getLocalRuntimeAdapter(plan.executionTarget.runtimeType).execute({
      plan,
      cwd: stagingRoot,
      signal,
      permissions: effectivePermissions,
      ...(providerConnection ? { providerConnection } : {})
    });
    const output = adapterResult.output;
    const after = await snapshotWorkspaceFiles(stagingRoot, true);
    const changeSet = buildChangeSet(currentRevision, before, after);
    if (changeSet?.changes.some((change) => change.operation === 'delete' || change.operation === 'move')) {
      const permission = effectivePermissions.workspace_delete;
      if (permission !== 'allow') {
        throw new Error(`${permission === 'confirm' ? 'LOCAL_CONFIRMATION_REQUIRED' : 'LOCAL_PERMISSION_DENIED'}: workspace_delete`);
      }
    }
    const completed: AgentRuntimeEvent = {
      invocationId: plan.invocationId,
      type: 'runtime_completed',
      visibility: 'user',
      content: `${plan.agent.name} completed ${plan.phase} on the local device.`,
      metadata: { executionLocation: 'local', changedFileCount: changeSet?.changes.length ?? 0 },
      createdAt: new Date().toISOString()
    };
    emit(completed);
    return {
      invocationId: plan.invocationId,
      runtimeType: plan.executionTarget.runtimeType,
      status: 'completed',
      output,
      events: [started, completed],
      artifacts: output.kind === 'task_execution_result' ? output.changedArtifacts : [],
      systemEvidence: {
        workspaceChangeSet: changeSet,
        verifiedTestResults: [],
        capturedAt: new Date().toISOString(),
        invocationId: plan.invocationId
      },
      usage: adapterResult.usage,
      runtimeSession: adapterResult.runtimeSession,
      ...(changeSet && shouldApplyStagedChangeSet(plan.executionTarget.writeMode)
        ? {
            workspaceExecution: {
              mode: 'staging_copy' as const,
              baseRevision: currentRevision,
              changeSet,
              dirtyBaseline: false,
              requiresUserConfirmation: false
            }
          }
        : {})
    };
  } catch (error) {
    const cancelled = signal.aborted;
    const preservedRuntimeError = extractLocalRuntimeError(error);
    const message = preservedRuntimeError?.message ?? (error instanceof Error ? error.message : String(error));
    const confirmationPermission = localConfirmationPermission(message);
    const runtimeError = cancelled
      ? { code: 'RUNTIME_CANCELLED' as const, message, retryable: false }
      : preservedRuntimeError ?? {
          code: message.startsWith('LOCAL_') ? 'CAPABILITY_BLOCKED' as const : 'MODEL_ERROR' as const,
          message,
          retryable: !confirmationPermission,
          ...(confirmationPermission ? {
            details: {
              confirmationRequired: true,
              permission: confirmationPermission,
              workspaceId: request.workspaceId,
              phase: plan.phase
            }
          } : {})
        };
    const event: AgentRuntimeEvent = {
      invocationId: plan.invocationId,
      type: 'runtime_failed',
      visibility: 'user',
      content: cancelled ? 'Local Runtime invocation was interrupted.' : 'Local Runtime invocation failed.',
      metadata: { message, executionLocation: 'local' },
      createdAt: new Date().toISOString()
    };
    emit(event);
    return {
      invocationId: plan.invocationId,
      runtimeType: plan.executionTarget.runtimeType,
      status: cancelled ? 'cancelled' : 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [event],
      artifacts: [],
      systemEvidence: {
        workspaceChangeSet: null,
        verifiedTestResults: [],
        capturedAt: new Date().toISOString(),
        invocationId: plan.invocationId
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: plan.executionTarget.modelId ?? plan.executionTarget.runtimeType
      },
      error: runtimeError
    };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function shouldApplyStagedChangeSet(writeMode: InvocationPlan['executionTarget']['writeMode']) {
  return writeMode !== 'none' && writeMode !== 'proposal_only';
}

function localConfirmationPermission(message: string): LocalRuntimePermission | undefined {
  const match = message.match(/^LOCAL_CONFIRMATION_REQUIRED:\s*([a-z_]+)/);
  const permission = match?.[1] as LocalRuntimePermission | undefined;
  return permission && [
    'workspace_read',
    'workspace_write',
    'workspace_delete',
    'command_execute',
    'test_execute',
    'dependency_install'
  ].includes(permission) ? permission : undefined;
}

async function copyAuthorizedWorkspace(sourceRoot: string, stagingRoot: string) {
  await cp(sourceRoot, stagingRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (source) => {
      if (source === sourceRoot) return true;
      const path = relative(sourceRoot, source).replace(/\\/g, '/');
      if (isSensitiveWorkspacePath(path) || path.split('/').includes('.git')) return false;
      return !(await lstat(source)).isSymbolicLink();
    }
  });
}

async function snapshotWorkspaceFiles(root: string, rejectSensitiveChanges: boolean) {
  const files = new Map<string, WorkspaceFileSnapshot>();
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
      const absolute = join(directory, entry.name);
      const workspacePath = relative(root, absolute).replace(/\\/g, '/');
      if (isSensitiveWorkspacePath(workspacePath)) {
        if (rejectSensitiveChanges) {
          throw new Error(`LOCAL_SENSITIVE_PATH_CHANGE_DENIED: Runtime created a sensitive path: ${workspacePath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        files.set(workspacePath, await snapshotFile(absolute));
      }
    }
  };
  await visit(root);
  return files;
}

function buildChangeSet(
  baseRevision: LocalRuntimeInvocationRequest['workspaceRevision'],
  before: Map<string, WorkspaceFileSnapshot>,
  after: Map<string, WorkspaceFileSnapshot>
): WorkspaceChangeSet | null {
  const changes: WorkspaceChange[] = [];
  for (const [path, current] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      changes.push({ operation: 'create', path, content: requireTextContent(path, current), encoding: 'utf-8' });
    } else if (previous.hash.value !== current.hash.value) {
      changes.push({
        operation: 'update',
        path,
        content: requireTextContent(path, current),
        encoding: 'utf-8',
        expectedHash: previous.hash,
        ...(previous.content !== undefined ? { baseContent: previous.content } : {})
      });
    }
  }
  for (const [path, previous] of before) {
    if (!after.has(path)) changes.push({
      operation: 'delete',
      path,
      expectedHash: previous.hash,
      ...(previous.content !== undefined ? { baseContent: previous.content } : {})
    });
  }
  if (!changes.length) return null;
  return { id: randomUUID(), baseRevision, changes, createdAt: new Date().toISOString() };
}

async function snapshotFile(path: string): Promise<WorkspaceFileSnapshot> {
  const bytes = await readFile(path);
  const hash = contentHash(bytes);
  if (bytes.byteLength > maximumChangeSetTextBytes) {
    return { hash, unsupportedReason: `file exceeds ${maximumChangeSetTextBytes} bytes` };
  }
  if (bytes.includes(0)) return { hash, unsupportedReason: 'file contains binary data' };
  try {
    return { hash, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { hash, unsupportedReason: 'file is not valid UTF-8 text' };
  }
}

function requireTextContent(path: string, snapshot: WorkspaceFileSnapshot) {
  if (snapshot.content === undefined) {
    throw new Error(`LOCAL_CHANGESET_UNSUPPORTED_FILE: ${path}: ${snapshot.unsupportedReason ?? 'unsupported content'}`);
  }
  return snapshot.content;
}

function contentHash(content: string | Buffer): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') };
}

export function intersectPermissionPolicies(
  platform: LocalRuntimePermissionPolicy,
  local: LocalRuntimePermissionPolicy
): LocalRuntimePermissionPolicy {
  const keys: readonly LocalRuntimePermission[] = [
    'workspace_read',
    'workspace_write',
    'workspace_delete',
    'command_execute',
    'test_execute',
    'dependency_install'
  ];
  return Object.fromEntries(keys.map((key) => [key, stricterPermission(platform[key], local[key])])) as unknown as LocalRuntimePermissionPolicy;
}

function stricterPermission(
  left: LocalRuntimePermissionPolicy[LocalRuntimePermission],
  right: LocalRuntimePermissionPolicy[LocalRuntimePermission]
) {
  if (left === 'deny' || right === 'deny') return 'deny';
  if (left === 'confirm' || right === 'confirm') return 'confirm';
  return 'allow';
}

function assertInvocationPermissions(plan: InvocationPlan, permissions: LocalRuntimePermissionPolicy) {
  const required = new Set<LocalRuntimePermission>(['workspace_read', 'command_execute']);
  if (plan.executionTarget.writeMode !== 'none' || plan.executionTarget.requiredCapabilities.includes('write')) {
    required.add('workspace_write');
  }
  if (plan.executionTarget.requiredCapabilities.includes('test')) required.add('test_execute');
  if (
    plan.toolCatalog.decisions.some(
      (decision) => decision.status === 'allowed' && /(?:dependency|install)/i.test(decision.toolKey)
    )
  ) {
    required.add('dependency_install');
  }
  for (const key of required) {
    if (permissions[key] === 'allow') continue;
    const prefix = permissions[key] === 'confirm' ? 'LOCAL_CONFIRMATION_REQUIRED' : 'LOCAL_PERMISSION_DENIED';
    throw new Error(`${prefix}: ${key}`);
  }
}
