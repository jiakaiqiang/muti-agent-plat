import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireDevServerLock,
  applyEnvFile,
  isPortListening,
  positivePort
} from './dev-server-guard.mjs';
import {
  consumeDevServerRestartRequest,
  devServerRestartRequestPath,
  discardDevServerRestartRequest
} from './dev-restart-control.mjs';

const RESTART_REQUEST_INTERVAL_MS = 500;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '..', '..');

applyEnvFile(resolve(workspaceRoot, '.env'));
const serverPort = positivePort(process.env.SERVER_PORT ?? process.env.PORT);
if (await isPortListening(serverPort)) {
  console.error(`[dev-server] Port ${serverPort} is already in use; refusing to start a second server instance.`);
  process.exit(1);
}

let instanceLock;
try {
  instanceLock = acquireDevServerLock({
    lockPath: join(workspaceRoot, '.cache', 'agent-cluster', `dev-server-${serverPort}.lock`)
  });
} catch (error) {
  console.error(`[dev-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const restartRequestPath = devServerRestartRequestPath(workspaceRoot, serverPort);
console.log(`[dev-server] launcher pid=${process.pid} startedAt=${new Date().toISOString()} sourceWatch=disabled`);
console.log('[dev-server] after backend changes run: npm run dev:restart-server');

let backend;
let restartInProgress = false;
let shuttingDown = false;
const expectedExits = new WeakSet();

function startBackend() {
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: serverRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  backend = child;
  child.once('error', (error) => {
    console.error(`[dev-server] backend failed to start: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (backend === child) backend = undefined;
    if (expectedExits.has(child) || shuttingDown) return;
    console.error(
      `[dev-server] backend exited unexpectedly (code=${String(code)}, signal=${String(signal)}); ` +
      'fix the issue and run npm run dev:restart-server'
    );
  });
  return child;
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  expectedExits.add(child);
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), GRACEFUL_SHUTDOWN_TIMEOUT_MS))
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between the timeout and forced cleanup.
    }
  }
  await exited;
}

async function handleRestartRequest() {
  if (restartInProgress || shuttingDown) return;
  let request;
  try {
    request = consumeDevServerRestartRequest(restartRequestPath);
  } catch (error) {
    console.error(`[dev-server] unable to read restart request: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!request) return;
  if (request.launcherPid !== process.pid) {
    console.log(
      `[dev-server] discarded stale restart request id=${request.requestId} targetLauncherPid=${request.launcherPid}`
    );
    return;
  }

  restartInProgress = true;
  try {
    console.log(`[dev-server] manual restart requested id=${request.requestId}`);
    const currentBackend = backend;
    await stopBackend(currentBackend);
    if (!shuttingDown) startBackend();
  } finally {
    restartInProgress = false;
  }
}

startBackend();
const restartTimer = setInterval(() => void handleRestartRequest(), RESTART_REQUEST_INTERVAL_MS);

let resolveShutdown;
const shutdownComplete = new Promise((resolveComplete) => {
  resolveShutdown = resolveComplete;
});
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(restartTimer);
  await stopBackend(backend);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  resolveShutdown();
};
const onSigint = () => void shutdown('SIGINT');
const onSigterm = () => void shutdown('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  await shutdownComplete;
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  discardDevServerRestartRequest(restartRequestPath);
  instanceLock.release();
}
