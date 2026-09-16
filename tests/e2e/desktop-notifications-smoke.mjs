import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'desktop-notifications-'));
const artifactDir = join(root, 'output/playwright/desktop-notifications');
await mkdir(artifactDir, { recursive: true });
const id = 'notifications-fixture';
let updatedAt = '2026-09-14T00:00:00.000Z';
let events = [];
let listReads = 0;
const fixture = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  let data = { items: [], hasMore: false };
  if (path === '/api/sessions') {
    listReads++;
    data.items = [{ id, title: '通知验收会话', status: 'EXECUTING', updatedAt, createdAt: updatedAt, agentCount: 0, tokenBudget: 10000, tokenUsed: 0 }];
  }
  if (path === `/api/sessions/${id}/events`) data.items = events;
  if (path === `/api/sessions/${id}`) data = { id, title: '通知验收会话', status: 'COMPLETED', updatedAt, createdAt: updatedAt, agents: [], tasks: [], artifacts: [], tokenBudget: 10000, tokenUsed: 0 };
  if (path === '/api/health') data = { status: 'ok' };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data }));
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const origin = `http://127.0.0.1:${fixture.address().port}`;
await writeFile(join(profile, 'desktop-config.json'), JSON.stringify({ serverUrl: origin }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let instance;
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${label}`);
}
try {
  instance = await electron.launch({ args: [join(root, 'apps/desktop'), `--user-data-dir=${profile}`], env, timeout: 60000 });
  const page = await instance.firstWindow();
  await page.waitForURL('agent-cluster://app/workspace');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('agent-cluster://app/desktop');
  await page.getByRole('heading', { name: '消息通知', exact: true }).waitFor();
  await until(() => listReads > 0, 'baseline');
  const supported = (await page.evaluate(() => window.agentClusterDesktop.status())).notifications.supported;
  let nativeResult = 'unsupported';
  if (supported) {
    await page.getByRole('button', { name: '发送测试通知' }).click();
    await until(async () => {
      const state = (await page.evaluate(() => window.agentClusterDesktop.status())).notifications;
      return Boolean(state.lastShownAt || state.error);
    }, 'native show/failed callback');
    const state = (await page.evaluate(() => window.agentClusterDesktop.status())).notifications;
    nativeResult = state.error || 'native show event received (OS may suppress banner in Do Not Disturb)';
  }
  // Isolate task reminders from real OS banners while testing routing and lifecycle.
  await instance.evaluate(({ Notification }) => {
    globalThis.fixtureNotices = [];
    Notification.prototype.show = function () { globalThis.fixtureNotices.push(this); this.emit('show', {}); };
  });
  await page.getByText('任务完成通知', { exact: true }).click();
  await until(async () => !(await page.evaluate(() => window.agentClusterDesktop.status())).notifications.enabled, 'setting disabled');
  assert.equal(JSON.parse(await readFile(join(profile, 'notifications.json'), 'utf8')).enabled, false);
  await page.getByText('任务完成通知', { exact: true }).click();
  await until(async () => (await page.evaluate(() => window.agentClusterDesktop.status())).notifications.enabled, 'setting enabled');
  await page.screenshot({ path: join(artifactDir, 'settings.png'), fullPage: true });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  updatedAt = '2026-09-14T00:00:02.000Z';
  events = [{ id: 'completion-1', type: 'session_status_changed', createdAt: '2026-09-14T00:00:01.000Z', metadata: { payload: { status: 'COMPLETED' } } }];
  await until(async () => await instance.evaluate(() => globalThis.fixtureNotices.length) === 1, 'completion while hidden');
  const notice = await instance.evaluate(() => ({ title: globalThis.fixtureNotices[0].title, body: globalThis.fixtureNotices[0].body }));
  assert.equal(notice.title, '任务已完成'); assert.match(notice.body, /通知验收会话/);
  await instance.evaluate(() => globalThis.fixtureNotices[0].emit('click', {}));
  await until(() => page.url().endsWith(`/workspace/${id}`), 'notification click routes to exact session');
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.goto('agent-cluster://app/desktop');
  const previousReads = listReads;
  await until(() => listReads > previousReads, 'next poll');
  assert.equal(await instance.evaluate(() => globalThis.fixtureNotices.length), 1);
  const result = { result: 'pass', nativeResult, checks: ['background completion', 'deduplication', 'click opens session and restores window', 'notification setting persisted'], profile };
  await writeFile(join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (instance) await instance.close();
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
