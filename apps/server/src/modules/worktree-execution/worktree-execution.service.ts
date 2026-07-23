import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AgentRunResult,
  InvocationPlan,
  RuntimeArtifactOutput,
  RuntimeOutput,
  RuntimeWorkspaceExecution,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { safeJoin } from '../../common/path-safety.js';
import { removeRuntimeDirectory } from '../../common/runtime-directory-cleanup.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { isWorkspaceSensitivePath } from '../workspaces/workspace-sensitive-guard.js';
import { runGit, runGitText } from './git-command.js';
import { buildWorktreeChangeSet } from './worktree-change-set.js';

type WorktreeManifest = {
  version: '0.1';
  sessionId: string;
  taskId: string;
  repositoryId: string;
  repositoryRoot: string;
  sourceWorkDir: string;
  worktreeRoot: string;
  executionWorkDir: string;
  sourceHead: string;
  baseCommit: string;
  baseRevision: WorkspaceRevision;
  dirtyBaseline: boolean;
  baselineHashes: Record<string, string>;
  createdAt: string;
};

export type WorktreeExecutionLease = {
  manifest: WorktreeManifest;
  release(): void;
};

@Injectable()
export class WorktreeExecutionService {
  private readonly contexts = new Map<string, WorktreeManifest>();
  private readonly preparing = new Map<string, Promise<WorktreeManifest>>();

  constructor(private readonly workspaceBindings: InvocationWorkspaceBindingsService) {}

  shouldManage(input: InvocationPlan) {
    if ((process.env.AGENT_CLUSTER_WORKTREE_EXECUTION ?? 'true').trim().toLowerCase() === 'false') return false;
    return (
      input.phase === 'task_execution' &&
      Boolean(input.taskId) &&
      input.executionTarget.workspaceProviderKind === 'server_local' &&
      input.executionTarget.writeMode !== 'none' &&
      ['codex', 'claude_code'].includes(input.executionTarget.runtimeType)
    );
  }

  async prepare(input: InvocationPlan): Promise<WorktreeExecutionLease> {
    if (!input.taskId) throw new Error('Worktree execution requires taskId.');
    const sourceWorkDir = this.workspaceBindings.resolveSessionRoot(input);
    if (!sourceWorkDir) throw new Error('Worktree execution requires a server-local workspace binding.');
    const key = `${input.sessionId}:${input.taskId}`;
    let manifest = this.contexts.get(key);
    if (!manifest) {
      let pending = this.preparing.get(key);
      if (!pending) {
        pending = this.createOrRestore(input.sessionId, input.taskId, sourceWorkDir);
        this.preparing.set(key, pending);
      }
      try {
        manifest = await pending;
        this.contexts.set(key, manifest);
      } finally {
        this.preparing.delete(key);
      }
    }
    this.workspaceBindings.bindInvocation(input.invocationId, manifest.executionWorkDir);
    return {
      manifest,
      release: () => this.workspaceBindings.unbindInvocation(input.invocationId)
    };
  }

  async capture(lease: WorktreeExecutionLease, result: AgentRunResult): Promise<AgentRunResult> {
    const { manifest } = lease;
    const changeSet = await buildWorktreeChangeSet({
      worktreeRoot: manifest.worktreeRoot,
      baseCommit: manifest.baseCommit,
      baseRevision: manifest.baseRevision,
      baselineHashes: manifest.baselineHashes
    });
    const workspaceExecution: RuntimeWorkspaceExecution = {
      mode: 'git_worktree',
      repositoryId: manifest.repositoryId,
      baseRevision: manifest.baseRevision,
      changeSet,
      dirtyBaseline: manifest.dirtyBaseline,
      requiresUserConfirmation: true
    };
    const output = markOutputChangesProposed(result.output);
    return {
      ...result,
      output,
      artifacts: markArtifactChangesProposed(result.artifacts),
      systemEvidence: {
        ...result.systemEvidence,
        workspaceChangeSet: changeSet,
        capturedAt: new Date().toISOString(),
        invocationId: result.invocationId
      },
      runtimeSession: {
        ...result.runtimeSession,
        workDir: manifest.executionWorkDir
      },
      workspaceExecution
    };
  }

  async deleteSessionDirectory(sessionId: string): Promise<void> {
    const stagingRoot = this.stagingRoot();
    const sessionSegment = safeSegment(sessionId);
    const manifestDirectory = join(stagingRoot, 'manifests', sessionSegment);
    const runDirectory = join(stagingRoot, 'runs', sessionSegment);
    assertPathInside(stagingRoot, manifestDirectory, 'managed worktree manifest directory');
    assertPathInside(stagingRoot, runDirectory, 'managed worktree session directory');

    await Promise.all(
      [...this.preparing.entries()]
        .filter(([key]) => key.startsWith(`${sessionId}:`))
        .map(([, pending]) => pending)
    );
    const manifests = await this.readSessionManifests(manifestDirectory, sessionId);
    for (const manifest of manifests) {
      try {
        await runGit(manifest.repositoryRoot, ['worktree', 'remove', '--force', manifest.worktreeRoot]);
      } catch (error) {
        if (await exists(manifest.worktreeRoot)) throw error;
        await runGit(manifest.repositoryRoot, ['worktree', 'prune']);
      }
    }
    await removeRuntimeDirectory(runDirectory);
    await removeRuntimeDirectory(manifestDirectory);
    for (const key of this.contexts.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.contexts.delete(key);
    }
    for (const key of this.preparing.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.preparing.delete(key);
    }
  }

  private async readSessionManifests(directory: string, sessionId: string): Promise<WorktreeManifest[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    const manifests: WorktreeManifest[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const manifest = await this.readManifest(join(directory, entry.name));
      if (!manifest || manifest.sessionId !== sessionId) {
        throw new Error(`Managed worktree manifest does not belong to Session ${sessionId}: ${entry.name}`);
      }
      manifests.push(manifest);
    }
    return manifests;
  }

  private async createOrRestore(sessionId: string, taskId: string, sourceWorkDir: string) {
    const stagingRoot = this.stagingRoot();
    const sessionSegment = safeSegment(sessionId);
    const taskSegment = safeSegment(taskId);
    const manifestPath = join(stagingRoot, 'manifests', sessionSegment, `${taskSegment}.json`);
    const restored = await this.readManifest(manifestPath);
    if (restored && (await exists(restored.executionWorkDir))) return restored;

    const repositoryRoot = resolve(await runGitText(sourceWorkDir, ['rev-parse', '--show-toplevel']));
    assertPathInside(repositoryRoot, resolve(sourceWorkDir), 'selected working directory');
    if (canonicalPath(repositoryRoot) !== canonicalPath(sourceWorkDir)) {
      throw new Error('Managed worktree execution currently requires the selected directory to be the Git repository root.');
    }
    const commonDirText = await runGitText(repositoryRoot, ['rev-parse', '--git-common-dir']);
    const commonDir = await realpath(isAbsolute(commonDirText) ? commonDirText : resolve(repositoryRoot, commonDirText));
    const repositoryId = createHash('sha256').update(canonicalPath(commonDir)).digest('hex');
    const sourceHead = await runGitText(repositoryRoot, ['rev-parse', 'HEAD']);
    const worktreeRoot = join(stagingRoot, 'runs', sessionSegment, taskSegment);
    const executionRelative = relative(repositoryRoot, resolve(sourceWorkDir));
    const executionWorkDir = resolve(worktreeRoot, executionRelative);
    assertPathInside(stagingRoot, worktreeRoot, 'managed worktree');
    await mkdir(dirname(worktreeRoot), { recursive: true });
    if (await exists(worktreeRoot)) throw new Error(`Managed worktree path already exists without a valid manifest: ${worktreeRoot}`);

    let added = false;
    try {
      const baselinePatch = await runGit(repositoryRoot, ['diff', '--binary', 'HEAD', '--']);
      const untracked = nulList(await runGit(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
      const denied = untracked.filter(isWorkspaceSensitivePath);
      if (denied.length) throw new Error(`Dirty baseline contains sensitive untracked paths: ${denied.join(', ')}`);

      await runGit(repositoryRoot, ['worktree', 'add', '--detach', worktreeRoot, sourceHead]);
      added = true;
      if (baselinePatch.length) {
        await runGit(worktreeRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], baselinePatch);
      }
      await this.copyUntracked(repositoryRoot, worktreeRoot, untracked);
      const dirtyBaseline = Boolean(await runGitText(worktreeRoot, ['status', '--porcelain', '--untracked-files=normal']));
      if (dirtyBaseline) {
        await runGit(worktreeRoot, ['add', '-A']);
        await runGit(worktreeRoot, [
          '-c', 'user.name=Agent Cluster',
          '-c', 'user.email=agent-cluster@local.invalid',
          'commit', '--no-verify', '--no-gpg-sign', '-m', `agent-cluster baseline ${sessionId}/${taskId}`
        ]);
      }
      const baseCommit = await runGitText(worktreeRoot, ['rev-parse', 'HEAD']);
      const baselineHashes = await this.captureBaselineHashes(repositoryRoot, worktreeRoot);
      const createdAt = new Date().toISOString();
      const manifest: WorktreeManifest = {
        version: '0.1',
        sessionId,
        taskId,
        repositoryId,
        repositoryRoot,
        sourceWorkDir: resolve(sourceWorkDir),
        worktreeRoot,
        executionWorkDir,
        sourceHead,
        baseCommit,
        baseRevision: { id: `git:${baseCommit}`, observedAt: createdAt },
        dirtyBaseline,
        baselineHashes,
        createdAt
      };
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return manifest;
    } catch (error) {
      if (added) {
        await runGit(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot]).catch(() => undefined);
      }
      await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async copyUntracked(repositoryRoot: string, worktreeRoot: string, paths: string[]) {
    const maxFiles = Number(process.env.AGENT_CLUSTER_WORKTREE_MAX_BASELINE_FILES ?? 512);
    const maxBytes = Number(process.env.AGENT_CLUSTER_WORKTREE_MAX_BASELINE_BYTES ?? 16 * 1024 * 1024);
    if (paths.length > maxFiles) throw new Error(`Dirty baseline has ${paths.length} untracked files, exceeding ${maxFiles}.`);
    let totalBytes = 0;
    for (const path of paths) {
      const source = safeJoin(repositoryRoot, path);
      const target = safeJoin(worktreeRoot, path);
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Dirty baseline cannot copy symbolic link: ${path}`);
      if (!stat.isFile()) continue;
      totalBytes += stat.size;
      if (totalBytes > maxBytes) throw new Error(`Dirty baseline untracked files exceed ${maxBytes} bytes.`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  private async captureBaselineHashes(repositoryRoot: string, worktreeRoot: string) {
    const paths = nulList(await runGit(worktreeRoot, ['ls-files', '-z']));
    const hashes: Record<string, string> = {};
    for (const path of paths) {
      const source = safeJoin(repositoryRoot, path);
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Managed worktree baseline cannot contain a symbolic link: ${path}`);
      if (!stat.isFile()) continue;
      hashes[path] = createHash('sha256').update(await readFile(source)).digest('hex');
    }
    return hashes;
  }

  private async readManifest(path: string): Promise<WorktreeManifest | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as WorktreeManifest;
      return parsed.version === '0.1' && parsed.baselineHashes ? parsed : undefined;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  private stagingRoot() {
    return resolve(
      process.env.AGENT_CLUSTER_WORKTREE_ROOT ??
        join(process.env.AGENT_CLUSTER_DATA_DIR ?? join(process.cwd(), '.cache', 'agent-cluster'), 'execution-worktrees')
    );
  }
}

function markOutputChangesProposed(output: RuntimeOutput): RuntimeOutput {
  if (output.kind !== 'task_execution_result') return output;
  return { ...output, changedArtifacts: markArtifactChangesProposed(output.changedArtifacts) };
}

function markArtifactChangesProposed(artifacts: RuntimeArtifactOutput[]) {
  return artifacts.map((artifact) => {
    const fileChanges = artifact.metadata?.fileChanges;
    if (!fileChanges) return artifact;
    return {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        fileChanges: fileChanges.map((change) => ({ ...change, source: 'runtime_proposed_change' as const }))
      }
    };
  });
}

function safeSegment(value: string) {
  const label = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'id';
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${label}-${hash}`;
}

function canonicalPath(path: string) {
  const normalized = resolve(path).replace(/\\/g, '/').replace(/\/+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertPathInside(root: string, candidate: string, label: string) {
  const normalizedRoot = canonicalPath(root);
  const normalizedCandidate = canonicalPath(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`${label} must be inside ${root}: ${candidate}`);
  }
}

function nulList(content: Buffer) {
  return content.toString('utf8').split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

async function exists(path: string) {
  return access(path).then(() => true).catch(() => false);
}

function isEnoent(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT';
}
