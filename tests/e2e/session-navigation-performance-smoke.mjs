import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import { navigationFixtures, navigationFixture } from './fixtures/session-navigation-fixtures.mjs';

const root = resolve('apps/web/dist');
const output = resolve('output/playwright/session-navigation');
const fixtures = [...navigationFixtures, navigationFixture('stress', 10000)];
const data = new Map(fixtures.map(item => [item.session.id, item]));
const requests = [];
const errors = [];
const writes = [];
let delayedSession = '';
const server = createServer(async (request, response) => {
  // This server serves only the production frontend. Every API is intercepted below.
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
  if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  const extension = extname(path);
  try {
    const body = await readFile(extension ? path : resolve(root, 'index.html'));
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extension] ?? 'text/html');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.navigationLongTasks = [];
    new PerformanceObserver(list => window.navigationLongTasks.push(...list.getEntries().map(item => ({ start: item.startTime, duration: item.duration })))).observe({ type: 'longtask', buffered: true });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    requests.push({ path, method: request.method() });
    if (request.method() !== 'GET') {
      if (process.env.NAVIGATION_MUTATION_TEST === '1' && request.method() === 'POST' && path === '/sessions/A/messages') {
        writes.push({ path, body: request.postDataJSON(), idempotencyKey: request.headers()['idempotency-key'] });
        await new Promise(done => setTimeout(done, 800));
        const event = { ...data.get('A').events[0], id: 'A-sent', type: 'user_message', content: request.postDataJSON().content, createdAt: new Date().toISOString() };
        data.get('A').events.push(event);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { event } }) });
        return;
      }
      errors.push(`Unexpected write ${path}`); await route.abort(); return;
    }
    const id = path.match(/^\/sessions\/([^/]+)/)?.[1];
    let value = { items: [], hasMore: false };
    if (path === '/health') value = { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, buildId: 'navigation-fixture', commit: '', status: 'ok' };
    else if (path === '/sessions') value = { items: fixtures.map(item => ({ ...item.session, agentCount: 0, requiresUserAction: false })), hasMore: false };
    else if (path === '/sessions/archives') value = { groups: [] };
    else if (/^\/sessions\/[^/]+$/.test(path)) value = data.get(id)?.session;
    else if (path.endsWith('/events')) {
      if (id === delayedSession) await new Promise(done => setTimeout(done, 1200));
      const all = data.get(id)?.events ?? [];
      const cursor = url.searchParams.get('afterEventId');
      value = { items: cursor ? all.slice(all.findIndex(event => event.id === cursor) + 1) : all, hasMore: false };
    } else if (path.endsWith('/file-revisions')) value = { baselines: [], chains: [], runs: [], drafts: [] };
    else if (path.endsWith('/stop-state')) value = { sessionId: id, version: 0, status: 'idle', requestedCount: 0, confirmedCount: 0, blockers: [], targets: [], canResume: false };
    else if (path.endsWith('/content')) { await route.fulfill({ contentType: 'text/plain', body: '# 匿名文档\n\n这是完整的测试内容。' }); return; }
    else if (['/agents', '/capabilities', '/system-agent-runtime-policies', '/workflows', '/local-runtime/devices'].includes(path)) value = [];
    else if (path === '/local-runtime/launch-config') value = { serverUrl: 'http://127.0.0.1:1' };
    else if (path === '/runtime-config') value = {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: value, requestId: 'fixture' }) });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ready = async id => {
    await page.waitForFunction(id => location.pathname.endsWith('/' + id) &&
      document.querySelector('.session-list-item.active')?.textContent?.includes(`导航测试 ${id}`) &&
      document.querySelector(`[data-message-id^="msg-${id}-"]`) &&
      !document.querySelector('.chat-pane')?.textContent?.includes('正在切换会话'), id).catch(async error => {
        await page.screenshot({ path: resolve(output, 'failure.png') });
        await writeFile(resolve(output, 'failure.json'), JSON.stringify({ errors, requests, body: await page.locator('body').innerText() }, null, 2));
        throw error;
      });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const choose = id => page.locator('.session-list-item').filter({ hasText: `导航测试 ${id}` }).click();
  await page.goto(`${base}/workspace/A`);
  await ready('A');
  await page.evaluate(() => { window.originalComposer = document.querySelector('#group-chat-message-input'); });
  delayedSession = 'B';
  await choose('B');
  await page.waitForTimeout(50);
  await choose('C');
  await ready('C');
  await page.waitForTimeout(1300);
  assert.equal(new URL(page.url()).pathname, '/workspace/C', 'late B response must not navigate back');
  delayedSession = '';
  if (process.env.NAVIGATION_MUTATION_TEST === '1') {
    await choose('A'); await ready('A');
    await page.locator('#group-chat-message-input').fill('只提交给 A 的消息');
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/sessions/A/messages'));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await sent;
    await choose('B'); await ready('B');
    await page.locator('#group-chat-message-input').fill('B 新写的草稿');
    await page.waitForTimeout(1000);
    assert.equal(new URL(page.url()).pathname, '/workspace/B');
    assert.equal(await page.locator('#group-chat-message-input').inputValue(), 'B 新写的草稿');
    assert.equal(writes.length, 1);
    assert.ok(writes[0].idempotencyKey);
    assert.equal(writes[0].body.content, '只提交给 A 的消息');
    await choose('C'); await ready('C');
  }
  const samples = [];
  for (let index = 0; index < Number(process.env.NAVIGATION_SAMPLES ?? 30); index++) {
    const id = index % 2 ? 'C' : 'A';
    const start = await page.evaluate(() => performance.now());
    const requestStart = requests.length;
    await choose(id);
    await ready(id);
    const result = await page.evaluate(start => ({ readyMs: performance.now() - start, dom: document.querySelectorAll('*').length,
      rows: document.querySelectorAll('[data-message-id]').length, sameComposer: window.originalComposer === document.querySelector('#group-chat-message-input'),
      heap: performance.memory?.usedJSHeapSize, start }), start);
    await page.waitForTimeout(2000);
    result.longTasks = await page.evaluate(start => window.navigationLongTasks.filter(task => task.start >= start), start);
    result.requests = requests.slice(requestStart);
    samples.push({ id, ...result });
    assert.ok(result.rows < 80, 'DOM must be windowed');
    assert.ok(result.sameComposer, 'workspace/composer must not remount');
  }
  await choose('C'); await ready('C');
  await page.locator('#group-chat-message-input').fill('C 的未提交草稿');
  await page.locator('main.chat-timeline').evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await page.waitForTimeout(400);
  const anchor = await page.evaluate(() => {
    const el = document.querySelector('main.chat-timeline');
    const row = [...el.querySelectorAll('[data-message-id]')].find(item => item.getBoundingClientRect().bottom >= el.getBoundingClientRect().top);
    return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
      saved: sessionStorage.getItem('web-task-reading:C'), top: el.scrollTop, clientTop: el.clientTop,
      width: el.clientWidth, rows: [...el.querySelectorAll('[data-message-id]')].map(row => ({ id: row.dataset.messageId, top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height })) };
  });
  await choose('A'); await ready('A');
  assert.equal(await page.locator('#group-chat-message-input').inputValue(), '');
  await choose('C'); await ready('C');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#group-chat-message-input').inputValue(), 'C 的未提交草稿');
  const restoredAnchor = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top - row.closest('main').getBoundingClientRect().top);
  await writeFile(resolve(output, 'anchor.json'), JSON.stringify({ anchor, restoredAnchor,
    state: await page.evaluate(() => ({ saved: sessionStorage.getItem('web-task-reading:C'),
      top: document.querySelector('main.chat-timeline').scrollTop,
      rows: [...document.querySelectorAll('[data-message-id]')].map(row => ({ id: row.dataset.messageId, top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height })) })) }, null, 2));
  assert.ok(Math.abs(restoredAnchor - anchor.offset) < 4, `anchor drift: ${restoredAnchor - anchor.offset}`);
  await choose('stress'); await ready('stress');
  const stressRows = await page.locator('[data-message-id]').count();
  assert.ok(stressRows < 80);
  await page.screenshot({ path: resolve(output, 'windowed-timeline.png') });
  const sorted = samples.map(item => item.readyMs).sort((a, b) => a - b);
  const report = { mode: 'production frontend / intercepted anonymous API', browser: browser.version(),
    evidenceBoundary: 'Warm mock-API timings include Playwright click overhead; not local-backend cold or OS pointer acceptance.',
    samples, p95: sorted[Math.ceil(sorted.length * .95) - 1], stressRows, anchorDrift: restoredAnchor - anchor.offset, errors, requests, writes };
  await writeFile(resolve(output, 'performance.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ samples: samples.length, p95: report.p95, stressRows, errors }));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
