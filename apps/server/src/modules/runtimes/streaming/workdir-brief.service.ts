import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { InvocationPlan, RuntimeType } from '@agent-cluster/shared';
import { removeRuntimeDirectorySync } from '../../../common/runtime-directory-cleanup.js';
import { InvocationWorkspaceBindingsService } from '../invocation-workspace-bindings.service.js';

type BriefRuntimeType = Extract<RuntimeType, 'codex' | 'claude_code'>;

type BriefTargetManifest = {
  path: string;
  existed: boolean;
  backupPath: string;
  originalSha256: string;
  appliedSha256?: string;
};

type BriefManifest = {
  version: '0.1';
  status: 'active' | 'restored';
  invocationId: string;
  sessionId: string;
  runtimeType: BriefRuntimeType;
  executionWorkDir: string;
  briefStagingDir: string;
  taskSidecarPath: string;
  leasePath: string;
  createdAt: string;
  restoredAt?: string;
  targets: BriefTargetManifest[];
};

export type WorkdirBriefLease = {
  executionWorkDir: string;
  briefStagingDir: string;
  taskSidecarPath: string;
  restore(): void;
};

@Injectable()
export class WorkdirBriefService {
  private readonly logger = new Logger(WorkdirBriefService.name);

  constructor(private readonly workspaceBindings: InvocationWorkspaceBindingsService) {}

  prepare(input: InvocationPlan, runtimeType: BriefRuntimeType): WorkdirBriefLease | undefined {
    if ((process.env.AGENT_CLUSTER_WORKDIR_BRIEF ?? 'true').trim().toLowerCase() === 'false') {
      return undefined;
    }
    const boundRoot = this.workspaceBindings.resolveServerRoot(input);
    const executionWorkDir = boundRoot ? resolve(boundRoot) : undefined;
    if (!executionWorkDir || !existsSync(executionWorkDir)) return undefined;

    const root = this.stagingRoot();
    const briefStagingDir = join(root, 'runs', input.sessionId, input.invocationId);
    const leasePath = join(root, 'leases', `${sha256(Buffer.from(executionWorkDir, 'utf8'))}.json`);
    mkdirSync(dirname(leasePath), { recursive: true });
    mkdirSync(join(briefStagingDir, 'backups'), { recursive: true });
    this.acquireLease(leasePath, input, executionWorkDir, briefStagingDir);
    const manifestPath = join(briefStagingDir, 'backup-manifest.json');

    try {
    const taskSidecarPath = join(briefStagingDir, 'task-brief.json');
    const targetName = runtimeType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    const targetPath = join(executionWorkDir, targetName);
    const backupPath = join(briefStagingDir, 'backups', `${targetName}.bin`);
    const original = existsSync(targetPath) ? readFileSync(targetPath) : Buffer.alloc(0);
    writeFileSync(backupPath, original);
    writeFileSync(taskSidecarPath, `${JSON.stringify(this.taskSidecar(input), null, 2)}\n`, 'utf8');

    const target: BriefTargetManifest = {
      path: targetPath,
      existed: existsSync(targetPath),
      backupPath,
      originalSha256: sha256(original)
    };
    const manifest: BriefManifest = {
      version: '0.1',
      status: 'active',
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      runtimeType,
      executionWorkDir,
      briefStagingDir,
      taskSidecarPath,
      leasePath,
      createdAt: new Date().toISOString(),
      targets: [target]
    };
    this.writeManifest(manifestPath, manifest);

    const merged = mergeInstructionBytes(original, this.instructionBlock(input, runtimeType, taskSidecarPath));
    target.appliedSha256 = sha256(merged);
    atomicWrite(targetPath, merged);
    this.writeManifest(manifestPath, manifest);

    let restored = false;
    return {
      executionWorkDir,
      briefStagingDir,
      taskSidecarPath,
      restore: () => {
        if (restored) return;
        restored = true;
        this.restoreManifest(manifestPath);
      }
    };
    } catch (error) {
      try {
        if (existsSync(manifestPath)) this.restoreManifest(manifestPath);
        else rmSync(leasePath, { force: true });
      } catch {
        // Preserve the manifest/backup for RecoveryService if immediate restore fails.
      }
      throw error;
    }
  }

  recoverAll(): { restored: number; failed: number; expiredRemoved: number } {
    const root = this.stagingRoot();
    const manifests = findFiles(join(root, 'runs'), 'backup-manifest.json');
    let restored = 0;
    let failed = 0;
    for (const manifestPath of manifests) {
      try {
        const manifest = this.readManifest(manifestPath);
        if (manifest.status !== 'active') continue;
        this.restoreManifest(manifestPath);
        restored += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`Failed to recover workdir brief ${manifestPath}: ${String(error)}`);
      }
    }
    return { restored, failed, expiredRemoved: this.cleanupExpired(root) };
  }

  deleteSessionDirectory(sessionId: string): void {
    const root = this.stagingRoot();
    const sessionDirectory = resolve(root, 'runs', sessionId);
    assertPathInside(root, sessionDirectory, 'workdir brief session directory');
    for (const manifestPath of findFiles(sessionDirectory, 'backup-manifest.json')) {
      const manifest = this.readManifest(manifestPath);
      if (manifest.sessionId !== sessionId) {
        throw new Error(`Workdir brief manifest does not belong to Session ${sessionId}: ${manifestPath}`);
      }
      if (manifest.status === 'active') this.restoreManifest(manifestPath);
    }
    removeRuntimeDirectorySync(sessionDirectory);
  }

  private acquireLease(
    leasePath: string,
    input: InvocationPlan,
    executionWorkDir: string,
    briefStagingDir: string
  ) {
    let fd: number | undefined;
    try {
      fd = openSync(leasePath, 'wx');
      writeFileSync(
        fd,
        `${JSON.stringify({ invocationId: input.invocationId, sessionId: input.sessionId, executionWorkDir, briefStagingDir })}\n`,
        'utf8'
      );
    } catch (error) {
      throw new Error(`WORKDIR_LEASE_CONFLICT: ${executionWorkDir} (${String(error)})`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private restoreManifest(manifestPath: string) {
    const manifest = this.readManifest(manifestPath);
    if (manifest.status === 'restored') {
      rmSync(manifest.leasePath, { force: true });
      return;
    }
    for (const target of manifest.targets) {
      const original = readFileSync(target.backupPath);
      if (sha256(original) !== target.originalSha256) {
        throw new Error(`Backup hash mismatch for ${target.path}`);
      }
      if (target.existed) atomicWrite(target.path, original);
      else rmSync(target.path, { force: true });

      const restored = target.existed ? readFileSync(target.path) : Buffer.alloc(0);
      if (sha256(restored) !== target.originalSha256) {
        throw new Error(`Restored hash mismatch for ${target.path}`);
      }
    }
    manifest.status = 'restored';
    manifest.restoredAt = new Date().toISOString();
    this.writeManifest(manifestPath, manifest);
    rmSync(manifest.leasePath, { force: true });
  }

  private readManifest(path: string): BriefManifest {
    return JSON.parse(readFileSync(path, 'utf8')) as BriefManifest;
  }

  private writeManifest(path: string, manifest: BriefManifest) {
    atomicWrite(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }

  private instructionBlock(input: InvocationPlan, runtimeType: BriefRuntimeType, sidecarPath: string) {
    const skillRules = input.contextEnvelope.L0.systemRules.filter((rule) => rule.startsWith('[Skill:'));
    return [
      '<!-- agent-cluster:workdir-brief:start -->',
      '# Agent Cluster execution brief',
      '',
      `- Runtime: ${runtimeType}`,
      `- Agent role: ${input.agent.role}`,
      `- Current task: ${input.contextEnvelope.L1.task?.title ?? input.contextEnvelope.L1.sessionGoal}`,
      `- Expected output: ${input.expectedOutput.kind}`,
      `- Task sidecar: ${sidecarPath}`,
      ...(skillRules.length > 0 ? ['', '## Bound skills', ...skillRules.map((rule) => `- ${rule}`)] : []),
      '<!-- agent-cluster:workdir-brief:end -->'
    ].join('\n');
  }

  private taskSidecar(input: InvocationPlan) {
    return {
      schemaVersion: '1.0',
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      phase: input.phase,
      agent: {
        id: input.agent.agentId,
        key: input.agent.key,
        role: input.agent.role
      },
      expectedOutput: input.expectedOutput,
      contextEnvelope: input.contextEnvelope
    };
  }

  private stagingRoot() {
    return resolve(
      process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR ??
        join(process.env.AGENT_CLUSTER_DATA_DIR ?? join(process.cwd(), '.cache', 'agent-cluster'), 'workdir-briefs')
    );
  }

  private cleanupExpired(root: string) {
    const ttlMs = Number(process.env.AGENT_CLUSTER_BRIEF_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const manifestPath of findFiles(join(root, 'runs'), 'backup-manifest.json')) {
      try {
        const manifest = this.readManifest(manifestPath);
        if (manifest.status !== 'restored') continue;
        const timestamp = Date.parse(manifest.restoredAt ?? manifest.createdAt);
        if (timestamp > cutoff) continue;
        rmSync(manifest.briefStagingDir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Leave unreadable entries for manual inspection.
      }
    }
    return removed;
  }
}

function mergeInstructionBytes(original: Buffer, block: string): Buffer {
  const separator = original.length === 0 || original.toString('utf8').endsWith('\n') ? '' : '\n';
  return Buffer.concat([original, Buffer.from(`${separator}${block}\n`, 'utf8')]);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPathInside(root: string, candidate: string, label: string) {
  const normalizedRoot = resolve(root).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  const normalizedCandidate = resolve(candidate).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  if (normalizedCandidate === normalizedRoot || !normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`${label} must be a child of ${root}: ${candidate}`);
  }
}

function atomicWrite(path: string, content: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.agent-cluster-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tempPath, content);
  try {
    renameSync(tempPath, path);
  } catch {
    writeFileSync(path, content);
    rmSync(tempPath, { force: true });
  }
}

function findFiles(root: string, fileName: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === fileName && statSync(path).isFile()) found.push(path);
    }
  };
  visit(root);
  return found;
}
