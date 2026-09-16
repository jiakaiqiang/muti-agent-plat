import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('../..', import.meta.url));
const userData = await mkdtemp(join(tmpdir(), 'agent-cluster-desktop-smoke-'));
const screenshots = join(root, 'output/playwright/desktop');
await mkdir(screenshots, { recursive: true });
let approved = false;
let deviceId;
let socket;
let registration;
const messages = [];
const requests = [];
const fixture = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  requests.push({ path, method: request.method });
  if (path === '/api/desktop-smoke-events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('data: desktop-stream-ok\n\n');
    request.on('close', () => response.end());
    return;
  }
  if (path === '/api/redirect') { response.writeHead(302, { location: 'https://example.com/private' }); response.end(); return; }
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  let data = [];
  if (path === '/api/health') data = { status: 'ok' };
  if (path === '/api/set-cookie') response.setHeader('set-cookie', 'desktop-isolation=first-platform; Path=/; HttpOnly; SameSite=Lax');
  if (path === '/api/read-cookie') data = { cookie: request.headers.cookie ?? '' };
  if (path === '/api/local-runtime/device-codes') {
    deviceId = body.deviceId;
    data = { deviceCode: 'fixture-private-code', userCode: 'TEST-CODE', verificationUri: origin + '/local-runtime/activate', expiresAt: new Date(Date.now() + 60_000).toISOString(), compatibility: { compatible: true } };
  }
  if (path === '/api/local-runtime/device-tokens') data = approved
    ? { deviceId, accessToken: 'fixture-access', accessTokenExpiresAt: '2099-01-01T00:00:00Z', refreshToken: 'fixture-refresh', refreshTokenExpiresAt: '2099-01-01T00:00:00Z' }
    : { status: 'pending', retryAfterSeconds: 1 };
  if (path === '/api/local-runtime/device-tokens/current') data = { deviceId, connected: Boolean(socket) };
  if (path === '/api/local-runtime/device-codes/approve') { approved = true; data = { deviceId, displayName: 'Desktop fixture' }; }
  if (path === '/api/sessions' || path === '/api/workflows/catalog/published') data = { items: [], hasMore: false };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data, requestId: 'desktop-fixture' }));
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
const secondFixture = createServer((request, response) => fixture.emit('request', request, response));
secondFixture.listen(0, '127.0.0.1'); await once(secondFixture, 'listening');
const secondOrigin = `http://127.0.0.1:${secondFixture.address().port}`;
const wss = new WebSocketServer({ server: fixture, path: '/local-runtime' });
wss.on('connection', connected => {
  socket = connected;
  connected.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    if (message.kind === 'local_runtime.hello') connected.send(JSON.stringify({ kind: 'local_runtime.connected', payload: { deviceId } }));
    if (message.kind === 'local_runtime.workspace.register') registration = message.payload;
  });
  connected.on('close', () => { if (socket === connected) socket = undefined; });
});
const env = { ...process.env, AGENT_RUNTIME_CODEX_VERSION: 'desktop-fixture 1.0', AGENT_RUNTIME_CLAUDE_VERSION: 'desktop-fixture 1.0',
  AGENT_RUNTIME_CODEX_COMMAND: process.execPath,
  AGENT_RUNTIME_CODEX_ARGS_JSON: JSON.stringify([join(root, 'tests/e2e/fixtures/desktop-runtime-stub.mjs')])
};
delete env.ELECTRON_RUN_AS_NODE;
let instance;
const errors = [];
const observe = page => page.on('pageerror', error => errors.push(String(error)));
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}; invocation evidence: ${JSON.stringify(messages.filter(message => message.kind.startsWith('local_runtime.invocation.')))}`);
}
try {
  const executablePath = process.env.AGENT_CLUSTER_DESKTOP_EXECUTABLE;
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [join(root, 'apps/desktop')]), `--user-data-dir=${userData}`], env, timeout: 60_000 });
  const environment = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, arch: process.arch }));
  assert.equal(environment.packaged, Boolean(executablePath));
  let page = await instance.firstWindow(); observe(page);
  await page.getByRole('heading', { name: '连接与更新' }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.agentClusterDesktop.status), 'function');
  await page.screenshot({ path: join(screenshots, 'first-launch.png') });
  await page.getByRole('textbox').fill(origin);
  const nextWindow = instance.waitForEvent('window');
  await page.getByRole('button', { name: '连接并保存' }).click();
  page = await nextWindow; observe(page);
  await page.getByRole('heading', { name: '连接与更新' }).waitFor();
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).serverUrl, origin);
  assert.equal(JSON.parse(await readFile(join(userData, 'desktop-config.json'), 'utf8')).serverUrl, origin);
  const sse = await page.evaluate(() => new Promise((resolve, reject) => {
    const source = new EventSource('/api/desktop-smoke-events');
    const timeout = setTimeout(() => { source.close(); reject(new Error('SSE timeout')); }, 5000);
    source.onmessage = event => { clearTimeout(timeout); source.close(); resolve(event.data); };
    source.onerror = () => { clearTimeout(timeout); source.close(); reject(new Error('SSE failed')); };
  }));
  assert.equal(sse, 'desktop-stream-ok');
  assert.equal(await page.evaluate(async () => (await fetch('/api/workflows/private', { method: 'DELETE' })).status), 403);
  assert.equal(requests.some(item => item.method === 'DELETE'), false);
  assert.equal(await page.evaluate(async () => (await fetch('/api/redirect')).status), 502);
  const key = createHash('sha256').update(origin).digest('hex').slice(0, 32);
  const stateFile = join(userData, 'platforms', key, 'runtime', 'state.json');
  const workspaceRoot = join(userData, 'fixture-workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(resolve(stateFile, '..'), { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), '# Original desktop test\n');
  const permissions = { workspace_read: 'allow', workspace_write: 'allow', workspace_delete: 'confirm', command_execute: 'allow', test_execute: 'allow', dependency_install: 'confirm' };
  // Pre-authorized isolated fixture directory; this is not evidence of OS directory-picker acceptance.
  await writeFile(stateFile, JSON.stringify({ schemaVersion: 2, deviceId: 'desktop-fixture-device', displayName: 'Desktop fixture', serverUrl: origin, providerConnections: [], workspaces: [
    { workspaceId: 'desktop-fixture-workspace', displayName: 'Desktop fixture workspace', rootPath: workspaceRoot, permissions, permissionPolicyVersion: 2, registeredAt: new Date().toISOString() }
  ] }));
  await page.getByRole('button', { name: '启动本地助手', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state === 'authorizing', 'device code');
  await page.getByRole('button', { name: '授权此设备' }).waitFor();
  await page.screenshot({ path: join(screenshots, 'device-authorization.png') });
  await page.getByRole('button', { name: '授权此设备' }).click();
  await page.getByRole('textbox').first().fill('fixture-admin-only');
  await page.getByRole('button', { name: '授权此设备' }).click();
  await until(async () => (await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state === 'connected', 'utility process connection');
  await until(() => registration && messages.some(message => message.kind === 'local_runtime.workspace.register'), 'workspace registered');
  socket.send(JSON.stringify({ kind: 'local_runtime.invocation.start', payload: {
    workspaceId: registration.workspaceId, workspaceRevision: registration.revision, permissions,
    plan: { invocationId: 'desktop-test-invocation', sessionId: 'desktop-test-session', phase: 'task_execution', agent: { name: 'Desktop test Agent' },
      executionTarget: { runtimeType: 'codex', executionLocation: 'local', workspaceProviderKind: 'local_bridge', requiredCapabilities: ['read', 'write', 'command'], writeMode: 'propose_changes' },
      contextEnvelope: {}, toolCatalog: { decisions: [] }, expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' } }
  } }));
  await until(() => messages.some(message => message.kind === 'local_runtime.invocation.event' && message.payload.type === 'runtime_started'), 'real isolated process started');
  await assert.rejects(() => page.evaluate(() => window.agentClusterDesktop.stopRuntime()), /正在执行/);
  await assert.rejects(() => page.evaluate(server => window.agentClusterDesktop.configure(server), origin), /正在执行/);
  await until(() => messages.some(message => message.kind === 'local_runtime.invocation.result'), 'invocation result');
  const result = messages.find(message => message.kind === 'local_runtime.invocation.result').payload.result;
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  const changeSet = result.workspaceExecution.changeSet;
  assert.equal(changeSet.changes[0].path, 'README.md');
  assert.equal(await readFile(join(workspaceRoot, 'README.md'), 'utf8'), '# Original desktop test\n');
  socket.send(JSON.stringify({ kind: 'local_runtime.workspace.operation.request', payload: {
    requestId: 'desktop-writeback', ownerId: 'local-user', sessionId: 'desktop-test-session', workspaceId: registration.workspaceId,
    workspaceRevision: registration.revision, permissions, operation: 'applyChangeSet', input: changeSet
  } }));
  await until(() => messages.some(message => message.kind === 'local_runtime.workspace.operation.result' && message.payload.requestId === 'desktop-writeback'), 'file writeback');
  assert.equal(await readFile(join(workspaceRoot, 'README.md'), 'utf8'), '# Changed by desktop test\n');
  await page.goto('agent-cluster://app/workspace');
  await page.getByRole('button', { name: '流程管理', exact: true }).waitFor();
  assert.equal(await page.getByText('Web 流程维护', { exact: true }).count(), 0);
  await page.screenshot({ path: join(screenshots, 'workspace.png') });
  await page.goto('agent-cluster://app/workflows');
  await until(() => page.url().endsWith('/workspace'), 'desktop author route blocked');
  const windowId = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  await instance.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), windowId);
  assert.equal(await instance.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), windowId), false);
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state, 'connected');
  await instance.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).show(), windowId);
  await page.evaluate(() => window.agentClusterDesktop.stopRuntime());
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state, 'stopped');
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).update.state, 'unconfigured');
  await page.evaluate(() => { localStorage.setItem('desktop-isolation-proof', 'first-platform'); sessionStorage.setItem('desktop-isolation-proof', 'first-platform'); });
  await page.evaluate(() => fetch('/api/set-cookie'));
  assert.match(await page.evaluate(async () => (await (await fetch('/api/read-cookie')).json()).data.cookie), /desktop-isolation=first-platform/);
  async function configureThroughUi(address) {
    await page.goto('agent-cluster://app/desktop');
    await page.getByRole('textbox').fill(address);
    const opened = instance.waitForEvent('window');
    await page.getByRole('button', { name: '连接并保存' }).click();
    page = await opened; observe(page);
    await page.getByRole('heading', { name: '连接与更新' }).waitFor();
  }
  await configureThroughUi(secondOrigin);
  assert.equal(await page.evaluate(() => localStorage.getItem('desktop-isolation-proof')), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('desktop-isolation-proof')), null);
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/read-cookie')).json()).data.cookie), '');
  await configureThroughUi(origin);
  assert.equal(await page.evaluate(() => localStorage.getItem('desktop-isolation-proof')), 'first-platform');
  await instance.close();
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [join(root, 'apps/desktop')]), `--user-data-dir=${userData}`], env, timeout: 60_000 });
  page = await instance.firstWindow(); observe(page);
  await page.getByRole('button', { name: '流程管理', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).serverUrl, origin);
  assert.equal(await page.evaluate(() => localStorage.getItem('desktop-isolation-proof')), 'first-platform');
  await page.evaluate(() => window.agentClusterDesktop.startRuntime());
  await until(async () => (await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state === 'connected', 'persisted device authorization');
  await page.evaluate(() => window.agentClusterDesktop.stopRuntime());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', ...environment, backend: 'isolated HTTP/WebSocket fixture (not production)', checks: ['bundled UI', 'sandbox preload', 'connection persistence', 'API proxy', 'SSE streaming', 'definition mutation denied', 'redirect denied', 'device code authorization', 'utility process connected', 'busy invocation refuses stop and reconfigure', 'real stub process and ChangeSet writeback', 'workspace', 'author route denied', 'close retains helper', 'idle stop', 'unconfigured updater', 'cross-platform storage isolation', 'restart retains settings and device credentials'], userData, screenshots }));
} finally {
  if (instance) {
    for (const page of instance.windows()) await page.evaluate(() => window.agentClusterDesktop?.stopRuntime()).catch(() => {});
    await instance.close();
  }
  for (const client of wss.clients) client.terminate();
  wss.close(); fixture.closeAllConnections(); secondFixture.closeAllConnections();
  await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => secondFixture.close(resolve))]);
}
