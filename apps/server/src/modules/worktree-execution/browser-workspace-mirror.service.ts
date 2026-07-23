import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentRunResult,
  FileMetadata,
  InvocationPlan,
  RuntimeWorkspaceExecution,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { safeJoin } from '../../common/path-safety.js';
import { removeRuntimeDirectory } from '../../common/runtime-directory-cleanup.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import type { BrowserBrokerProvider } from '../workspaces/browser-broker/browser-broker-provider.js';
import { isWorkspaceSensitivePath } from '../workspaces/workspace-sensitive-guard.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { runGit, runGitText } from './git-command.js';
import { buildWorktreeChangeSet } from './worktree-change-set.js';

const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;

export type BrowserMirrorManifest = {
  sessionId: string;
  workspaceId: string;
  mirrorRoot: string;
  baseCommit: string;
  baseRevision: WorkspaceRevision;
  baselineHashes: Record<string, string>;
  baselineContents: Record<string, string>;
  skippedFiles: string[];
  captureChanges: boolean;
  createdAt: string;
};

export type BrowserMirrorExecutionLease = {
  manifest: BrowserMirrorManifest;
  release(): void;
};

type MirrorFile = Extract<FileMetadata, { kind: 'file' }>;

@Injectable()
export class BrowserWorkspaceMirrorService {
  private readonly contexts = new Map<string, BrowserMirrorManifest>();
  private readonly preparing = new Map<string, Promise<BrowserMirrorManifest>>();

  constructor(
    private readonly workspaceBindings: InvocationWorkspaceBindingsService,
    private readonly workspaceProviders: WorkspaceProviderResolver
  ) {}

  shouldManage(input: InvocationPlan) {
    return (
      input.executionTarget.workspaceProviderKind === 'browser_broker' &&
      ['codex', 'claude_code'].includes(input.executionTarget.runtimeType)
    );
  }

  async prepare(input: InvocationPlan): Promise<BrowserMirrorExecutionLease> {
    const workspaceId = input.contextEnvelope.workspaceId;
    const provider = this.workspaceProviders.resolveBrowser(workspaceId);
    const baseRevision = await provider.getRevision();
    const key = `${input.invocationId}:${baseRevision.id}`;
    let manifest = this.contexts.get(key);
    if (manifest && !(await exists(manifest.mirrorRoot))) {
      this.contexts.delete(key);
      manifest = undefined;
    }
    if (!manifest) {
      let pending = this.preparing.get(key);
      if (!pending) {
        pending = this.createMirror(input, provider, baseRevision, key);
        this.preparing.set(key, pending);
      }
      try {
        manifest = await pending;
        this.contexts.set(key, manifest);
      } finally {
        this.preparing.delete(key);
      }
    }
    this.workspaceBindings.bindInvocation(input.invocationId, manifest.mirrorRoot);
    return {
      manifest,
      release: () => this.workspaceBindings.unbindInvocation(input.invocationId)
    };
  }

  async capture(lease: BrowserMirrorExecutionLease, result: AgentRunResult): Promise<AgentRunResult> {
    const { manifest } = lease;
    const changeSet = await buildWorktreeChangeSet({
      worktreeRoot: manifest.mirrorRoot,
      baseCommit: manifest.baseCommit,
      baseRevision: manifest.baseRevision,
      baselineHashes: manifest.baselineHashes
    });
    if (!manifest.captureChanges && changeSet.changes.length) {
      throw new Error('Browser workspace mirror changed during a read-only Runtime invocation.');
    }
    const runtimeSession = { ...result.runtimeSession, workDir: manifest.mirrorRoot };
    if (!manifest.captureChanges) {
      return { ...result, runtimeSession };
    }

    const workspaceExecution: RuntimeWorkspaceExecution = {
      mode: 'browser_mirror',
      workspaceId: manifest.workspaceId,
      baseRevision: manifest.baseRevision,
      changeSet,
      dirtyBaseline: false,
      requiresUserConfirmation: true
    };
    return {
      ...result,
      systemEvidence: {
        ...result.systemEvidence,
        workspaceChangeSet: changeSet,
        capturedAt: new Date().toISOString(),
        invocationId: result.invocationId
      },
      runtimeSession,
      workspaceExecution
    };
  }

  async deleteSessionDirectory(sessionId: string): Promise<void> {
    const stagingRoot = this.stagingRoot();
    const sessionDirectory = join(stagingRoot, 'runs', safeSegment(sessionId));
    assertPathInside(stagingRoot, sessionDirectory, 'browser workspace mirror session directory');
    await Promise.all([...this.preparing.values()]);
    await removeRuntimeDirectory(sessionDirectory);
    for (const [key, manifest] of this.contexts) {
      if (manifest.sessionId === sessionId) this.contexts.delete(key);
    }
  }

  private async createMirror(
    input: InvocationPlan,
    provider: BrowserBrokerProvider,
    baseRevision: WorkspaceRevision,
    key: string
  ): Promise<BrowserMirrorManifest> {
    const stagingRoot = this.stagingRoot();
    const mirrorRoot = join(stagingRoot, 'runs', safeSegment(input.sessionId), safeSegment(key));
    assertPathInside(stagingRoot, mirrorRoot, 'browser workspace mirror');
    await rm(mirrorRoot, { recursive: true, force: true });
    await mkdir(mirrorRoot, { recursive: true });

    const files = await this.listFiles(provider);
    const baselineHashes: Record<string, string> = {};
    const baselineContents: Record<string, string> = {};
    const skippedFiles: string[] = [];
    const maxFileBytes = positiveLimit('AGENT_CLUSTER_BROWSER_MIRROR_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES);
    const maxTotalBytes = positiveLimit('AGENT_CLUSTER_BROWSER_MIRROR_MAX_TOTAL_BYTES', DEFAULT_MAX_TOTAL_BYTES);
    let totalBytes = 0;

    for (let offset = 0; offset < files.length; offset += 8) {
      const batch = await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          if (file.size > maxFileBytes) return { file, skipped: true as const };
          const read = await provider.readFile({ path: file.path, maxBytes: maxFileBytes + 1 });
          if (read.revision.id !== baseRevision.id || read.hash.value !== file.hash.value) {
            throw new Error(`Browser workspace changed while preparing the Runtime mirror: ${file.path}`);
          }
          const content = Buffer.from(read.content, 'utf8');
          const contentHash = createHash('sha256').update(content).digest('hex');
          if (read.truncated || content.length !== read.byteLength || contentHash !== read.hash.value) {
            return { file, skipped: true as const };
          }
          return { file, content, text: read.content, skipped: false as const };
        })
      );
      for (const item of batch) {
        if (item.skipped) {
          skippedFiles.push(item.file.path);
          continue;
        }
        totalBytes += item.content.length;
        if (totalBytes > maxTotalBytes) {
          throw new Error(`Browser workspace mirror exceeds the ${maxTotalBytes} byte materialization limit.`);
        }
        const target = safeJoin(mirrorRoot, item.file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, item.content);
        baselineHashes[item.file.path] = item.file.hash.value;
        baselineContents[item.file.path] = item.text;
      }
    }

    await runGit(mirrorRoot, ['init']);
    await runGit(mirrorRoot, ['config', 'user.name', 'Agent Cluster']);
    await runGit(mirrorRoot, ['config', 'user.email', 'agent-cluster@local.invalid']);
    await runGit(mirrorRoot, ['add', '-f', '--', '.']);
    await runGit(mirrorRoot, ['commit', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'agent-cluster browser mirror baseline']);
    const baseCommit = await runGitText(mirrorRoot, ['rev-parse', 'HEAD']);
    return {
      sessionId: input.sessionId,
      workspaceId: input.contextEnvelope.workspaceId,
      mirrorRoot,
      baseCommit,
      baseRevision,
      baselineHashes,
      baselineContents,
      skippedFiles,
      captureChanges:
        input.phase === 'task_execution' && input.executionTarget.writeMode !== 'none',
      createdAt: new Date().toISOString()
    };
  }

  private async listFiles(provider: BrowserBrokerProvider): Promise<MirrorFile[]> {
    const maxFiles = positiveLimit('AGENT_CLUSTER_BROWSER_MIRROR_MAX_FILES', DEFAULT_MAX_FILES);
    const maxDepth = positiveLimit('AGENT_CLUSTER_BROWSER_MIRROR_MAX_DEPTH', DEFAULT_MAX_DEPTH);
    const directories: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
    const files: MirrorFile[] = [];
    while (directories.length) {
      const directory = directories.shift()!;
      let cursor: string | undefined;
      do {
        const page = await provider.listDirectory({ path: directory.path, cursor, limit: 200 });
        for (const entry of page.entries) {
          if (isWorkspaceSensitivePath(entry.path)) continue;
          if (entry.kind === 'directory') {
            if (directory.depth >= maxDepth) {
              throw new Error(`Browser workspace mirror exceeds the maximum depth at: ${entry.path}`);
            }
            directories.push({ path: entry.path, depth: directory.depth + 1 });
          } else {
            files.push(entry);
            if (files.length > maxFiles) {
              throw new Error(`Browser workspace mirror exceeds the ${maxFiles} file materialization limit.`);
            }
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private stagingRoot() {
    return resolve(
      process.env.AGENT_CLUSTER_BROWSER_MIRROR_ROOT ??
        join(process.env.AGENT_CLUSTER_DATA_DIR ?? join(process.cwd(), '.cache', 'agent-cluster'), 'browser-runtime-mirrors')
    );
  }
}

function safeSegment(value: string) {
  const label = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'id';
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

function positiveLimit(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function exists(path: string) {
  return access(path).then(() => true).catch(() => false);
}
