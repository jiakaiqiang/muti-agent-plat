import { spawn } from 'node:child_process';
import { readFile, open, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
export function runtimeStatePath(env = process.env) {
  return env.AGENT_RUNTIME_STATE_FILE?.trim() ? resolve(env.AGENT_RUNTIME_STATE_FILE.trim())
    : join(process.platform === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-runtime', 'state.json');
}

export function canRecoverRuntime(serverUrl, env = process.env) {
  try {
    const url = new URL(serverUrl);
    return env.NODE_ENV?.trim().toLowerCase() !== 'production'
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && (['1', 'true', 'yes', 'on'].includes(env.LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS?.trim().toLowerCase())
        || (env.LOCAL_RUNTIME_ADMIN_TOKEN?.trim().length ?? 0) >= 32);
  } catch { return false; }
}

export function canResumeRuntime(state, serverUrl, env = process.env) {
  try {
    return [1, 2].includes(state.schemaVersion) && Boolean(state.deviceId)
      && Boolean(state.tokens?.accessToken || canRecoverRuntime(serverUrl, env))
      && Array.isArray(state.workspaces) && new URL(state.serverUrl).origin === new URL(serverUrl).origin;
  } catch { return false; }
}

// Owned by the independent runtime process, so restarting Web/server cannot spawn another one.
export async function acquireRuntimeLock(path, alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, 'utf8')).pid; }
      catch { return undefined; } // Another launcher may still be writing its lock.
      if (!Number.isInteger(owner) || owner <= 0 || alive(owner)) return undefined;
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      continue;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.close();
    return async () => {
      const owner = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
      if (owner.pid === process.pid) await unlink(path).catch(() => undefined);
    };
  }
}

export async function launchDevLocalRuntime({ serverUrl, env = process.env, spawnProcess = spawn, timeoutMs = 30_000 }) {
  if (env.AGENT_CLUSTER_DEV_AUTO_RUNTIME === 'false') return { state: 'disabled' };
  const stateFile = runtimeStatePath(env);
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'skipped', reason: 'No saved Local Runtime device; connect and authorize it once in 本地运行.' };
    throw new Error('Cannot read the saved Local Runtime state.');
  }
  if (!canResumeRuntime(state, serverUrl, env)) return { state: 'skipped', reason: 'Saved device is not authorized for this backend; existing credentials and workspace bindings were preserved.' };
  const logPath = join(dirname(stateFile), 'dev-runtime.log');
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, 'a');
  const tsx = pathToFileURL(require.resolve('tsx')).href;
  const childEnv = { ...env, AGENT_RUNTIME_STATE_FILE: stateFile };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  try {
    const child = spawnProcess(process.execPath, ['--import', tsx, fileURLToPath(import.meta.url), '--worker', serverUrl], {
      cwd: root, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc']
    });
    return await new Promise((resolveStarted, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit);
        if (child.connected) child.disconnect();
        child.unref();
        error ? reject(error) : resolveStarted({ ...result, logPath });
      };
      const onMessage = result => finish(undefined, result);
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Local Runtime startup exited (${code}); see ${logPath}`));
      const timer = setTimeout(() => finish(undefined, { state: 'connecting', reason: 'Connection is still pending; check the runtime log.' }), timeoutMs);
      child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
    });
  } finally { await log.close(); }
}

async function runWorker(serverUrl) {
  const report = result => { if (process.connected) process.send(result); };
  const release = await acquireRuntimeLock(runtimeStatePath() + '.dev.lock');
  if (!release) { report({ state: 'existing', reason: 'Existing launcher retained; it reconnects when the backend is ready.' }); return; }
  try {
    const { loadState, saveState } = await import('../packages/local-runtime-cli/src/state.ts');
    const { fetchDeviceStatus, runBridge } = await import('../packages/local-runtime-cli/src/transport.ts');
    const state = await loadState();
    if (!canResumeRuntime(state, serverUrl)) throw new Error('Saved Local Runtime does not match the requested backend.');
    // A failed status probe must not prevent the bridge's reconnect/auth recovery loop.
    const devices = await fetchDeviceStatus(state).catch(() => []);
    if (devices.some(device => device.connected)) { report({ state: 'connected', reused: true }); return; }
    const { version } = JSON.parse(await readFile(new URL('../packages/local-runtime-cli/package.json', import.meta.url), 'utf8'));
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    await runBridge(state, version, controller.signal, {
      stopOnAuthorizationFailure: true,
      ...(canRecoverRuntime(serverUrl) ? {
        authorizeMissingTokens: () => resumeSavedDevice(state, { saveState })
      } : {}),
      onConnectionChange(connected) {
        if (connected) report({ state: 'connected', deviceId: state.deviceId, workspaces: state.workspaces.length });
      }
    });
  } finally { await release(); }
}

export async function resumeSavedDevice(state, { saveState, env = process.env, request = fetch }) {
  if (!canRecoverRuntime(state.serverUrl, env)) throw new Error('Local Runtime automatic recovery is not authorized for this backend.');
  const adminToken = env.LOCAL_RUNTIME_ADMIN_TOKEN?.trim();
  const response = await request(new URL('/api/local-runtime/device-tokens/resume', state.serverUrl), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) },
    body: JSON.stringify({ deviceId: state.deviceId })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: Local Runtime saved-device recovery failed.`);
  const body = await response.json();
  const tokens = body.data ?? body;
  if (tokens.deviceId !== state.deviceId || !tokens.accessToken || !tokens.refreshToken) {
    throw new Error('Local Runtime recovery returned invalid device credentials.');
  }
  state.tokens = tokens;
  await saveState(state);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === '--worker') {
  await runWorker(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
  if (process.connected) process.disconnect();
}
