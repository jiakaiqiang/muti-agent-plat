import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { IntentTestRunnerBinding } from '@agent-cluster/shared';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { isSensitivePath } from '../../common/path-safety.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { IsolatedTestRunStore, type TestRunIdentity } from './isolated-test-run-store.js';

export type IsolatedTestResult = {
  stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean; error?: string;
  isolation: { runnerId: string; imageId: string; containerName: string; snapshotHash?: string;
    stopConfirmed: boolean; cleanupRequired: boolean; outputTruncated: boolean; daemonId?: string };
};
type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; truncated: boolean };
const runnerId = 'docker-npm-tests-v1';
const allowedScripts = new Set(['test', 'test:unit', 'test:integration']);
const ignoredDirectories = new Set(['.git', '.cache', '.codex', '.claude', 'node_modules', 'coverage', 'dist', 'build']);

// The image and this bootstrap are server policy. No user/model command or Docker flags are accepted.
const bootstrap = `const fs=require('node:fs'),cp=require('node:child_process');
fs.mkdirSync('/scratch/project',{recursive:true});fs.mkdirSync('/scratch/tmp',{recursive:true});
fs.cpSync('/input','/scratch/project',{recursive:true});
const result=cp.spawnSync('npm',['run','--silent','--ignore-scripts',process.argv[1]],{cwd:'/scratch/project',stdio:'inherit',env:process.env});
if(result.error){console.error(result.error.message);process.exit(125)}process.exit(result.status===null?125:result.status);`;

@Injectable()
export class IsolatedTestRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IsolatedTestRunnerService.name);
  private readonly store?: IsolatedTestRunStore;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;
  private readonly active = new Set<AbortController>();
  constructor(@Optional() persistence?: PersistenceService) { if (persistence) this.store = new IsolatedTestRunStore(persistence); }
  onModuleInit() {
    if (!this.store) return;
    void this.recoverExpired().catch(() => undefined);
    this.recoveryTimer = setInterval(() => { void this.recoverExpired().catch(() => undefined); }, 10_000);
    this.recoveryTimer.unref();
  }
  onModuleDestroy() { if (this.recoveryTimer) clearInterval(this.recoveryTimer); for (const controller of this.active) controller.abort(); }

  async recoverExpired() {
    if (!this.store || this.recovering) return;
    this.recovering = true;
    try {
      for (const candidate of this.store.candidates()) {
        try {
        const ownerId = randomUUID(), { identity } = candidate;
        const attempt = await this.store.claimRecovery(identity, ownerId);
        if (!attempt) continue;
        let confirmed = false;
        try {
          if (!attempt.daemonId) confirmed = attempt.stopConfirmed && !attempt.snapshotHash;
          else confirmed = await this.removeOwnedContainer(attempt.containerName, attempt.identityHash, attempt.imageId, attempt.daemonId);
          if (confirmed && attempt.snapshotDirectory) await removeSnapshot(attempt.snapshotDirectory);
        } catch { confirmed = false; }
        await this.store.finishRecovery(identity, ownerId, confirmed);
        } catch {
          // A corrupt/unavailable record must not starve reconciliation of other containers.
          this.logger.warn(`Isolated test reconciliation deferred for ${candidate.identity.invocationId}`);
        }
      }
    } finally { this.recovering = false; }
  }
  private async daemonId() {
    const response = await this.command(['info', '--format', '{{.ID}}'], 5_000);
    if (response.code !== 0 || !response.stdout.trim()) throw new Error('ISOLATED_TEST_DAEMON_UNAVAILABLE');
    return response.stdout.trim();
  }
  private async removeOwnedContainer(name: string, label: string, imageId: string, daemonId: string) {
    if (await this.daemonId() !== daemonId) return false;
    const inspected = await this.command(['inspect', name, '--format', '{{index .Config.Labels "agent-cluster.intent-test"}}|{{.Config.Image}}'], 5_000);
    if (inspected.code !== 0) return /No such (object|container)/i.test(inspected.stderr);
    if (inspected.stdout.trim() !== `${label}|${imageId}`) return false;
    await this.command(['rm', '--force', name], 10_000);
    const remaining = await this.command(['inspect', name, '--format', '{{.Id}}'], 5_000);
    return remaining.code !== 0 && /No such (object|container)/i.test(remaining.stderr);
  }
  protected command(args: string[], timeout: number, signal?: AbortSignal) { return docker(args, timeout, signal); }

  isConfigured() { return Boolean(process.env.INTENT_ISOLATED_TEST_IMAGE); }

  async authorize(identity: TestRunIdentity, workingDirectory: string, script: string, expected: IntentTestRunnerBinding) {
    if (!this.store) throw new Error('ISOLATED_TEST_JOURNAL_UNAVAILABLE');
    const actual = await this.store.authorize(identity, { workingDirectory, script, imageId: process.env.INTENT_ISOLATED_TEST_IMAGE ?? '' });
    if (!isDeepStrictEqual(actual, expected)) throw new Error('ISOLATED_TEST_RUNNER_BINDING_MISMATCH');
  }

  async run(input: { workingDirectory: string; script: string; timeoutMs: number; signal?: AbortSignal;
    execution?: TestRunIdentity;
    /** Optional transaction guard supplied by the execution owner, checked after snapshot and before launch. */
    beforeLaunch?: () => Promise<void> }): Promise<IsolatedTestResult> {
    const imageId = process.env.INTENT_ISOLATED_TEST_IMAGE ?? '';
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('ISOLATED_TEST_IMAGE_REQUIRED');
    if (!allowedScripts.has(input.script)) throw new Error('ISOLATED_TEST_SCRIPT_NOT_ALLOWED');
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('ISOLATED_TEST_TIMEOUT_INVALID');
    let deadline = Date.now() + Math.min(120_000, Math.max(1, Math.floor(input.timeoutMs)));
    const ownerId = randomUUID();
    if (input.execution && !this.store) throw new Error('ISOLATED_TEST_JOURNAL_UNAVAILABLE');
    const attempt = input.execution ? await this.store!.reserve(input.execution, { imageId, script: input.script, workingDirectory: input.workingDirectory,
      ownerId, deadlineAt: new Date(deadline).toISOString() }) : undefined;
    if (attempt) deadline = Date.parse(attempt.deadlineAt);
    const name = attempt?.containerName ?? `intent-test-${randomUUID()}`;
    const controller = new AbortController(), originalSignal = input.signal;
    const forward = () => controller.abort(originalSignal?.reason);
    if (originalSignal?.aborted) forward(); else originalSignal?.addEventListener('abort', forward, { once: true });
    input = { ...input, signal: controller.signal }; this.active.add(controller);
    let renewing: Promise<unknown> | undefined;
    const heartbeat = attempt ? setInterval(() => {
      if (renewing) return;
      renewing = this.store!.update(input.execution!, ownerId, {}, true).catch(() => controller.abort()).finally(() => { renewing = undefined; });
    }, 10_000) : undefined;
    heartbeat?.unref();
    const persist = async (update: Parameters<IsolatedTestRunStore['update']>[2], active = false) => {
      if (attempt) await this.store!.update(input.execution!, ownerId, update, active);
    };
    const result: IsolatedTestResult = { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: false,
      isolation: { runnerId, imageId, containerName: name, stopConfirmed: true, cleanupRequired: false, outputTruncated: false } };
    let snapshotDirectory: string | undefined, created = false;
    const guard = () => { if (input.signal?.aborted) throw new Error('ISOLATED_TEST_ABORTED'); if (Date.now() >= deadline) throw new Error('ISOLATED_TEST_TIMEOUT'); };
    try {
      guard();
      result.isolation.daemonId = await this.daemonId();
      await persist({ daemonId: result.isolation.daemonId }, true);
      const inspected = await this.command(['image', 'inspect', imageId, '--format', '{{.Os}}|{{json (index .Config "Volumes")}}'], Math.min(10_000, deadline - Date.now()), input.signal);
      const [os, declaredVolumes] = inspected.stdout.trim().split('|');
      if (inspected.code !== 0 || os !== 'linux' || !declaredVolumes) throw new Error('ISOLATED_TEST_IMAGE_UNAVAILABLE');
      if (Object.keys(JSON.parse(declaredVolumes) ?? {}).length) throw new Error('ISOLATED_TEST_IMAGE_VOLUMES_NOT_ALLOWED');
      // Persist the path before allocating it so a crash cannot orphan an untracked snapshot.
      snapshotDirectory = join(tmpdir(), `intent-test-snapshot-${randomUUID()}`);
      await persist({ snapshotDirectory }, true);
      await mkdir(snapshotDirectory);
      const source = join(snapshotDirectory, 'source'); await mkdir(source);
      result.isolation.snapshotHash = await snapshot(input.workingDirectory, source, guard);
      await persist({ phase: 'prepared', snapshotHash: result.isolation.snapshotHash }, true);
      guard(); await input.beforeLaunch?.(); guard();
      const mountSource = resolve(source);
      if (/[\r\n,]/.test(mountSource)) throw new Error('ISOLATED_TEST_MOUNT_INVALID');
      // Record uncertainty before sending a create request that might outlive this process.
      await persist({ phase: 'created', stopConfirmed: false, cleanupRequired: true }, true);
      created = true; result.isolation.stopConfirmed = false;
      const create = await this.command(['create', '--name', name, '--label', `agent-cluster.intent-test=${attempt?.identityHash ?? name}`, '--pull', 'never', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '128', '--no-healthcheck',
        '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--ipc', 'none',
        '--tmpfs', '/scratch:rw,nosuid,nodev,size=268435456,mode=1777',
        '--mount', `type=bind,src=${mountSource},dst=/input,readonly`, '--workdir', '/scratch', '--entrypoint', '/usr/bin/env',
        imageId, '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch/tmp',
        'npm_config_cache=/scratch/npm-cache', 'npm_config_update_notifier=false', 'npm_config_audit=false',
        'node', '-e', bootstrap, input.script], Math.min(15_000, deadline - Date.now()), input.signal);
      // Even an interrupted create may have reached the daemon; always reconcile this unique name.
      if (create.code !== 0) throw new Error('ISOLATED_TEST_CONTAINER_CREATE_FAILED');
      guard(); await input.beforeLaunch?.(); guard();
      await persist({ phase: 'running' }, true);
      const run = await this.command(['start', '--attach', name], deadline - Date.now(), input.signal);
      result.stdout = run.stdout; result.stderr = run.stderr; result.isolation.outputTruncated = run.truncated;
      result.timedOut = run.timedOut; result.aborted = run.aborted || Boolean(input.signal?.aborted);
      if (result.timedOut || result.aborted) result.error = result.aborted ? 'ISOLATED_TEST_ABORTED' : 'ISOLATED_TEST_TIMEOUT';
      else {
        const state = await this.command(['inspect', '--format', '{{json .State}}', name], 5_000);
        if (state.code !== 0) throw new Error('ISOLATED_TEST_STATE_UNKNOWN');
        const status = JSON.parse(state.stdout) as { Running?: boolean; ExitCode?: number; OOMKilled?: boolean };
        if (status.Running !== false || !Number.isInteger(status.ExitCode)) throw new Error('ISOLATED_TEST_STATE_UNKNOWN');
        result.exitCode = status.ExitCode!;
        if (status.OOMKilled) result.error = 'ISOLATED_TEST_MEMORY_LIMIT';
        else if (result.exitCode !== 0) result.error = 'ISOLATED_TEST_FAILED';
      }
    } catch (error) {
      result.error = error instanceof Error && /^ISOLATED_TEST_[A-Z_]+$/.test(error.message) ? error.message : 'ISOLATED_TEST_PREPARATION_FAILED';
      result.aborted ||= Boolean(input.signal?.aborted);
      result.timedOut ||= Date.now() >= deadline;
    } finally {
      try {
        if (created) {
          result.isolation.stopConfirmed = await this.removeOwnedContainer(name, attempt?.identityHash ?? name, imageId,
            result.isolation.daemonId!).catch(() => false);
          if (!result.isolation.stopConfirmed) { result.error = 'ISOLATED_TEST_STOP_UNCONFIRMED'; result.exitCode = null; }
        }
        result.isolation.cleanupRequired = !result.isolation.stopConfirmed;
        if (snapshotDirectory && result.isolation.stopConfirmed) {
          try { await removeSnapshot(snapshotDirectory); }
          catch { result.isolation.cleanupRequired = true; result.error = 'ISOLATED_TEST_CLEANUP_FAILED'; }
        }
        if (heartbeat) clearInterval(heartbeat);
        await renewing;
        await persist({ phase: result.isolation.cleanupRequired ? 'reconciliation_required' : 'finished',
          stopConfirmed: result.isolation.stopConfirmed, cleanupRequired: result.isolation.cleanupRequired,
          result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted,
            error: result.error, outputTruncated: result.isolation.outputTruncated } });
      } catch {
        // A result whose journal did not commit must never be published as successful.
        result.error = result.isolation.stopConfirmed ? 'ISOLATED_TEST_JOURNAL_COMMIT_FAILED' : 'ISOLATED_TEST_STOP_UNCONFIRMED';
        result.exitCode = null;
      }
      finally { if (heartbeat) clearInterval(heartbeat); originalSignal?.removeEventListener('abort', forward); this.active.delete(controller); }
    }
    return result;
  }
}

async function snapshot(rootInput: string, destination: string, guard: () => void) {
  const root = await realpath(rootInput), hashes: string[] = []; let bytes = 0, files = 0;
  const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  // Checking only descendants misses a replaced root or a junction in its ancestors.
  if ((await lstat(rootInput)).isSymbolicLink() || !samePath(resolve(rootInput), root)) throw new Error('ISOLATED_TEST_SYMLINK_UNSUPPORTED');
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      guard(); const source = join(directory, entry.name), path = relative(root, source).replace(/\\/g, '/');
      if (isSensitivePath(path) || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error('ISOLATED_TEST_SYMLINK_UNSUPPORTED');
      const canonical = await realpath(source), relativePath = relative(root, canonical);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('ISOLATED_TEST_SNAPSHOT_ESCAPE');
      const target = join(destination, path);
      if (stat.isDirectory()) { await mkdir(target); await visit(source); }
      else if (stat.isFile()) {
        if (++files > 20_000 || (bytes += stat.size) > 128 * 1024 * 1024) throw new Error('ISOLATED_TEST_SNAPSHOT_LIMIT');
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const current = await handle.stat();
          if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('ISOLATED_TEST_SOURCE_CHANGED');
          const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
          while (offset < buffer.length) {
            guard(); const read = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!read.bytesRead) break; offset += read.bytesRead;
          }
          const contents = buffer.subarray(0, offset); guard();
          const after = await handle.stat();
          if (contents.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('ISOLATED_TEST_SOURCE_CHANGED');
          hashes.push(`${path}\0${createHash('sha256').update(contents).digest('hex')}`);
          await writeFile(target, contents, { flag: 'wx', mode: stat.mode & 0o111 ? 0o755 : 0o644 });
        } finally { await handle.close(); }
      } else throw new Error('ISOLATED_TEST_SPECIAL_FILE_UNSUPPORTED');
    }
  };
  await visit(root);
  return createHash('sha256').update(hashes.join('\n')).digest('hex');
}

async function removeSnapshot(path: string) {
  const lexical = relative(resolve(tmpdir()), resolve(path));
  if (!lexical.startsWith('intent-test-snapshot-') || lexical.includes('..') || isAbsolute(lexical) || lexical.includes('/') || lexical.includes('\\')) throw new Error('ISOLATED_TEST_CLEANUP_PATH_INVALID');
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const root = await realpath(tmpdir()), canonical = await realpath(path), child = relative(root, canonical);
  if (!child.startsWith('intent-test-snapshot-') || child.includes('..') || isAbsolute(child) || child.includes('/') || child.includes('\\')) throw new Error('ISOLATED_TEST_CLEANUP_PATH_INVALID');
  await rm(canonical, { recursive: true, force: true });
}

function docker(args: string[], timeout: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise(resolveResult => {
    if (signal?.aborted) { resolveResult({ code: null, stdout: '', stderr: '', aborted: true, timedOut: false, truncated: false }); return; }
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, aborted = false, truncated = false;
    const collect = (data: Buffer, error: boolean) => {
      const remaining = Math.max(0, 256_000 - stdout.length - stderr.length), text = data.toString('utf8');
      if (text.length > remaining) truncated = true;
      if (error) stderr += text.slice(0, remaining); else stdout += text.slice(0, remaining);
    };
    child.stdout.on('data', data => collect(data, false)); child.stderr.on('data', data => collect(data, true));
    const stop = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, timeout)); timer.unref();
    let settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      resolveResult({ code, stdout, stderr, timedOut, aborted, truncated }); };
    child.once('error', () => finish(null)); child.once('close', code => finish(code));
  });
}
