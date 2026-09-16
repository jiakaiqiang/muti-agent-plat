import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchDevLocalRuntime } from './dev-local-runtime.mjs';
import {
  applyEnvFile,
  isProcessAlive,
  positivePort
} from '../apps/server/scripts/dev-server-guard.mjs';
import {
  devServerRestartRequestPath,
  writeDevServerRestartRequest
} from '../apps/server/scripts/dev-restart-control.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_POLL_INTERVAL_MS = 500;
const RESTART_TIMEOUT_MS = 120_000;

export function healthIndicatesCompletedRestart(health, { previousProcessId, requestedAtMs }) {
  const data = health?.data;
  if (
    data?.status !== 'ok' ||
    data?.runtimeBuildStale !== false ||
    !data?.buildId ||
    !Number.isInteger(data?.processId)
  ) return false;
  if (Number.isInteger(previousProcessId)) return data.processId !== previousProcessId;
  const startedAtMs = Date.parse(data.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs >= requestedAtMs;
}

export async function restartDevServer(options = {}) {
  applyEnvFile(resolve(workspaceRoot, '.env'));
  const serverPort = positivePort(process.env.SERVER_PORT ?? process.env.PORT);
  const healthUrl = `http://127.0.0.1:${serverPort}/api/health`;
  const lockPath = join(workspaceRoot, '.cache', 'agent-cluster', `dev-server-${serverPort}.lock`);
  const launcher = (options.readLauncher ?? readLauncher)(lockPath);
  if (!launcher?.pid || !isProcessAlive(launcher.pid)) {
    throw new Error('The development backend launcher is not running. Start it with npm run dev first.');
  }

  const fetchHealth = options.fetchHealth ?? readHealth;
  const previousHealth = await fetchHealth(healthUrl);
  const previousProcessId = Number.isInteger(previousHealth?.data?.processId)
    ? previousHealth.data.processId
    : undefined;
  const requestedAtMs = Date.now();
  const request = {
    requestId: randomUUID(),
    requestedAt: new Date(requestedAtMs).toISOString(),
    launcherPid: launcher.pid
  };
  (options.writeRestartRequest ?? writeDevServerRestartRequest)(devServerRestartRequestPath(workspaceRoot, serverPort), request);
  console.log(`[dev-server] restart requested id=${request.requestId}; waiting for backend health`);

  const deadline = requestedAtMs + (options.timeoutMs ?? RESTART_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await delay(options.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS);
    const health = await fetchHealth(healthUrl);
    if (healthIndicatesCompletedRestart(health, { previousProcessId, requestedAtMs })) {
      console.log(
        `[dev-server] restart complete processId=${health.data.processId} buildId=${health.data.buildId}`
      );
      try {
        const runtime = await (options.launchRuntime ?? launchDevLocalRuntime)({
          serverUrl: `http://127.0.0.1:${serverPort}`, env: process.env
        });
        console.log(`[dev-server] local Runtime: ${runtime.state}${runtime.reason ? `; ${runtime.reason}` : ''}${runtime.logPath ? `; log: ${runtime.logPath}` : ''}`);
      } catch (error) {
        throw new Error(`Backend restarted successfully, but Local Runtime auto-connect failed: ${error.message}`);
      }
      return health.data;
    }
  }
  throw new Error(`Backend did not become healthy within ${(options.timeoutMs ?? RESTART_TIMEOUT_MS) / 1000}s.`);
}

async function readHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function readLauncher(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  try {
    await restartDevServer();
  } catch (error) {
    console.error(`[dev-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
