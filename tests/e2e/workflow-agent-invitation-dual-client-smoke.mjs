import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  api,
  buildServer,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  findFreePort,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';
import { startWebPreview, stopWebPreview } from './browser-smoke-utils.mjs';

const screenshots = resolve('output/playwright/workflow-agent-invitation');

function payload(event) {
  return event?.metadata?.payload ?? {};
}

async function expectRefusal(label, operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    const message = String(error?.message ?? error);
    assert.match(message, new RegExp(expectedCode, 'i'), `${label}: ${message}`);
    return;
  }
  throw new Error(`${label}: expected ${expectedCode}, but the operation succeeded`);
}

function mappingCard(page) {
  return page.locator('.confirmation-card__member-mapping:visible').first();
}

async function waitForMappingEvidence(page, expected) {
  const card = mappingCard(page);
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  const text = await card.innerText();
  for (const value of expected) {
    assert.ok(text.includes(value), `mapping card must display ${JSON.stringify(value)}; got:\n${text}`);
  }
  return card;
}

async function waitForMappingGone(page) {
  await page.waitForFunction(() => {
    return [...document.querySelectorAll('.confirmation-card__member-mapping')].every((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden';
    });
  }, undefined, { timeout: 20_000 });
}

async function cleanupWithin(label, operation, timeoutMs = 10_000) {
  let timer;
  await Promise.race([
    operation().catch((error) => {
      console.warn(`${label} cleanup failed: ${String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`${label} cleanup exceeded ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
}

await buildServer();

let server;
let web;
let desktop;
let browser;
let webContext;
let desktopContext;
let passed = false;

try {
  const webPort = await findFreePort();
  const desktopPort = await findFreePort();
  server = await startSmokeServer('workflow-agent-invitation-dual-client', {
    DISCUSSION_MAX_ROUNDS: '0',
    INTENT_ROUTING_MODE: 'disabled',
    REQUIREMENT_DOCUMENT_ENABLED: 'true',
    MOCK_RUNTIME_DELAY_MS: '15000',
    CORS_ORIGIN: `http://127.0.0.1:${webPort},http://127.0.0.1:${desktopPort}`
  });

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    '双端 Agent 邀请验收流程',
    ['requirements', 'test']
  );
  const created = await createSessionAndWaitForBrief(
    server.apiBase,
    '验证 Web 与桌面端对工作流 Agent 邀请决定保持一致。',
    {
      agentIds: ['requirements'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );
  const briefConfirmation = await waitForMatchingEvent(
    server.apiBase,
    created.sessionId,
    'user_confirmation_requested',
    (event) => payload(event).reason === 'confirm_task_brief'
  );
  await api(server.apiBase, `/sessions/${created.sessionId}/briefs/${created.briefId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ confirmationId: payload(briefConfirmation).confirmationId })
  });
  await waitForStatus(server.apiBase, created.sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    server.apiBase,
    created.sessionId,
    'user_confirmation_requested',
    (event) => payload(event).reason === 'select_workflow'
  );
  const selectWorkflow = () => api(server.apiBase, `/sessions/${created.sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      confirmationId: payload(workflowSelection).confirmationId
    })
  });
  await expectRefusal('initial workflow selection', selectWorkflow, 'capability_mapping_required');

  const firstMapping = await waitForMatchingEvent(
    server.apiBase,
    created.sessionId,
    'user_confirmation_requested',
    (event) => payload(event).reason === 'confirm_workflow_member_mapping'
  );
  const firstPayload = payload(firstMapping);
  const gap = firstPayload.memberGaps?.[0];
  assert.ok(gap?.agentId && gap.agentName, 'the mapping event must identify the missing Agent');
  assert.equal(gap.reason, 'not_participating');
  assert.ok(gap.nodes?.[0]?.impact, 'the mapping event must include published-node impact evidence');

  web = await startWebPreview(server.apiBase, webPort);
  desktop = await startWebPreview(server.apiBase, desktopPort, { desktop: true });
  browser = await chromium.launch({ headless: true });
  webContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const webPage = await webContext.newPage();
  const desktopPage = await desktopContext.newPage();
  const webErrors = [];
  const desktopErrors = [];
  webPage.on('pageerror', (error) => webErrors.push(String(error)));
  desktopPage.on('pageerror', (error) => desktopErrors.push(String(error)));

  await Promise.all([
    webPage.goto(`${web.webBase}/workspace/${created.sessionId}`, { waitUntil: 'domcontentloaded' }),
    desktopPage.goto(`${desktop.webBase}/workspace/${created.sessionId}`, { waitUntil: 'domcontentloaded' })
  ]);
  const evidence = [
    workflow.name,
    `v${workflow.version}`,
    gap.agentName,
    gap.nodes[0].nodeName ?? gap.nodes[0].nodeId,
    gap.nodes[0].impact
  ];
  await Promise.all([
    waitForMappingEvidence(webPage, evidence),
    waitForMappingEvidence(desktopPage, evidence)
  ]);
  await mkdir(screenshots, { recursive: true });
  await Promise.all([
    webPage.screenshot({ path: resolve(screenshots, 'web-pending.png') }),
    desktopPage.screenshot({ path: resolve(screenshots, 'desktop-pending.png') })
  ]);

  // Hold the desktop approval in flight, then let Web commit the decline first.
  // Releasing the stale approval must yield a conflict and reconcile the client.
  let releaseApprovalRequest;
  let markApprovalRequestObserved;
  const approvalRequestGate = new Promise((resolve) => { releaseApprovalRequest = resolve; });
  const approvalRequestObserved = new Promise((resolve) => { markApprovalRequestObserved = resolve; });
  await desktopPage.route('**/workflow/member-mapping', async (route) => {
    markApprovalRequestObserved();
    await approvalRequestGate;
    await route.continue();
  });
  await desktopPage
    .locator('.confirmation-card__member-mapping:visible')
    .first()
    .getByRole('button', { name: '邀请并启动', exact: true })
    .click();
  await approvalRequestObserved;
  await webPage
    .locator('.confirmation-card__member-mapping:visible')
    .first()
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await webPage.locator('section[aria-label="工作流未启动"]').waitFor({ state: 'visible', timeout: 20_000 });
  await Promise.all([waitForMappingGone(desktopPage), waitForMappingGone(webPage)]);
  const conflictResponse = desktopPage.waitForResponse((response) =>
    response.url().includes('/workflow/member-mapping') && response.status() === 409
  );
  releaseApprovalRequest();
  assert.equal((await conflictResponse).status(), 409, 'the later opposing decision must be rejected');
  await desktopPage.unroute('**/workflow/member-mapping');

  let detail = (await api(server.apiBase, `/sessions/${created.sessionId}`)).data;
  assert.equal(detail.workflowRunId, undefined, 'declining must not start a WorkflowRun');
  assert.equal(detail.participatingAgentIds.includes(gap.agentId), false, 'declining must not add the Agent');
  let events = await listEvents(server.apiBase, created.sessionId);
  const firstResolutions = events.filter((event) =>
    event.type === 'user_confirmation_resolved' &&
    payload(event).confirmationId === firstPayload.confirmationId
  );
  assert.equal(firstResolutions.length, 1, 'competing decisions must record exactly one authoritative resolution');
  assert.equal(payload(firstResolutions[0]).selectedOptionKey, 'decline');
  assert.equal(await webPage.locator('.workflow-dialog-backdrop').count(), 0,
    'decline must not automatically reopen the workflow selector');
  await webPage.getByRole('heading', { name: '重新选择执行工作流' }).first().waitFor({ state: 'visible' });
  await webPage
    .locator('.workflow-mapping-result-dialog')
    .getByRole('button', { name: '选择其他已发布流程', exact: true })
    .click();
  await webPage.locator('.workflow-dialog-backdrop').waitFor({ state: 'visible' });
  await webPage.locator('.workflow-dialog header button').click();
  assert.equal(await webPage.locator('.workflow-dialog-backdrop').count(), 0,
    'explicit reselection can close without starting a workflow');

  // Reload desktop with its new SSE request blocked. Explicit reselection then
  // creates one new decision; reconnect/backfill must restore that missed card.
  await desktopPage.route('**/events/stream', (route) => route.abort('failed'));
  await desktopPage.reload();
  await desktopPage.locator('.application-shell').waitFor();
  assert.equal(await desktopPage.locator('.confirmation-card__member-mapping:visible').count(), 0,
    'the reloaded desktop must begin from the resolved server state');
  await expectRefusal('explicit workflow reselection', selectWorkflow, 'capability_mapping_required');
  const mappingRequests = (await listEvents(server.apiBase, created.sessionId)).filter((event) =>
    event.type === 'user_confirmation_requested' &&
    payload(event).reason === 'confirm_workflow_member_mapping'
  );
  assert.equal(mappingRequests.length, 2, 'explicit reselection must create exactly one new mapping card');
  const secondPayload = payload(mappingRequests[1]);
  await waitForMappingEvidence(webPage, evidence);
  assert.equal(await desktopPage.locator('.confirmation-card__member-mapping:visible').count(), 0,
    'the disconnected desktop must not invent a local mapping card');

  await desktopPage.unroute('**/events/stream');
  await waitForMappingEvidence(desktopPage, evidence);
  await desktopPage
    .locator('.confirmation-card__member-mapping:visible')
    .first()
    .getByRole('button', { name: '邀请并启动', exact: true })
    .click();
  await Promise.all([waitForMappingGone(webPage), waitForMappingGone(desktopPage)]);

  detail = (await api(server.apiBase, `/sessions/${created.sessionId}`)).data;
  assert.equal(detail.participatingAgentIds.includes(gap.agentId), true, 'approval must add the missing Agent');
  assert.ok(detail.workflowRunId, 'approval must continue the locked selection and start a WorkflowRun');
  const replay = await api(server.apiBase, `/sessions/${created.sessionId}/workflow/member-mapping`, {
    method: 'POST',
    body: JSON.stringify({ confirmationId: secondPayload.confirmationId, decision: 'approve' })
  });
  assert.equal(replay.data.workflowRun?.id, detail.workflowRunId, 'approval replay must return the authoritative run');

  events = await listEvents(server.apiBase, created.sessionId);
  const started = events.filter((event) =>
    event.type === 'workflow_run_started' && payload(event).workflowRunId === detail.workflowRunId
  );
  assert.equal(started.length, 1, 'approval and replay must start the locked workflow exactly once');

  await Promise.all([webPage.reload(), desktopPage.reload()]);
  await Promise.all([
    webPage.locator('.application-shell').waitFor(),
    desktopPage.locator('.application-shell').waitFor()
  ]);
  await Promise.all([
    webPage.locator('.session-list-item.active').waitFor(),
    desktopPage.locator('.session-list-item.active').waitFor()
  ]);
  assert.equal(await webPage.locator('.confirmation-card__member-mapping:visible').count(), 0,
    'Web refresh must retain the resolved server state');
  assert.equal(await desktopPage.locator('.confirmation-card__member-mapping:visible').count(), 0,
    'desktop refresh must retain the resolved server state');
  assert.deepEqual(webErrors, [], `Web page errors: ${webErrors.join('\n')}`);
  assert.deepEqual(desktopErrors, [], `Desktop renderer page errors: ${desktopErrors.join('\n')}`);
  await Promise.all([
    webPage.screenshot({ path: resolve(screenshots, 'web-resolved.png') }),
    desktopPage.screenshot({ path: resolve(screenshots, 'desktop-resolved.png') })
  ]);

  console.log(JSON.stringify({
    result: 'pass',
    sessionId: created.sessionId,
    workflowRunId: detail.workflowRunId,
    checks: [
      'same pending evidence in Web and desktop renderer',
      'decline wins over stale competing approval',
      'conflicting client reconciles from server events',
      'SSE reconnect/backfill restores the new pending card',
      'approval starts exactly one WorkflowRun',
      'refresh retains resolved state'
    ],
    screenshots
  }));
  passed = true;
} finally {
  if (browser) await cleanupWithin('browser', () => browser.close());
  if (desktop) await cleanupWithin('desktop preview', () => stopWebPreview(desktop));
  if (web) await cleanupWithin('Web preview', () => stopWebPreview(web));
  if (server) await cleanupWithin('smoke server', () => stopSmokeServer(server));
  // Playwright may retain a Windows transport handle after every owned process
  // has closed. Only force a clean exit after all assertions and cleanup pass;
  // failures still propagate with a non-zero exit code and their original stack.
  if (passed) process.exit(0);
}
