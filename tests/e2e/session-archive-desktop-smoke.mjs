import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import {
  api,
  buildServer,
  runNpm,
  startSmokeServer,
  stopSmokeServer
} from './smoke-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'agent-cluster-session-archive-desktop-'));
const screenshots = resolve('output/playwright/session-archive-desktop');
let server;
let instance;
let page;
const errors = [];
const consoleErrors = [];

try {
  await buildServer();
  await runNpm(['run', 'build', '-w', '@agent-cluster/desktop']);
  server = await startSmokeServer(`session-archive-desktop-${Date.now()}`, {
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    INTENT_ROUTING_MODE: 'disabled',
    DISCUSSION_MAX_ROUNDS: '0'
  });
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Desktop session archive smoke',
      projectId: 'desktop-archive-project',
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const sessionId = created.data.session.id;
  const sessionTitle = created.data.session.title;
  await writeFile(join(profile, 'desktop-config.json'), JSON.stringify({ schemaVersion: 1, serverUrl: server.apiBase.replace(/\/api$/, '') }) + '\n');
  await mkdir(screenshots, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  instance = await electron.launch({
    args: [join(root, 'apps/desktop'), `--user-data-dir=${profile}`],
    env,
    timeout: 60_000
  });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.locator('.session-sidebar').waitFor({ state: 'visible', timeout: 20_000 });
  await page.goto(`agent-cluster://app/workspace/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.session-sidebar').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByTitle('更多操作').first().click();
  const [archiveResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/sessions/${sessionId}/archive`) && response.request().method() === 'POST', { timeout: 20_000 }),
    page.locator('.session-context-menu').getByRole('button', { name: '归档会话', exact: true }).click()
  ]);
  assert.equal(archiveResponse.ok(), true);
  assert.equal((await archiveResponse.json()).data.archived, true);
  const archiveSnapshot = await page.evaluate(async () => {
    const response = await fetch('/api/sessions/archives');
    return await response.json();
  });
  console.log(`desktop archive API snapshot: ${JSON.stringify(archiveSnapshot)}`);
  await page.getByRole('button', { name: '归档管理', exact: true }).click();
  const archivedItem = page.locator('.session-archive-manager .session-list-item').filter({ hasText: sessionTitle });
  await archivedItem.waitFor({ state: 'visible', timeout: 20_000 });
  await page.screenshot({ path: join(screenshots, 'archived.png'), fullPage: true });
  await archivedItem.getByTitle('更多操作').click();
  const [restoreResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/sessions/${sessionId}/archive/restore`) && response.request().method() === 'POST', { timeout: 20_000 }),
    page.locator('.session-context-menu').getByRole('button', { name: '恢复归档', exact: true }).click()
  ]);
  assert.equal(restoreResponse.ok(), true);
  assert.equal((await restoreResponse.json()).data.restored, true);
  await page.locator('.session-tabs button.active').filter({ hasText: /^全部$/ }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.session-archive-manager').waitFor({ state: 'hidden', timeout: 20_000 });
  await page.locator('.session-sidebar .session-list-item.active').filter({ hasText: sessionTitle }).waitFor({ state: 'visible', timeout: 20_000 });
  const restoredSession = (await api(server.apiBase, `/sessions/${sessionId}`)).data;
  assert.equal(Boolean(restoredSession.archivedAt), false);
  await page.screenshot({ path: join(screenshots, 'restored.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(consoleErrors.some(message => message.startsWith('Route render failed')), false);
  console.log(JSON.stringify({ result: 'pass', sessionId, screenshots, checks: ['real Electron', 'three-dot archive', 'archive manager', 'restore'] }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(screenshots, 'failed.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({
      result: 'fail',
      url: page.url(),
      body: await page.locator('body').innerText().catch(() => 'unavailable'),
      errors,
      consoleErrors
    }));
  }
  throw error;
} finally {
  if (instance) await instance.close().catch(() => undefined);
  if (server) await stopSmokeServer(server).catch(() => undefined);
}
