import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

// Exercise the actual agent-cluster:// protocol and CSP, not an HTTP preview
// of the renderer bundle. No production data, device authorization or models.
const profile = await mkdtemp(join(tmpdir(), 'agent-cluster-render-smoke-'));
const screenshots = resolve('output/playwright/desktop-render');
const requests = [];
const fixture = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  const data = request.url === '/api/health' ? { status: 'ok' }
    : { items: [], hasMore: false, availableModels: [] };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data, requestId: 'desktop-render-fixture' }));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let instance;
const errors = [];
const observed = new WeakSet();
function observe(page) {
  if (observed.has(page)) return;
  observed.add(page);
  page.on('pageerror', error => errors.push(error.stack ?? String(error)));
  page.on('crash', () => errors.push('Renderer process crashed'));
}
async function mounted(page) {
  observe(page);
  await page.waitForFunction(() => document.querySelector('#app .application-shell'), undefined, { timeout: 10_000 });
  const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
  assert.match(csp, /script-src 'self'/);
  assert.equal(csp.includes("'unsafe-eval'"), false, 'Do not weaken CSP to hide import side effects');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual(errors, []);
}
try {
  instance = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${profile}`], env, timeout: 30_000 });
  instance.on('window', observe);
  let page = await instance.firstWindow();
  await mounted(page);
  await page.getByRole('heading', { name: '连接与更新', exact: true }).waitFor();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'connection.png') });

  await page.getByRole('textbox').fill(origin);
  const opened = instance.waitForEvent('window');
  await page.getByRole('button', { name: '连接并保存', exact: true }).click();
  page = await opened;
  await mounted(page);
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, 'workspace.png') });
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).runtime.state, 'stopped');
  await page.reload();
  await mounted(page);
  await page.getByRole('button', { name: '新建任务', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET'), 'Render smoke must not execute business writes');
  console.log(JSON.stringify({ result: 'pass', profile, screenshots,
    checks: ['actual Electron CSP', 'connection screen', 'workspace', 'reload', 'sandbox retained', 'no page errors'] }));
} catch (error) {
  console.error(JSON.stringify({ result: 'fail', error: String(error), rendererErrors: errors }));
  process.exitCode = 1;
} finally {
  if (instance) await instance.close();
  fixture.closeAllConnections();
  await new Promise(resolveClosed => fixture.close(resolveClosed));
}
