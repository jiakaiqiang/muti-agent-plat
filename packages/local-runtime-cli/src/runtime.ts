import { runtimePhaseLabel, isUsableWorkspaceEvidencePath } from "@agent-cluster/shared";
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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
import { createAgentMessageOutput, isSensitiveWorkspacePath, materializeTaskSubmission } from '@agent-cluster/shared';
import { getLocalRuntimeAdapter } from './adapters/registry.js';
export { buildRuntimeProcessEnv } from './runtime-process.js';
import { extractLocalRuntimeError, localRuntimeError } from './runtime-error.js';
import { LocalWorkspace } from './workspace.js';
import { captureExecutionCandidate, validateExecutionCandidate } from './execution-candidate.js';
import { SubmissionError } from './adapters/submission-error.js';
import { GitRepositoryWorkspaceManager } from '@agent-cluster/shared/node/repository-workspace-manager';
import { captureGitTaskCandidate } from '@agent-cluster/shared/node/git-task-candidate';

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
  let stagingContainer: string | undefined;
  let captureState: { stagingRoot: string; before: Map<string, WorkspaceFileSnapshot>; revision: import('@agent-cluster/shared').WorkspaceRevision;
    permissions: LocalRuntimePermissionPolicy } | undefined;
  let executionCandidate: AgentRunResult['executionCandidate'];
  let githubCandidate: AgentRunResult['githubCandidate'];
  let repairBaseline: Map<string, WorkspaceFileSnapshot> | undefined;
  try {
    if (providerConnectionError) throw new Error(providerConnectionError);
    if (request.workspaceId !== workspace.state.workspaceId) throw new Error('Invocation workspaceId mismatch.');
    const currentRevision = await workspace.revision();
    const revisionChanged = currentRevision.id !== request.workspaceRevision.id;
    if (revisionChanged && !await revalidateReadOnlyEvidence(plan, workspace)) {
      throw new Error('LOCAL_WORKSPACE_REVISION_CONFLICT: workspace changed after invocation planning.');
    }
    const effectivePermissions = intersectPermissionPolicies(request.permissions, localPermissions);
    assertInvocationPermissions(plan, effectivePermissions);
    const githubSessionId = /^github-session:([0-9a-f-]{36})$/i.exec(workspace.state.workspaceId)?.[1];
    const githubTask = githubSessionId && plan.phase === 'task_execution' && plan.taskId &&
      githubSessionId === plan.sessionId ? { sessionId: githubSessionId, taskId: plan.taskId } : undefined;
    let stagingRoot: string;
    let githubBaseCommit: string | undefined;
    if (githubTask) {
      const manager = new GitRepositoryWorkspaceManager();
      const expected = resolve(manager.sessionWorkspacePath(githubTask.sessionId));
      const actual = resolve(workspace.state.rootPath);
      if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !==
          (process.platform === 'win32' ? expected.toLowerCase() : expected)) {
        throw new Error('GITHUB_SESSION_WORKSPACE_MISMATCH');
      }
      if (plan.recoveryCandidate) throw new Error('GITHUB_TEXT_CANDIDATE_UNSUPPORTED');
      const task = await manager.prepareTask(githubTask.sessionId, githubTask.taskId);
      stagingRoot = task.workspacePath;
      githubBaseCommit = task.baseCommit;
    } else {
      const before = await snapshotWorkspaceFiles(workspace.state.rootPath, false);
      stagingContainer = await mkdtemp(join(tmpdir(), 'agent-runtime-invocation-'));
      // fs.cp(errorOnExist) in the desktop's Node runtime also rejects an existing
      // destination directory. Keep the private container, copy into a new child.
      stagingRoot = join(stagingContainer, 'workspace');
      await copyAuthorizedWorkspace(workspace.state.rootPath, stagingRoot);
      captureState = { stagingRoot, before, revision: currentRevision, permissions: effectivePermissions };
    }
    if (revisionChanged) {
      // The envelope stays immutable. Verify the copied bytes too, closing the read/copy race.
      for (const file of plan.contextEnvelope.L3.files) {
        const bytes = await readFile(join(stagingRoot, file.path));
        if (createHash('sha256').update(bytes).digest('hex') !== file.hash?.value) {
          throw new Error('LOCAL_WORKSPACE_REVISION_CONFLICT: evidence changed while preparing the read-only workspace.');
        }
      }
      emit({ invocationId: plan.invocationId, type: 'runtime_progress', visibility: 'user',
        content: '工作区版本已变化；已校验本次只读分析的证据文件内容未变，继续调用。',
        createdAt: new Date().toISOString(), metadata: { evidenceRevalidated: true } });
    }
    if (plan.recoveryCandidate) {
      validateExecutionCandidate(plan, plan.recoveryCandidate, effectivePermissions);
      if (plan.recoveryCandidate.baseRevision.id !== currentRevision.id) throw new Error('CANDIDATE_BASELINE_CHANGED');
      const stagingWorkspace = new LocalWorkspace({ ...workspace.state, rootPath: stagingRoot }, { watch: false, index: false });
      try {
        const restored = await stagingWorkspace.applyChangeSet(plan.recoveryCandidate.changeSet, effectivePermissions);
        if (!restored.ok) throw new Error('CANDIDATE_RESTORE_CONFLICT');
      } finally { stagingWorkspace.close(); }
    }
    if (plan.submissionRepair) {
      if (!plan.recoveryCandidate) throw new Error('CANDIDATE_REQUIRED_FOR_REPAIR');
      repairBaseline = await snapshotWorkspaceFiles(stagingRoot, false);
    }
    const started: AgentRuntimeEvent = {
      invocationId: plan.invocationId,
      type: 'runtime_started',
      visibility: 'user',
      content: `${plan.agent.name} 已在本机开始 ${runtimePhaseLabel(plan.phase)}。`,
      metadata: { executionLocation: 'local', workspaceId: request.workspaceId },
      createdAt: startedAt
    };
    emit(started);
    await preflightRequiredDiscussionDocument(plan, workspace, emit);
    const executionPlan = plan.submissionRepair ? { ...plan,
      toolCatalog: { tools: [], decisions: [], catalogHash: 'submission-repair-no-tools' },
      executionTarget: { ...plan.executionTarget, writeMode: 'none' as const, requiredCapabilities: [], requiredToolIds: [] },
      contextEnvelope: { ...plan.contextEnvelope, L2: { source: 'generated' as const, modules: [] },
        L3: { files: [], fileRevisions: [], totalByteLength: 0, truncated: false }, L4: { calls: [] },
        L5: { bullets: ['Repair only the supplied submission shape. Do not develop, run tests, or invent missing facts.',
          JSON.stringify({ originalSubmission: plan.recoveryCandidate?.originalSubmission,
            schemaErrors: plan.recoveryCandidate?.schemaErrors,
            artifactRefs: plan.recoveryCandidate?.changeSet.changes.map(change => change.operation === 'move' ? change.toPath : change.path) })], turnCount: 1 } }
    } : plan;
    const adapterResult = await getLocalRuntimeAdapter(plan.executionTarget.runtimeType).execute({
      plan: executionPlan,
      cwd: stagingRoot,
      signal,
      permissions: plan.submissionRepair ? { workspace_read: 'deny', workspace_write: 'deny', workspace_delete: 'deny',
        command_execute: 'deny', test_execute: 'deny', dependency_install: 'deny' } : effectivePermissions,
      emit,
      ...(providerConnection ? { providerConnection } : {})
    });
    const after = githubTask ? undefined : await snapshotWorkspaceFiles(stagingRoot, true);
    if (repairBaseline && after && (repairBaseline.size !== after.size ||
      [...repairBaseline].some(([path, snapshot]) => snapshot.hash.value !== after.get(path)?.hash.value))) {
      throw new Error('CANDIDATE_REPAIR_SIDE_EFFECT_DETECTED');
    }
    const changeSet = captureState && after ? buildChangeSet(currentRevision, captureState.before, after) : null;
    if (githubTask && githubBaseCommit) {
      githubCandidate = await captureGitTaskCandidate({ worktreePath: stagingRoot,
        sessionId: githubTask.sessionId, taskId: githubTask.taskId, baseCommit: githubBaseCommit });
    }
    if (changeSet) executionCandidate = captureExecutionCandidate(plan, changeSet, effectivePermissions);
    const output = adapterResult.output.schemaVersion === '2.0'
      ? materializeTaskSubmission(adapterResult.output, githubCandidate?.changedPaths ??
        (changeSet?.changes ?? []).flatMap(change =>
          change.operation === 'move' ? [change.fromPath, change.toPath] : [change.path]))
      : adapterResult.output;
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
      content: `${plan.agent.name} 已在本机完成 ${runtimePhaseLabel(plan.phase)}。`,
      metadata: { executionLocation: 'local', changedFileCount: changeSet?.changes.length ?? 0 },
      createdAt: new Date().toISOString()
    };
    emit(completed);
    if (executionCandidate) executionCandidate.stage = 'submission_validated';
    return {
      executionCandidate,
      githubCandidate,
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
      ...(changeSet && (plan.submissionRepair || shouldApplyStagedChangeSet(plan.executionTarget.writeMode))
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
    if (String(error).includes('CANDIDATE_REPAIR_SIDE_EFFECT')) executionCandidate = undefined;
    // Adapter execution resolves/rejects only after its process closes. Preserve bounded text evidence before staging cleanup.
    if (captureState && !String(error).includes('CANDIDATE_')) {
      try {
        const after = await snapshotWorkspaceFiles(captureState.stagingRoot, true);
        const changeSet = buildChangeSet(captureState.revision, captureState.before, after);
        executionCandidate = captureExecutionCandidate(plan, changeSet ?? {
          id: randomUUID(), baseRevision: captureState.revision, changes: [], createdAt: new Date().toISOString()
        }, captureState.permissions);
      } catch { /* Unsupported or incomplete snapshots cannot be advertised as recoverable. */ }
    }
    if (executionCandidate && error instanceof SubmissionError) {
      const encoded = JSON.stringify(error.originalSubmission);
      if (encoded && Buffer.byteLength(encoded, 'utf8') <= 256_000) executionCandidate.originalSubmission = error.originalSubmission;
      executionCandidate.schemaErrors = error.schemaErrors.slice(0, 32);
    }
    const cancelled = signal.aborted;
    const preservedRuntimeError = error instanceof SubmissionError
      ? { code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' as const, message: error.message, retryable: false }
      : extractLocalRuntimeError(error);
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
      content: cancelled ? '本机 Runtime 调用已中断。' : '本机 Runtime 调用失败。',
      metadata: { message, executionLocation: 'local' },
      createdAt: new Date().toISOString()
    };
    emit(event);
    return {
      executionCandidate,
      invocationId: plan.invocationId,
      runtimeType: plan.executionTarget.runtimeType,
      status: cancelled ? 'cancelled' : 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [event],
      artifacts: [],
      systemEvidence: {
        workspaceChangeSet: executionCandidate?.changeSet ?? null,
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
    if (stagingContainer) await rm(stagingContainer, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A changed global revision is recoverable only for hash-verified, read-only evidence. */
export async function revalidateReadOnlyEvidence(plan: InvocationPlan, workspace: LocalWorkspace): Promise<boolean> {
  const files = plan.contextEnvelope.L3.files ?? [];
  if (plan.executionTarget.writeMode !== 'none' || plan.phase === 'task_execution' || plan.recoveryCandidate ||
      plan.contextEnvelope.L3.fileRevisions?.length || files.length === 0 || files.length > 32) return false;
  const revision = await workspace.revision();
  try {
    for (const file of files) {
      if (!file.hash || !isUsableWorkspaceEvidencePath(file.path)) return false;
      const metadata = await workspace.statFile({ path: file.path });
      if (metadata.kind !== 'file' || metadata.hash?.value !== file.hash.value) return false;
    }
    return (await workspace.revision()).id === revision.id;
  } catch { return false; }
}

const requiredDiscussionDocumentMaxBytes = 200_000;

async function preflightRequiredDiscussionDocument(
  plan: InvocationPlan,
  workspace: LocalWorkspace,
  emit: (event: AgentRuntimeEvent) => void
) {
  const requiredDocument = plan.contextEnvelope.L1.requiredDocument;
  if (!requiredDocument) return;

  let read: Awaited<ReturnType<LocalWorkspace['readFile']>>;
  try {
    read = await workspace.readFile({
      path: requiredDocument.relativePath,
      maxBytes: requiredDiscussionDocumentMaxBytes
    });
  } catch (error) {
    throw requiredDocumentPreflightError(
      plan,
      `${requiredDocument.relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (
    read.truncated
    || read.hash?.algorithm !== 'sha256'
    || read.hash.value !== requiredDocument.contentHash
    || contentHash(read.content).value !== requiredDocument.contentHash
  ) {
    throw requiredDocumentPreflightError(
      plan,
      `${requiredDocument.relativePath}: content is truncated or hash does not match.`
    );
  }

  const toolCallId = `required-document:${requiredDocument.documentId}`;
  const metadata = {
    toolCallId,
    name: 'read_file',
    input: { path: requiredDocument.relativePath },
    source: 'runtime_preflight'
  };
  emit({
    invocationId: plan.invocationId,
    type: 'tool_called',
    visibility: 'debug',
    content: `read_file ${requiredDocument.relativePath}`,
    metadata,
    createdAt: new Date().toISOString()
  });
  emit({
    invocationId: plan.invocationId,
    type: 'tool_completed',
    visibility: 'debug',
    content: `已读取文件：${requiredDocument.relativePath}`,
    metadata: { ...metadata, truncated: false },
    createdAt: new Date().toISOString()
  });
}

function requiredDocumentPreflightError(plan: InvocationPlan, detail: string) {
  const requiredDocument = plan.contextEnvelope.L1.requiredDocument;
  if (!requiredDocument) throw new Error(`DOCUMENT_READ_PRECHECK_FAILED: ${detail}`);
  const message = `DOCUMENT_READ_PRECHECK_FAILED: ${detail}`;
  return localRuntimeError({
    code: 'CONTEXT_INSUFFICIENT',
    message,
    retryable: true,
    requestedContext: {
      requestedRefs: [],
      requestedFiles: [{ path: requiredDocument.relativePath, maxBytes: requiredDiscussionDocumentMaxBytes }],
      reason: 'DOCUMENT_READ_PRECHECK_FAILED',
      followUpInstruction: '重试前请确认当前讨论文档存在，且 SHA-256 与要求一致。'
    },
    details: {
      documentId: requiredDocument.documentId,
      documentRevision: requiredDocument.revision,
      relativePath: requiredDocument.relativePath,
      contentHash: requiredDocument.contentHash
    }
  });
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
