import { spawn } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

function gitTimeoutMs() {
  const parsed = Number(process.env.AGENT_CLUSTER_WORKTREE_GIT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  input?: Buffer
): Promise<Buffer> {
  const maxBuffer = Number(process.env.AGENT_CLUSTER_WORKTREE_GIT_MAX_BUFFER ?? DEFAULT_MAX_BUFFER);
  const timeoutMs = gitTimeoutMs();
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new GitCommandError(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, null, ''));
        }, timeoutMs)
      : undefined;

    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.kill();
        reject(new GitCommandError(`git output exceeded ${maxBuffer} bytes`, null, ''));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new GitCommandError(`git ${args.join(' ')} failed${errorText ? `: ${errorText}` : ''}`, code, errorText));
    });

    if (input?.length) child.stdin.write(input);
    child.stdin.end();
  });
}

export async function runGitText(cwd: string, args: readonly string[], input?: Buffer) {
  return (await runGit(cwd, args, input)).toString('utf8').trim();
}
