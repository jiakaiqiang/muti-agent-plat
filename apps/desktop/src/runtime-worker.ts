import { loadState, saveState } from '../../../packages/local-runtime-cli/src/state';
import { normalizeServer } from './policy';
import { runBridge, createDeviceCode, exchangeDeviceCode, abortableDelay, fetchDeviceStatus } from '../../../packages/local-runtime-cli/src/transport';
import type { RuntimeStatus } from './contracts';
declare const __LOCAL_RUNTIME_VERSION__: string;

const port = process.parentPort;
const controller = new AbortController();
let draining = false;
let active = 0;
let initializing = true;
let status: RuntimeStatus = { state: 'starting', busy: 1 };
function report(patch: Partial<RuntimeStatus>) {
  status = { ...status, ...patch, busy: active + (initializing ? 1 : 0) };
  port.postMessage({ kind: 'status', status });
}
port.on('message', ({ data }) => {
  if (data?.kind !== 'stop' || typeof data.id !== 'string') return;
  // Same event loop as transport dispatch: seal intake BEFORE observing activity.
  draining = true;
  if (active || initializing) {
    draining = false;
    port.postMessage({ kind: 'stop-rejected', id: data.id, error: '本地助手正在执行任务或处理请求，请结束后再操作。' });
    return;
  }
  controller.abort(new Error('Desktop requested idle shutdown'));
  // Acknowledgement is the process exit, after runBridge has flushed state.
});

async function main() {
  const server = normalizeServer(process.argv[2]);
  const state = await loadState();
  if (state.serverUrl !== server && (state.tokens || state.workspaces.length)) throw new Error('助手状态不属于当前平台。');
  state.serverUrl = server;
  await saveState(state);
  if (state.tokens) {
    try { await fetchDeviceStatus(state); }
    catch (error) {
      if (!/HTTP 401|HTTP 403|token is invalid/i.test(String(error))) throw error;
      delete state.tokens;
      await saveState(state);
    }
  }
  if (!state.tokens) {
    const code = await createDeviceCode(state, __LOCAL_RUNTIME_VERSION__);
    if (!code.compatibility.compatible) throw new Error(code.compatibility.reason ?? '本地助手协议版本不兼容。');
    initializing = false;
    report({ state: 'authorizing', userCode: code.userCode });
    while (!controller.signal.aborted && Date.parse(code.expiresAt) > Date.now()) {
      const token = await exchangeDeviceCode(state, code.deviceCode);
      if (controller.signal.aborted) return;
      if ('accessToken' in token) {
        initializing = true;
        report({});
        state.tokens = token;
        await saveState(state);
        break;
      }
      await abortableDelay(token.retryAfterSeconds * 1000, controller.signal);
    }
    if (controller.signal.aborted) return;
    if (!state.tokens) throw new Error('设备授权已过期，请重新启动本地助手。');
  }
  initializing = false;
  report({ state: 'connecting', userCode: undefined });
  await runBridge(state, __LOCAL_RUNTIME_VERSION__, controller.signal, {
    stopOnAuthorizationFailure: true,
    isDraining: () => draining,
    onActivityChange(count) { active = count; report({}); },
    onConnectionChange(connected) { report({ state: connected ? 'connected' : 'connecting', error: undefined }); },
    onConnectionError(error) { report({ state: 'connecting', error: error instanceof Error ? error.message : String(error) }); }
  });
}
void main().then(() => process.exit(0)).catch((error) => {
  if (controller.signal.aborted) { process.exit(0); return; }
  initializing = false;
  report({ state: 'error', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  port.removeAllListeners('message');
});
