import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const maximumCapturedOutputBytes = 8 * 1024 * 1024;

const runtimeEnvironmentAllowlist = new Set([
  'appdata',
  'claude_config_dir',
  'codex_home',
  'comspec',
  'force_color',
  'home',
  'http_proxy',
  'https_proxy',
  'lang',
  'lc_all',
  'localappdata',
  'node_extra_ca_certs',
  'no_color',
  'no_proxy',
  'path',
  'pathext',
  'ssl_cert_file',
  'systemroot',
  'temp',
  'term',
  'tmp',
  'userprofile',
  'windir',
  'xdg_config_home'
]);

export function buildRuntimeProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { AGENT_CLUSTER_EXECUTION_LOCATION: 'local' };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && runtimeEnvironmentAllowlist.has(key.toLowerCase())) environment[key] = value;
  }
  return environment;
}

export function runRuntimeCommand(input: {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  signal: AbortSignal;
  shell?: boolean;
  envOverrides?: NodeJS.ProcessEnv;
  /**
   * 每收到一整行 stdout 就回调一次,用于把运行中的进度回传出去。
   * 不传时行为与逐行回调引入前一致;回调抛错不影响进程收敛。
   */
  onStdoutLine?: (line: string) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: input.shell ?? false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildRuntimeProcessEnv(process.env), ...input.envOverrides }
    });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    const emitLine = (line: string) => {
      if (!input.onStdoutLine || !line) return;
      try {
        input.onStdoutLine(line);
      } catch {
        // 进度回传是诊断用途,解析失败不能中断运行时进程。
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
      if (!input.onStdoutLine) return;
      const segments = (pendingLine + chunk).split(/\r?\n/);
      pendingLine = segments.pop() ?? '';
      for (const segment of segments) emitLine(segment);
    });
    child.stderr.on('data', (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    const abort = () => { void terminateProcessTree(child); };
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      input.signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      input.signal.removeEventListener('abort', abort);
      // 末行可能没有换行符结尾。
      const trailing = pendingLine;
      pendingLine = '';
      emitLine(trailing);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.end(input.stdin, 'utf8');
  });
}

export async function detectRuntimeVersion(input: {
  command: string;
  args?: string[];
  shell?: boolean;
}): Promise<string | undefined> {
  try {
    const result = await execFileAsync(input.command, input.args ?? ['--version'], {
      timeout: 5_000,
      shell: input.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      env: buildRuntimeProcessEnv(process.env)
    });
    return result.stdout.trim() || result.stderr.trim() || 'available';
  } catch {
    return undefined;
  }
}

export function parseConfiguredArgs(value: string, environmentKey: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${environmentKey} must be a JSON string array.`);
  }
  return parsed;
}

async function terminateProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolveTermination) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => {
        child.kill();
        resolveTermination();
      });
      killer.once('close', () => resolveTermination());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const forceKill = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 2_000);
  forceKill.unref();
  child.once('close', () => clearTimeout(forceKill));
}

function appendBounded(current: string, chunk: string) {
  const next = current + chunk;
  return next.length <= maximumCapturedOutputBytes ? next : next.slice(-maximumCapturedOutputBytes);
}
