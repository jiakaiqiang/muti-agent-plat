import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchDevDesktop } from './dev-desktop.mjs';
import { launchDevLocalRuntime } from './dev-local-runtime.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SERVER_PORT = 8099;
const DEFAULT_WEB_PORT = 8089;
const HEALTH_INTERVAL_MS = 2_000;
const INITIAL_HEALTH_TIMEOUT_MS = 120_000;
const READY_HEALTH_FAILURE_LIMIT = 30;

/**
 * Return PIDs listening on a TCP port. The development ports are owned by
 * this repository's supervisor, so they are safe cleanup targets when a new
 * `npm run dev` invocation is started.
 */
export function listeningPidsForPort(port, {
  platform = process.platform,
  runCommand = spawnSync
} = {}) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) return [];

  if (platform === 'win32') {
    const result = runCommand('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true
    });
    return parseNetstatListeningPids(result?.stdout, parsedPort);
  }

  const result = runCommand('lsof', ['-nP', '-t', `-iTCP:${parsedPort}`, '-sTCP:LISTEN'], {
    encoding: 'utf8'
  });
  return String(result?.stdout ?? '')
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function parseNetstatListeningPids(output, port) {
  const suffix = `:${port}`;
  const pids = new Set();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const localAddress = fields[1];
    const state = fields[3];
    const pid = Number(fields[4]);
    if (state === 'LISTENING' && localAddress?.endsWith(suffix) && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function terminatePidTree(pid, {
  platform = process.platform,
  runCommand = spawnSync,
  signal = 'SIGTERM'
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (platform === 'win32') {
    runCommand('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return true;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function cleanupExistingDevServices({
  ports,
  lockPath,
  platform = process.platform,
  runCommand = spawnSync,
  readLock = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  }
} = {}) {
  const pids = new Set();
  const lockOwner = lockPath ? readLock(lockPath)?.pid : undefined;
  if (Number.isInteger(lockOwner) && lockOwner > 0) pids.add(lockOwner);
  for (const port of ports ?? []) {
    for (const pid of listeningPidsForPort(port, { platform, runCommand })) pids.add(pid);
  }
  for (const pid of pids) terminatePidTree(pid, { platform, runCommand });
  return [...pids];
}

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

export function livenessResponseIsUsable(body) {
  return body?.data?.status === 'ok' && body?.data?.service === 'agent-cluster-server' &&
    Number.isInteger(body?.data?.processId);
}

export function normalizeHealthProbe(result) {
  if (typeof result === 'boolean') {
    return { healthy: result, reason: result ? 'ok' : 'probe returned false' };
  }
  if (result && typeof result === 'object' && typeof result.healthy === 'boolean') return result;
  return { healthy: false, reason: 'probe returned an invalid result' };
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
  const publicWebUrl = new URL(env.PUBLIC_WEB_URL).origin;
  const readinessUrl = `http://127.0.0.1:${serverPort}/api/health`;
  const livenessUrl = `http://127.0.0.1:${serverPort}/api/live`;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const serverLockPath = resolve(workspaceRoot, '.cache', 'agent-cluster', `dev-server-${serverPort}.lock`);
  const spawnProcess = options.spawnProcess ?? spawn;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const children = new Map();
  let shuttingDown = false;
  let ready = false;
  let desktopStarted = false;
  let runtimeStarted = false;
  let nextRuntimeCheckAt = 0;
  let lastRuntimeState;
  let consecutiveFailures = 0;
  const startedAt = Date.now();
  let resolveRun;
  const completed = new Promise((resolveCompleted) => {
    resolveRun = resolveCompleted;
  });

  if (options.cleanupExisting !== false) {
    const stoppedPids = cleanupExistingDevServices({
      ports: [serverPort, webPort],
      lockPath: serverLockPath
    });
    if (stoppedPids.length > 0) {
      console.log(`[dev-supervisor] stopped existing service process(es): ${stoppedPids.join(', ')}`);
    }
  }

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
  children.set('server', server);
  children.set('web', web);

  console.log(`[dev-supervisor] server readiness: ${readinessUrl}`);
  console.log(`[dev-supervisor] server liveness: ${livenessUrl}`);
  console.log(`[dev-supervisor] web: http://127.0.0.1:${webPort}`);
  console.log(`[dev-supervisor] local Runtime: ${options.localRuntime ? 'auto-reconnect saved device after backend readiness' : `on-demand via ${publicWebUrl}`}`);

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
    if (desktopStarted) console.log('[dev-supervisor] Desktop remains independent. Finish local tasks, then use 应用 → 退出应用 to close it safely.');
    if (runtimeStarted) console.log('[dev-supervisor] Local Runtime remains independent and will reconnect when the backend returns.');
    if (options.setProcessExitCode !== false) process.exitCode = exitCode;
    resolveRun(exitCode);
  }

  const healthTimer = setInterval(async () => {
    if (shuttingDown) return;
    const probeKind = ready ? 'liveness' : 'readiness';
    const probeUrl = ready ? livenessUrl : readinessUrl;
    const probe = normalizeHealthProbe(await fetchHealth(probeUrl, { kind: probeKind }));
    if (shuttingDown) return;
    const healthy = probe.healthy;
    const wasReady = ready;
    const failuresBeforeProbe = consecutiveFailures;
    const decision = healthWatchdogDecision({
      ready,
      consecutiveFailures,
      elapsedMs: Date.now() - startedAt,
      healthy
    });
    ready = decision.ready;
    consecutiveFailures = decision.consecutiveFailures;
    if (healthy && !wasReady) console.log(`[dev-supervisor] backend ready: ${readinessUrl}`);
    if (healthy && options.localRuntime && !runtimeStarted && Date.now() >= nextRuntimeCheckAt) {
      runtimeStarted = true;
      void (options.launchRuntime ?? launchDevLocalRuntime)({ serverUrl, env }).then(result => {
        if (result.state !== lastRuntimeState) console.log(`[dev-supervisor] local Runtime: ${result.state}${result.reason ? `; ${result.reason}` : ''}${result.logPath ? `; log: ${result.logPath}` : ''}`);
        lastRuntimeState = result.state;
      }).catch(error => console.error(`[dev-supervisor] local Runtime failed; will retry: ${error.message}`))
        .finally(() => {
          runtimeStarted = false;
          nextRuntimeCheckAt = Date.now() + (options.runtimeCheckIntervalMs ?? 30_000);
        });
    }
    if (healthy && options.desktop && !desktopStarted) {
      desktopStarted = true;
      try {
        await (options.launchDesktop ?? launchDevDesktop)({ serverUrl, env });
        console.log(`[dev-supervisor] desktop opened; platform: ${serverUrl}`);
      } catch (error) {
        fail(`desktop failed to start: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (healthy && failuresBeforeProbe > 0) {
      console.log(`[dev-supervisor] backend ${probeKind} recovered after ${failuresBeforeProbe} failed probe(s)`);
    }
    if (healthy) return;
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      const duration = Number.isFinite(probe.durationMs) ? `, duration=${probe.durationMs}ms` : '';
      console.error(
        `[dev-supervisor] backend ${probeKind} probe failed (${consecutiveFailures}/${READY_HEALTH_FAILURE_LIMIT}): ${probe.reason}${duration}`
      );
    }
    if (decision.action === 'fail_initial_readiness') {
      fail(`backend did not become ready within ${INITIAL_HEALTH_TIMEOUT_MS / 1000}s; last probe: ${probe.reason}`);
    } else if (decision.action === 'fail_lost_health') {
      fail(
        `backend liveness was lost for ${READY_HEALTH_FAILURE_LIMIT * HEALTH_INTERVAL_MS / 1000}s; last probe: ${probe.reason}`
      );
    }
  }, options.healthIntervalMs ?? HEALTH_INTERVAL_MS);
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

export async function defaultFetchHealth(url, { kind = 'readiness' } = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) {
      return { healthy: false, reason: `HTTP ${response.status}`, durationMs: Date.now() - startedAt };
    }
    const body = await response.json();
    const healthy = kind === 'liveness' ? livenessResponseIsUsable(body) : healthResponseIsUsable(body);
    return {
      healthy,
      reason: healthy ? 'ok' : `${kind} response contract rejected`,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { healthy: false, reason, durationMs: Date.now() - startedAt };
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
  await runDevSupervisor({ desktop: process.argv.includes('--desktop'), localRuntime: true });
}
