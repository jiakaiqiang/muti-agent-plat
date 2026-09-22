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

try {
  await buildServer();
  await runNpm(['run', 'build', '-w', '@agent-cluster/desktop']);
  server = await startSmokeServer(`session-archive-desktop-${Date.now()}`, {
    INTENT_ROUTING_MODE: 'disabled',
    DISCUSSION_MAX_ROUNDS: '0'
  });
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: 'Desktop session archive smoke', projectId: 'desktop-archive-project' })
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
  const page = await instance.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('.session-sidebar').waitFor({ state: 'visible', timeout: 20_000 });
  await page.goto(`agent-cluster://app/workspace/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.session-sidebar').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByTitle('更多操作').first().click();
  await page.locator('.session-context-menu').getByRole('button', { name: '归档会话', exact: true }).click();
  await page.waitForTimeout(300);
  const archiveSnapshot = await page.evaluate(async () => {
    const response = await fetch('/api/sessions/archives');
    return await response.json();
  });
  console.log(`desktop archive API snapshot: ${JSON.stringify(archiveSnapshot)}`);
  await page.getByRole('button', { name: '归档管理', exact: true }).click();
  await page.locator('.session-archive-item').filter({ hasText: sessionTitle }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.screenshot({ path: join(screenshots, 'archived.png'), fullPage: true });
  await page.locator('.session-archive-item').filter({ hasText: sessionTitle }).getByRole('button', { name: /恢复/ }).click();
  await page.locator('.session-list-item').filter({ hasText: sessionTitle }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.screenshot({ path: join(screenshots, 'restored.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', sessionId, screenshots, checks: ['real Electron', 'three-dot archive', 'archive manager', 'restore'] }));
} finally {
  if (instance) await instance.close().catch(() => undefined);
  if (server) await stopSmokeServer(server).catch(() => undefined);
}
