import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireDevServerLock,
  applyEnvFile,
  isPortListening,
  positivePort
} from './dev-server-guard.mjs';
import { devWatchRoots, startDevWatchTriggerLogger } from './dev-watch-scope.mjs';

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

const watchRoots = devWatchRoots(serverRoot, workspaceRoot);
const watchTriggerLogger = startDevWatchTriggerLogger({ roots: watchRoots });
console.log(`[dev-server] watcher pid=${process.pid} startedAt=${new Date().toISOString()} roots=${watchRoots.join(',')}`);

const watcher = spawn(
  process.execPath,
  ['--watch', '--watch-path=src', '--watch-path=../../packages/shared/src', 'scripts/dev.mjs'],
  { cwd: serverRoot, env: process.env, stdio: 'inherit', windowsHide: true }
);

const forwardSignal = (signal) => {
  if (!watcher.killed) watcher.kill(signal);
};
const onSigint = () => forwardSignal('SIGINT');
const onSigterm = () => forwardSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  const result = await new Promise((resolveResult, reject) => {
    watcher.once('error', reject);
    watcher.once('exit', (code, signal) => resolveResult({ code, signal }));
  });
  if (result.signal) {
    process.exitCode = result.signal === 'SIGINT' ? 130 : 143;
  } else {
    process.exitCode = result.code ?? 1;
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  instanceLock.release();
  watchTriggerLogger.close();
}
