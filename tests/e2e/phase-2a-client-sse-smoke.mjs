import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, _electron as electron } from 'playwright';
import {
  api,
  buildServer,
  findFreePort,
  root,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent
} from './smoke-server.mjs';
import { runNpm, startWebPreview, stopWebPreview } from './browser-smoke-utils.mjs';

async function openEventStream(page, key, streamUrl) {
  await page.evaluate(async ({ key, streamUrl }) => {
    const streams = window.__phase2aSseStreams ??= {};
    const events = [];
    const source = new EventSource(streamUrl);
    streams[key] = { source, events };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        source.close();
        reject(new Error(`SSE open timeout: ${key}`));
      }, 10_000);
      source.addEventListener('collaboration-event', (event) => {
        events.push(JSON.parse(event.data));
      });
      source.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      source.onerror = () => {
        clearTimeout(timeout);
        source.close();
        reject(new Error(`SSE failed to open: ${key}`));
      };
    });
  }, { key, streamUrl });
}

async function waitForStreamEvent(page, key, content) {
  const handle = await page.waitForFunction(
    ({ key, content }) => window.__phase2aSseStreams?.[key]?.events.find((event) => event.content === content),
    { key, content },
    { timeout: 20_000 }
  );
  return handle.jsonValue();
}

async function closeEventStream(page, key) {
  await page.evaluate((key) => {
    window.__phase2aSseStreams?.[key]?.source.close();
  }, key);
}

await buildServer();

let server;
let web;
let browser;
let desktop;
let profile;

try {
  const webPort = await findFreePort();
  server = await startSmokeServer('phase-2a-client-sse-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    INTENT_ROUTING_MODE: 'disabled',
    CORS_ORIGIN: `http://127.0.0.1:${webPort}`
  });
  web = await startWebPreview(server.apiBase, webPort);
  browser = await chromium.launch({ headless: true });
  const webPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const webErrors = [];
  webPage.on('pageerror', (error) => webErrors.push(String(error)));
  await webPage.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });

  profile = await mkdtemp(join(tmpdir(), 'agent-cluster-phase-2a-sse-'));
  await writeFile(
    join(profile, 'desktop-config.json'),
    JSON.stringify({ schemaVersion: 1, serverUrl: new URL(server.apiBase).origin })
  );
  await runNpm(['run', 'desktop:build']);
  const desktopEnv = { ...process.env };
  delete desktopEnv.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    args: [resolve(root, 'apps/desktop'), `--user-data-dir=${profile}`],
    env: desktopEnv,
    timeout: 60_000
  });
  const desktopPage = await desktop.firstWindow();
  const desktopErrors = [];
  desktopPage.on('pageerror', (error) => desktopErrors.push(String(error)));
  await desktopPage.waitForFunction(() => document.querySelector('#app .application-shell'), undefined, { timeout: 20_000 });

  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: '验证同一会话在 Web 和桌面端的实时事件同步。' })
  });
  const sessionId = created.data.session.id;
  await waitForEvent(server.apiBase, sessionId, 'user_message');

  await openEventStream(webPage, 'web', `${server.apiBase}/sessions/${sessionId}/events/stream`);
  await openEventStream(desktopPage, 'desktop', `/api/sessions/${sessionId}/events/stream`);

  const send = async (content, key) => api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: JSON.stringify({ content })
  });

  const firstContent = 'phase-2a SSE event one';
  await send(firstContent, 'phase-2a-sse-first');
  const [webFirst, desktopFirst] = await Promise.all([
    waitForStreamEvent(webPage, 'web', firstContent),
    waitForStreamEvent(desktopPage, 'desktop', firstContent)
  ]);
  assert.equal(webFirst.id, desktopFirst.id, 'both real client transports must receive the same server event id');

  await closeEventStream(webPage, 'web');
  const missedContent = 'phase-2a SSE event while web is disconnected';
  await send(missedContent, 'phase-2a-sse-missed');
  const desktopMissed = await waitForStreamEvent(desktopPage, 'desktop', missedContent);

  const backfill = await webPage.evaluate(async ({ apiBase, sessionId, afterEventId }) => {
    const response = await fetch(`${apiBase}/sessions/${sessionId}/events?afterEventId=${encodeURIComponent(afterEventId)}`);
    if (!response.ok) throw new Error(`backfill failed: ${response.status}`);
    return response.json();
  }, { apiBase: server.apiBase, sessionId, afterEventId: webFirst.id });
  const missed = backfill.data.items.filter((event) => event.id === desktopMissed.id);
  assert.equal(missed.length, 1, 'HTTP backfill must expose the one event missed while the Web stream was closed');

  await openEventStream(webPage, 'web-reconnected', `${server.apiBase}/sessions/${sessionId}/events/stream`);
  const finalContent = 'phase-2a SSE event after web reconnect';
  await send(finalContent, 'phase-2a-sse-reconnected');
  const [webFinal, desktopFinal] = await Promise.all([
    waitForStreamEvent(webPage, 'web-reconnected', finalContent),
    waitForStreamEvent(desktopPage, 'desktop', finalContent)
  ]);
  assert.equal(webFinal.id, desktopFinal.id);
  assert.deepEqual(webErrors, [], `Web page errors: ${webErrors.join('\n')}`);
  assert.deepEqual(desktopErrors, [], `Desktop renderer errors: ${desktopErrors.join('\n')}`);

  console.log('phase 2A client SSE smoke ok: Web and desktop received live events; Web backfilled and reconnected');
} finally {
  if (desktop) await desktop.close();
  if (browser) await browser.close();
  if (web) await stopWebPreview(web);
  if (server) await stopSmokeServer(server);
  if (profile) await rm(profile, { recursive: true, force: true });
}
