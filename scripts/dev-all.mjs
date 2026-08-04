import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SERVER_PORT = 8099;
const DEFAULT_WEB_PORT = 8089;
const HEALTH_INTERVAL_MS = 2_000;
const INITIAL_HEALTH_TIMEOUT_MS = 120_000;
const READY_HEALTH_FAILURE_LIMIT = 8;

export function parseEnvFile(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function healthWatchdogDecision({
  ready,
  consecutiveFailures,
  elapsedMs,
  healthy,
  initialTimeoutMs = INITIAL_HEALTH_TIMEOUT_MS,
  readyFailureLimit = READY_HEALTH_FAILURE_LIMIT
}) {
  if (healthy) return { ready: true, consecutiveFailures: 0, action: 'continue' };
  const nextFailures = consecutiveFailures + 1;
  if (!ready && elapsedMs >= initialTimeoutMs) {
    return { ready: false, consecutiveFailures: nextFailures, action: 'fail_initial_readiness' };
  }
  if (ready && nextFailures >= readyFailureLimit) {
    return { ready: true, consecutiveFailures: nextFailures, action: 'fail_lost_health' };
  }
  return { ready, consecutiveFailures: nextFailures, action: 'continue' };
}

export function healthResponseIsUsable(body) {
  return body?.data?.status === 'ok' && body?.data?.runtimeBuildStale === false && Boolean(body?.data?.buildId);
}

export function npmWorkspaceInvocation(workspace, extraArgs = [], npmExecPath = process.env.npm_execpath) {
  if (!npmExecPath) throw new Error('npm_execpath is unavailable; run this supervisor through npm run dev.');
  return {
    command: process.execPath,
    args: [npmExecPath, 'run', 'dev', '-w', workspace, ...extraArgs]
  };
}

export function devWebEnv(env, serverUrl) {
  const configuredApiBase = env.VITE_API_BASE_URL?.trim().replace(/\/$/, '');
  const localApiBases = new Set([
    '/api',
    `${serverUrl}/api`,
    `${serverUrl.replace('127.0.0.1', 'localhost')}/api`
  ]);
  if (configuredApiBase && !localApiBases.has(configuredApiBase)) return {};

  const configuredSseBase = env.VITE_SSE_BASE_URL?.trim().replace(/\/$/, '');
  return {
    VITE_API_BASE_URL: '/api',
    ...(!configuredSseBase || localApiBases.has(configuredSseBase) ? { VITE_SSE_BASE_URL: '/api' } : {}),
    AGENT_CLUSTER_DEV_API_PROXY_TARGET: serverUrl
  };
}

export function runDevSupervisor(options = {}) {
  const envFile = readRootEnv();
  const env = { ...envFile, ...process.env };
  const serverPort = positivePort(env.SERVER_PORT, DEFAULT_SERVER_PORT);
  const webPort = positivePort(env.WEB_PORT, DEFAULT_WEB_PORT);
  env.PUBLIC_WEB_URL ||= `http://127.0.0.1:${webPort}`;
  const healthUrl = `http://127.0.0.1:${serverPort}/api/health`;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const spawnProcess = options.spawnProcess ?? spawn;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const children = new Map();
  let shuttingDown = false;
  let ready = false;
  let consecutiveFailures = 0;
  const startedAt = Date.now();
  let resolveRun;
  const completed = new Promise((resolveCompleted) => {
    resolveRun = resolveCompleted;
  });

  function startWorkspace(workspace, extraArgs = [], envOverrides = {}) {
    const invocation = npmWorkspaceInvocation(workspace, extraArgs, options.npmExecPath);
    return spawnProcess(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      env: { ...env, ...envOverrides },
      stdio: 'inherit',
      windowsHide: true
    });
  }

  const server = startWorkspace('@agent-cluster/server');
  const web = startWorkspace(
    '@project/web',
    ['--', '--port', String(webPort), '--strictPort'],
    devWebEnv(env, serverUrl)
  );
  const localRuntime = startWorkspace('@agent-cluster/local-runtime-cli', ['--', '--server', serverUrl]);
  children.set('server', server);
  children.set('web', web);
  children.set('local-runtime', localRuntime);

  console.log(`[dev-supervisor] server health: ${healthUrl}`);
  console.log(`[dev-supervisor] web: http://127.0.0.1:${webPort}`);
  console.log(`[dev-supervisor] local Runtime: ${serverUrl}`);

  function fail(message) {
    console.error(`[dev-supervisor] ${message}`);
    shutdown('failure', 1);
  }

  function shutdown(reason, exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(healthTimer);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    console.log(`[dev-supervisor] stopping process group (${reason})`);
    for (const child of children.values()) terminateProcessTree(child);
    if (options.setProcessExitCode !== false) process.exitCode = exitCode;
    resolveRun(exitCode);
  }

  const healthTimer = setInterval(async () => {
    if (shuttingDown) return;
    const healthy = await fetchHealth(healthUrl);
    const wasReady = ready;
    const decision = healthWatchdogDecision({
      ready,
      consecutiveFailures,
      elapsedMs: Date.now() - startedAt,
      healthy
    });
    ready = decision.ready;
    consecutiveFailures = decision.consecutiveFailures;
    if (healthy && !wasReady) console.log(`[dev-supervisor] backend healthy: ${healthUrl}`);
    if (healthy && consecutiveFailures === 0) return;
    if (decision.action === 'fail_initial_readiness') {
      fail(`backend did not become healthy within ${INITIAL_HEALTH_TIMEOUT_MS / 1000}s`);
    } else if (decision.action === 'fail_lost_health') {
      fail(`backend health was lost for ${READY_HEALTH_FAILURE_LIMIT * HEALTH_INTERVAL_MS / 1000}s`);
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref?.();

  const onSigint = () => shutdown('SIGINT', 130);
  const onSigterm = () => shutdown('SIGTERM', 143);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  for (const [name, child] of children) {
    child.once('error', (error) => fail(`${name} failed to start: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (shuttingDown) return;
      fail(`${name} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
    });
  }

  return completed;
}

function readRootEnv() {
  try {
    return parseEnvFile(readFileSync(resolve(workspaceRoot, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

function positivePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

async function defaultFetchHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = await response.json();
    return healthResponseIsUsable(body);
  } catch {
    return false;
  }
}

function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may already have exited between the health check and cleanup.
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await runDevSupervisor();
}
