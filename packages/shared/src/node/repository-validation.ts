import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { DeliveryValidation, RepositoryValidationCommand } from '../contracts.js';

const environmentKeys = new Set([
  'appdata', 'comspec', 'home', 'lang', 'localappdata', 'no_color', 'path',
  'pathext', 'systemroot', 'temp', 'tmp', 'userprofile', 'windir'
]);

export async function detectRepositoryValidation(root: string): Promise<RepositoryValidationCommand | undefined> {
  let manifest: unknown;
  try {
    const bytes = await readFile(resolve(root, 'package.json'));
    if (bytes.length > 1_000_000) return undefined;
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  const record = manifest as Record<string, unknown>;
  const scripts = record.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined;
  const entries = scripts as Record<string, unknown>;
  const selected = ['test', 'typecheck'].find((name) =>
    typeof entries[name] === 'string' && Boolean((entries[name] as string).trim()) &&
    !/no test specified/i.test(entries[name] as string));
  if (!selected) return undefined;
  const declared = typeof record.packageManager === 'string' ? record.packageManager.split('@')[0] : undefined;
  const program = declared === 'pnpm' || declared === 'yarn' || declared === 'npm'
    ? declared : await exists(resolve(root, 'pnpm-lock.yaml')) ? 'pnpm'
      : await exists(resolve(root, 'yarn.lock')) ? 'yarn' : 'npm';
  return { program, args: ['run', selected], relativeCwd: '.' };
}

export async function runRepositoryValidation(input: {
  root: string;
  candidateSha: string;
  command: RepositoryValidationCommand;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DeliveryValidation> {
  if (!/^[a-f0-9]{40}$/i.test(input.candidateSha)) throw new Error('GITHUB_VALIDATION_CANDIDATE_INVALID');
  const root = await realpath(input.root);
  const cwd = await realpath(resolve(root, input.command.relativeCwd));
  const relativePath = relative(root, cwd).replace(/\\/g, '/');
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('GITHUB_VALIDATION_PATH_DENIED');
  }
  const { program, args } = input.command;
  if (!program || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('GITHUB_VALIDATION_COMMAND_INVALID');
  }
  const packageManager = ['npm', 'pnpm', 'yarn'].includes(program);
  if (packageManager && (args.length !== 2 || args[0] !== 'run' ||
      !/^[a-zA-Z0-9:_-]{1,80}$/.test(args[1] ?? ''))) {
    throw new Error('GITHUB_VALIDATION_COMMAND_INVALID');
  }
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 300_000, 1_000), 900_000);
  const environment: NodeJS.ProcessEnv = { CI: 'true', GIT_TERMINAL_PROMPT: '0' };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && environmentKeys.has(key.toLowerCase())) environment[key] = value;
  }
  const outcome = await new Promise<{ exitCode: number; reason?: string; outputBytes: number }>((done) => {
    let completed = false;
    let outputBytes = 0;
    let reason: string | undefined;
    const executable = packageManager && process.platform === 'win32' ? `${program}.cmd` : program;
    const child = spawn(executable, args, {
      cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      shell: packageManager && process.platform === 'win32', detached: process.platform !== 'win32'
    });
    const finish = (exitCode: number) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      done({ exitCode, reason, outputBytes });
    };
    const stop = (code: string) => {
      reason = code;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      } else if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'],
          { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', (code) => { if (code !== 0) child.kill(); });
      } else child.kill();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8_000_000 && !reason) stop('output_limit');
    });
    child.on('error', () => { reason = 'unavailable'; finish(-1); });
    child.on('close', (code) => finish(reason ? -1 : code ?? -1));
  });
  return {
    candidateSha: input.candidateSha,
    command: packageManager ? `${program} run ${args[1]}` : `${basename(program)} (${args.length} args)`,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    outputSummary: outcome.reason
      ? `Validation ${outcome.reason}; ${outcome.outputBytes} output bytes.`
      : `Validation exited with code ${outcome.exitCode}; ${outcome.outputBytes} output bytes.`,
    completedAt: new Date().toISOString()
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}
