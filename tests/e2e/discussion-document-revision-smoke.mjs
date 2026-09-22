import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  findFreePort,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent
} from './smoke-server.mjs';
import { startWebPreview, stopWebPreview } from './browser-smoke-utils.mjs';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'discussion-document-revision-'));
const screenshots = resolve('output/playwright/discussion-document-revision');
const firstContent = '# 方案 v1\n\n- 需求分析\n- Agent 讨论';
const secondContent = '# 方案 v2\n\n- 需求分析\n- Agent 讨论\n- 用户补充约束';
let server;
let web;
let desktop;
let browser;
let passed = false;

try {
  const webPort = await findFreePort();
  const desktopPort = await findFreePort();
  await buildServer();
  server = await startSmokeServer('discussion-document-revision', {
    DISCUSSION_MAX_ROUNDS: '0',
    INTENT_ROUTING_MODE: 'disabled',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    CORS_ORIGIN: `http://127.0.0.1:${webPort},http://127.0.0.1:${desktopPort}`
  });
  const workingDirectory = {
    kind: 'server_local',
    id: 'discussion-document-workspace',
    name: 'discussion-document-revision',
    path: fixtureRoot,
    selectedAt: new Date().toISOString()
  };
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '验证群聊方案文件化修订。',
    {
      agentIds: ['requirements'],
      workingDirectory,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  const submittedRevision = firstContent;
  const revised = await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/reject`, {
    method: 'POST',
    body: JSON.stringify({
      userMessage: submittedRevision,
      confirmationId: 'brief-revision-e2e'
    })
  });
  const revisedDocument = revised.data.discussionDocument;
  assert.ok(revisedDocument?.relativePath, 'brief revision must publish a workspace document');
  assert.equal(await readFile(join(fixtureRoot, ...revisedDocument.relativePath.split('/')), 'utf8'), submittedRevision);
  const revisionRead = await waitForEvent(server.apiBase, sessionId, 'discussion_document_read');
  assert.equal(revisionRead.metadata.payload.documentId, revisedDocument.id);
  assert.equal(revisionRead.metadata.payload.complete, true);
  assert.equal(revisionRead.metadata.payload.contentHash, revisedDocument.contentHash);
  const revisionEvents = await listEvents(server.apiBase, sessionId);
  assert.equal(JSON.stringify(revisionEvents.filter((event) => ['user_message', 'brief_rejected'].includes(event.type))).includes(submittedRevision), false,
    'brief revision Markdown must not be copied into ordinary event bodies');

  const createDocument = (content, clientMessageId, parentDocumentId) => api(
    server.apiBase,
    `/sessions/${sessionId}/discussion-documents`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': clientMessageId },
      body: JSON.stringify({
        title: '群聊实施方案',
        content,
        clientMessageId,
        ...(parentDocumentId ? { parentDocumentId } : {})
      })
    }
  );

  const [firstResponse, duplicateResponse] = await Promise.all([
    createDocument(firstContent, 'message-v1'),
    createDocument(firstContent, 'message-v1')
  ]);
  const first = firstResponse.data;
  assert.equal(duplicateResponse.data.id, first.id, 'a repeated submission must resolve to the same document');
  assert.equal(await readFile(join(fixtureRoot, ...first.relativePath.split('/')), 'utf8'), firstContent);

  const second = (await createDocument(secondContent, 'message-v2', first.id)).data;
  assert.equal(second.revision, 2);
  assert.equal(await readFile(join(fixtureRoot, ...second.relativePath.split('/')), 'utf8'), secondContent);
  assert.equal(second.contentHash, createHash('sha256').update(secondContent).digest('hex'));

  const firstAfter = (await api(server.apiBase, `/sessions/${sessionId}/discussion-documents/${first.id}`)).data;
  assert.equal(firstAfter.status, 'superseded');
  const active = (await api(server.apiBase, `/sessions/${sessionId}/discussion-documents/active`)).data;
  assert.equal(active.id, second.id);

  const contentResponse = await fetch(`${server.apiBase.replace(/\/api$/, '')}${second.contentUrl}`);
  assert.equal(contentResponse.status, 200);
  assert.match(contentResponse.headers.get('content-type') ?? '', /^text\/markdown/i);
  assert.equal(contentResponse.headers.get('cache-control'), 'no-store');
  assert.equal(contentResponse.headers.get('etag'), `"sha256-${second.contentHash}"`);
  assert.equal(await contentResponse.text(), secondContent);

  const events = await listEvents(server.apiBase, sessionId);
  const published = events.filter((event) => event.type === 'discussion_document_published');
  assert.equal(published.length, 2, 'v1 retry plus v2 must publish exactly two events');
  assert.equal(JSON.stringify(published).includes(firstContent), false, 'events must not carry the Markdown body');
  assert.equal(JSON.stringify(published).includes(secondContent), false, 'events must not carry the Markdown body');

  web = await startWebPreview(server.apiBase, webPort);
  desktop = await startWebPreview(server.apiBase, desktopPort, { desktop: true });
  browser = await chromium.launch({ headless: true });
  const webPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await Promise.all([
    webPage.goto(`${web.webBase}/workspace/${sessionId}`, { waitUntil: 'domcontentloaded' }),
    desktopPage.goto(`${desktop.webBase}/workspace/${sessionId}`, { waitUntil: 'domcontentloaded' })
  ]);
  await Promise.all([
    webPage.locator('.discussion-document-content').filter({ hasText: '用户补充约束' }).waitFor(),
    desktopPage.locator('.discussion-document-content').filter({ hasText: '用户补充约束' }).waitFor()
  ]);
  for (const page of [webPage, desktopPage]) {
    const cards = page.locator('.discussion-document-block');
    assert.equal(await cards.count(), 2);
    const latest = cards.filter({ hasText: '用户补充约束' });
    await assert.doesNotReject(() => latest.waitFor({ state: 'visible' }));
    const text = await latest.innerText();
    assert.ok(text.includes('v2'));
    assert.ok(text.includes(second.relativePath));
    assert.ok(text.includes(second.contentUrl));
    assert.ok(text.includes(second.contentHash));
  }

  await Promise.all([webPage.reload(), desktopPage.reload()]);
  await Promise.all([
    webPage.locator('.discussion-document-block').first().waitFor(),
    desktopPage.locator('.discussion-document-block').first().waitFor()
  ]);
  assert.equal(await webPage.locator('.discussion-document-block').count(), 2);
  assert.equal(await desktopPage.locator('.discussion-document-block').count(), 2);
  assert.equal((await listEvents(server.apiBase, sessionId)).filter((event) => event.type === 'discussion_document_published').length, 2);

  await mkdir(screenshots, { recursive: true });
  await Promise.all([
    webPage.screenshot({ path: resolve(screenshots, 'web.png'), fullPage: true }),
    desktopPage.screenshot({ path: resolve(screenshots, 'desktop.png'), fullPage: true })
  ]);
  console.log(JSON.stringify({ result: 'pass', sessionId, documentId: second.id, screenshots }));
  passed = true;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (desktop) await stopWebPreview(desktop).catch(() => undefined);
  if (web) await stopWebPreview(web).catch(() => undefined);
  if (server) await stopSmokeServer(server).catch(() => undefined);
  await rm(fixtureRoot, { recursive: true, force: true });
  if (passed) process.exit(0);
}
