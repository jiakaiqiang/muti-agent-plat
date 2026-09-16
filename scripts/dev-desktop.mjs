import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink, rename, open, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// A dedicated profile keeps local development separate from installed-client settings
// and its single-instance lock. Each backend port has its own device credentials.
export function devDesktopProfile(serverUrl, root = workspaceRoot) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Unified development requires a loopback backend origin.');
  }
  return resolve(root, '.cache', 'agent-cluster', `desktop-dev-${url.port || '80'}`);
}

export async function waitForDesktopWindow({ profile, launchId, serverUrl, child, timeoutMs = 20000 }) {
  const receipt = resolve(profile, `dev-launch-${launchId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result;
    try { result = JSON.parse(await readFile(receipt, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (result) {
      await unlink(receipt).catch(() => undefined);
      if (result.status !== 'ready') throw new Error(result.error || 'Desktop startup failed.');
      if (result.serverUrl !== serverUrl || !result.visible) throw new Error('Desktop window is not connected to the expected development backend; exit the old desktop instance and retry.');
      return result;
    }
    if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) {
      throw new Error(`Electron exited before opening a window (code=${child.exitCode}).`);
    }
    await delay(100);
  }
  throw new Error(`Desktop did not confirm a visible window within ${timeoutMs / 1000}s. See ${resolve(profile, 'desktop.log')}`);
}

export async function launchDevDesktop({ serverUrl, env = process.env, root = workspaceRoot, spawnProcess = spawn }) {
  const desktop = resolve(root, 'apps/desktop');
  await access(resolve(desktop, 'dist/main.cjs'));
  await access(resolve(desktop, 'dist/renderer/index.html'));
  const profile = devDesktopProfile(serverUrl, root);
  await mkdir(profile, { recursive: true });
  const config = resolve(profile, 'desktop-config.json');
  const pendingConfig = `${config}.${process.pid}.tmp`;
  await writeFile(pendingConfig, JSON.stringify({ serverUrl: new URL(serverUrl).origin }) + '\n');
  await rename(pendingConfig, config);
  const logPath = resolve(profile, 'desktop.log');
  const launchId = randomUUID();
  const log = await open(logPath, 'a');
  const desktopEnv = { ...env };
  delete desktopEnv.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawnProcess(require('electron'), [desktop, `--user-data-dir=${profile}`, `--dev-launch-id=${launchId}`], {
      // Electron is the interactive application, not a background console helper.
      // SW_HIDE can suppress its first ShowWindow call even after ready-to-show.
      cwd: root, env: desktopEnv, detached: true, windowsHide: false,
      stdio: ['ignore', log.fd, log.fd]
    });
    await new Promise((resolveStarted, reject) => {
      child.once('spawn', resolveStarted);
      child.once('error', reject);
    });
    child.unref();
    console.log(`[dev-supervisor] desktop profile: ${profile}; log: ${logPath}`);
    await waitForDesktopWindow({ profile, launchId, serverUrl: new URL(serverUrl).origin, child });
    return child;
  } finally {
    await log.close();
  }
}
