// Built-resource regression: identical platform data, independently owned Web/desktop UI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const shots = resolve(root, 'output/playwright/client-separation');
await mkdir(shots, { recursive: true });
const timestamp = '2026-09-11T08:00:00Z';
const session = {
  id: 'presentation-session', title: '需求开发验证', originalInput: '保留 Web 原有界面，独立交付桌面工作区。',
  status: 'EXECUTING', participatingAgentIds: [], agentCount: 0,
  requiresUserAction: false, tokenUsed: 0, tokenBudget: 100000,
  createdAt: timestamp, updatedAt: timestamp, workflowRunId: 'presentation-run'
};
const definition = {
  id: 'presentation-version', workflowId: 'presentation-flow', version: 1,
  name: '需求开发验证流程', description: '固定版本的流程样本', status: 'published',
  nodes: [{ id: 'verify', type: 'human_approval', name: '验证与返工', order: 0,
    title: '验证本轮结果', assignee: 'session_owner', allowedDecisions: ['approve', 'revise', 'cancel'] }],
  edges: [], createdAt: timestamp
};
const run = { id: session.workflowRunId, sessionId: session.id, workflowId: definition.workflowId,
  workflowName: definition.name, workflowVersion: 1, definitionSnapshot: definition,
  status: 'completed', revision: 1, createdAt: timestamp, updatedAt: timestamp };
const events = [{ id: 'presentation-message', sessionId: session.id, type: 'user_message',
  actor: { type: 'user', id: 'fixture' }, content: session.originalInput, metadata: {}, createdAt: timestamp },
  { id: 'presentation-progress', sessionId: session.id, type: 'runtime_progress', content: '正在执行任务',
    metadata: { schemaVersion: '0.1', payload: {} }, createdAt: new Date().toISOString() },
  { id: 'presentation-budget-exhausted', sessionId: session.id, type: 'user_confirmation_requested',
    content: '当前需求的预算已用尽，请提交拆分或缩小范围后的新需求。', metadata: {
      schemaVersion: '0.1', payload: {
        confirmationId: 'presentation-budget-exhausted-confirmation',
        reason: 'work_item_budget_exhausted',
        title: '需要拆分当前需求',
        description: '系统不会重试已耗尽预算的任务。请提交拆分或缩小范围后的新需求。',
        options: [
          { key: 'submit_narrowed_requirement', label: '提交拆分需求', style: 'primary' },
          { key: 'cancel', label: '取消会话', style: 'default' }
        ]
      }
    }, createdAt: new Date().toISOString() }];
const pageData = items => ({ items, hasMore: false });
function dataFor(path) {
  if (path === '/health') return { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, buildId: 'presentation-fixture' };
  if (path === '/sessions') return pageData([session]);
  if (path === `/sessions/${session.id}`) return session;
  if (path === `/sessions/${session.id}/stop-state`) {
    if (session.status === 'PAUSED') return {
      sessionId: session.id,
      stopRequestId: 'presentation-stop-request',
      version: 2,
      status: 'confirmed',
      requestedCount: 1,
      confirmedCount: 1,
      targets: [{
        invocationId: 'presentation-invocation',
        operationId: 'presentation-operation',
        state: 'confirmed',
        evidence: 'adapter_result',
        updatedAt: session.updatedAt
      }],
      blockers: [],
      canResume: true,
      updatedAt: session.updatedAt
    };
    return {
      sessionId: session.id,
      version: 0,
      status: 'idle',
      requestedCount: 0,
      confirmedCount: 0,
      targets: [],
      blockers: [],
      canResume: true
    };
  }
  if (path.endsWith('/events')) return pageData(events);
  if (path.endsWith('/file-revisions')) return { baselines: [], chains: [], runs: [], drafts: [] };
  if (path.endsWith('/work-items') || path.endsWith('/artifacts')) return pageData([]);
  if (path === `/workflow-runs/session/${session.id}`) return pageData([run]);
  if (path === `/workflow-runs/${run.id}`) return { run, nodeRuns: [], approvals: [] };
  if (path === '/workflows/catalog/published') return pageData([definition]);
  if (path === '/runtimes/availability') return { items: [] };
  if (path === '/workflows') return [];
  return [];
}
async function serve(directory) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = pathname.startsWith('/assets/') || pathname === '/favicon.svg' ? resolve(directory, '.' + pathname) : resolve(directory, 'index.html');
      if (!file.startsWith(directory + sep)) { res.writeHead(403).end(); return; }
      const content = await readFile(file);
      res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const servers = [];
let browser;
let browserServer;
try {
  browserServer = await chromium.launchServer({ headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
  for (const client of ['web', 'desktop']) {
    session.status = 'EXECUTING';
    const directory = resolve(root, client === 'web' ? 'apps/web/dist' : 'apps/desktop/dist/renderer');
    const handle = await serve(directory); servers.push(handle.server);
    assert.match(await (await fetch(`${handle.origin}/favicon.svg`)).text(), /<svg/);
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    // Stable transport fixture; actual SSE reconnection is covered by store tests.
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { this.timer = setTimeout(() => this.onopen?.(new Event('open')), 0); }
        addEventListener() {}
        close() { clearTimeout(this.timer); }
      };
    });
    page.setDefaultTimeout(10000);
    const errors = []; const writes = []; const reads = [];
    let acknowledgePause;
    let receivePause;
    const pauseReceived = new Promise(resolve => { receivePause = resolve; });
    const pauseAcknowledged = new Promise(resolve => { acknowledgePause = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request();
      if (!['GET', 'OPTIONS'].includes(req.method())) writes.push(req.method() + ' ' + req.url());
      const path = new URL(req.url()).pathname.replace(/^.*\/api/, '');
      reads.push(path);
      if (req.method() === 'POST' && [`/sessions/${session.id}/pause`, `/sessions/${session.id}/resume`].includes(path)) {
        session.status = path.endsWith('/pause') ? 'PAUSED' : 'EXECUTING';
        session.updatedAt = new Date().toISOString();
        if (path.endsWith('/pause')) {
          receivePause();
          await pauseAcknowledged;
        }
        await route.fulfill({ json: { data: { session }, requestId: 'presentation-fixture' } });
        return;
      }
      await route.fulfill({ json: { data: dataFor(path), requestId: 'presentation-fixture' } });
    });
    await page.goto(`${handle.origin}/workspace/${session.id}`);
    await page.locator('.session-list-item.active').waitFor();
    await page.getByText(session.originalInput, { exact: true }).last().waitFor();
    const budgetConfirmations = page.locator('.confirmation-card').filter({ hasText: '需要拆分当前需求' });
    await budgetConfirmations.first().waitFor();
    const confirmationCount = await budgetConfirmations.count();
    assert.ok(confirmationCount >= 1, `${client}: the budget confirmation must be visible`);
    for (let index = 0; index < confirmationCount; index += 1) {
      const budgetConfirmation = budgetConfirmations.nth(index);
      await budgetConfirmation.getByRole('button', { name: '提交拆分需求', exact: true }).waitFor();
      await budgetConfirmation.getByRole('button', { name: '取消会话', exact: true }).waitFor();
      assert.equal(
        await budgetConfirmation.getByRole('button', { name: '继续执行', exact: true }).count(),
        0,
        `${client}: an exhausted WorkItem must not offer retrying the old budget ledger`
      );
    }
    const activity = page.locator('.user-input-box .task-activity');
    await activity.filter({ hasText: '正在运行你的任务，请稍等' }).waitFor();
    const activityBox = await activity.boundingBox();
    const inputBox = await page.locator('.user-input-box').boundingBox();
    const inputHeight = inputBox?.height;
    const textarea = page.locator('.user-input-box textarea');
    const textareaHeight = await textarea.evaluate(element => element.getBoundingClientRect().height);
    const actionButtonBox = await page.locator('.user-input-box .send-button').boundingBox();
    assert.equal(Math.round(inputHeight), 96, `${client}: composer has the requested fixed height`);
    assert.equal(Math.round(textareaHeight), 70, `${client}: textarea has fixed height`);
    assert.deepEqual(
      { width: Math.round(actionButtonBox?.width ?? 0), height: Math.round(actionButtonBox?.height ?? 0) },
      { width: 42, height: 42 },
      `${client}: action button matches Codex sizing`
    );
    await textarea.fill(Array.from({ length: 8 }, (_, index) => `固定高度输入 ${index + 1}`).join('\n'));
    const multilineInput = await textarea.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    }));
    assert.equal(Math.round(multilineInput.height), 70, `${client}: multiline input keeps textarea height`);
    assert.ok(multilineInput.scrollHeight > multilineInput.clientHeight, `${client}: multiline input scrolls internally`);
    assert.ok(Math.abs((await page.locator('.user-input-box').boundingBox()).height - inputHeight) <= 1,
      `${client}: multiline input does not resize composer`);
    await textarea.fill('');
    assert.ok(activityBox.y + activityBox.height <= inputBox.y, `${client}: activity stays above composer`);
    const rail = page.locator('.application-rail');
    const avatar = page.locator('.session-list-item .agent-portrait');
    if (client === 'web') {
      assert.equal(await rail.isVisible(), true);
      assert.equal(Math.round((await rail.boundingBox()).width), 92);
      assert.equal(await avatar.count(), 1);
      assert.equal(await page.getByRole('button', { name: '新建会话', exact: true }).count(), 1);
      assert.equal(await page.locator('.task-workspace, .workspace-view-tabs').count(), 0);
      const loadedStyles = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join('\n'));
      assert.equal(loadedStyles.includes('.task-workspace'), false, 'Web must not load desktop CSS');
      await page.screenshot({ path: resolve(shots, 'web-chat.png') });
      await page.locator('.workspace-actions').getByRole('button', { name: '工作流', exact: true }).click();
      await page.locator('.workflow-canvas').waitFor();
      assert.equal(await rail.isVisible(), true);
      assert.equal(await page.locator('.collaboration-log-panel').isVisible(), true);
      await page.screenshot({ path: resolve(shots, 'web-workflow.png') });
      await page.goto(`${handle.origin}/workflows`);
      await page.locator('.workflow-manager').waitFor();
    } else {
      assert.equal(await rail.count(), 0);
      assert.equal(await avatar.count(), 0);
      assert.equal(await page.locator('.session-avatar').count(), 0);
      assert.equal(await page.getByRole('button', { name: '新建任务', exact: true }).count(), 1);
      assert.equal(await page.locator('.sidebar-catalog-button, .sidebar-management, .session-search, .workspace-actions, .collaboration-task-board, .token-indicator').count(), 0);
      await page.getByRole('tab', { name: '流程图', exact: true }).waitFor();
      await page.screenshot({ path: resolve(shots, 'desktop-chat.png') });
      await page.setViewportSize({ width: 720, height: 900 });
      await page.getByRole('button', { name: '切换任务列表', exact: true }).click();
      assert.equal(await page.locator('.session-sidebar').isVisible(), true);
      await page.getByRole('button', { name: '切换任务列表', exact: true }).click();
      await page.getByRole('button', { name: '切换右侧信息', exact: true }).click();
      assert.equal(await page.locator('.agent-panel').isVisible(), true);
      await page.getByRole('button', { name: '切换右侧信息', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole('tab', { name: '流程图', exact: true }).click();
      try { await page.locator('.selected-flow .flow-node').first().waitFor(); }
      catch (error) {
        console.error(await page.locator('body').innerText(), errors);
        await page.screenshot({ path: resolve(shots, 'desktop-flow-failure.png') });
        throw error;
      }
      assert.equal(await page.locator('.workspace-context-panel .chat-timeline').isVisible(), true);
      await page.screenshot({ path: resolve(shots, 'desktop-workflow.png') });
      await page.locator('.selected-flow .flow-node').first().click();
      await page.locator('.workspace-context-panel').getByRole('heading', { name: '节点任务' }).waitFor();
      assert.equal(await page.locator('.workflow-manager').count(), 0);
      await page.goto(`${handle.origin}/workflows`);
      await page.waitForURL(/\/workspace/);
      assert.equal(await page.locator('.workflow-manager').count(), 0);
    }
    await page.goto(`${handle.origin}/workspace/${session.id}`);
    await page.locator('.session-list-item.active').waitFor();
    await page.getByText(session.originalInput, { exact: true }).last().waitFor();
    // Another client changes server data without delivering an SSE frame to this page.
    // Returning focus must refresh it even though its connection still says connected.
    session.status = 'COMPLETED';
    session.updatedAt = new Date().toISOString();
    const remoteMessage = `另一端已完成任务 ${client}`;
    events.push({ id: `remote-completion-${client}`, sessionId: session.id, type: 'agent_message',
      actor: { type: 'agent', id: 'fixture' }, content: remoteMessage, metadata: {}, createdAt: session.updatedAt });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    try { await page.getByText(remoteMessage, { exact: true }).waitFor(); }
    catch (error) {
      console.error({ client, reads: reads.slice(-30), errors, visibility: await page.evaluate(() => document.visibilityState), body: (await page.locator('body').innerText()).slice(-2200) });
      throw error;
    }
    await page.locator('.session-list-item.active .status-completed').waitFor();
    assert.equal(await page.locator('.task-activity').count(), 0, `${client}: completion clears activity`);
    session.status = 'EXECUTING';
    session.updatedAt = new Date().toISOString();
    events.push({ id: `remote-resume-${client}`, sessionId: session.id, type: 'runtime_progress',
      content: '另一端继续执行任务', metadata: { schemaVersion: '0.1', payload: {} }, createdAt: session.updatedAt });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('.session-list-item.active .status-running').waitFor();
    await page.locator('.task-activity.is-running').waitFor();
    if (client === 'desktop') await page.getByRole('tab', { name: /^群聊消息/ }).click();
    const composer = page.locator('.user-input-box');
    await composer.locator('textarea').fill('保留这条未发送的草稿');
    await composer.getByRole('button', { name: '停止当前会话', exact: true }).click();
    await pauseReceived;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('.task-activity').waitFor({ state: 'hidden' });
    assert.match(await composer.getByRole('button', { name: '停止当前会话', exact: true }).textContent(), /正在停止/);
    assert.equal(await composer.getByRole('button', { name: '停止当前会话', exact: true }).isDisabled(), true);
    assert.equal(await composer.getByRole('button', { name: '继续当前会话', exact: true }).count(), 0);
    acknowledgePause();
    try { await page.getByText('执行已停止', { exact: true }).waitFor(); }
    catch (error) {
      console.error({ client, reads: reads.slice(-30), errors, body: (await page.locator('body').innerText()).slice(-2200) });
      throw error;
    }
    const stopPanelBox = await page.locator('.chat-pane .runtime-stop-state').boundingBox();
    const stoppedComposerBox = await composer.boundingBox();
    assert.ok(stoppedComposerBox && Math.abs(stoppedComposerBox.height - inputHeight) <= 1,
      `${client}: stop state does not resize composer`);
    assert.ok(stopPanelBox && stopPanelBox.y >= 0 && stopPanelBox.y + stopPanelBox.height <= page.viewportSize().height,
      `${client}: stop summary stays inside the viewport (${JSON.stringify(stopPanelBox)})`);
    assert.ok(stoppedComposerBox && stopPanelBox.y + stopPanelBox.height <= stoppedComposerBox.y,
      `${client}: stop summary does not overlap the composer`);
    assert.equal(await page.locator('.chat-pane .runtime-stop-state').evaluate(el => el.scrollWidth <= el.clientWidth), true,
      `${client}: stop summary has no horizontal overflow`);
    assert.equal(await page.locator('.chat-pane .runtime-stop-state').evaluate(el => el.scrollHeight <= el.clientHeight), true,
      `${client}: stop summary content is not vertically clipped`);
    const stoppedTimelineBox = await page.locator('.chat-pane .chat-timeline').boundingBox();
    assert.ok(stoppedTimelineBox && stopPanelBox.y + stopPanelBox.height <= stoppedTimelineBox.y,
      `${client}: stop summary does not overlap the timeline`);
    assert.equal(await composer.locator('textarea').inputValue(), '保留这条未发送的草稿');
    assert.equal(await page.locator('.task-activity').count(), 0);
    await composer.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.equal(await composer.getByRole('button', { name: '继续当前会话', exact: true }).count(), 0);
    await composer.locator('textarea').fill('');
    await composer.getByRole('button', { name: '继续当前会话', exact: true }).waitFor();
    await page.screenshot({ path: resolve(shots, `${client}-chat-stopped.png`) });
    await page.setViewportSize({ width: 720, height: 900 });
    const mobileStopPanelBox = await page.locator('.chat-pane .runtime-stop-state').boundingBox();
    const mobileComposerBox = await composer.boundingBox();
    assert.ok(mobileComposerBox && Math.abs(mobileComposerBox.height - inputHeight) <= 1,
      `${client}: viewport resize does not resize composer`);
    assert.ok(mobileStopPanelBox && mobileStopPanelBox.y >= 0 &&
      mobileStopPanelBox.y + mobileStopPanelBox.height <= page.viewportSize().height,
      `${client}: mobile stop summary stays inside the viewport (${JSON.stringify(mobileStopPanelBox)})`);
    assert.ok(mobileComposerBox && mobileStopPanelBox.y + mobileStopPanelBox.height <= mobileComposerBox.y,
      `${client}: mobile stop summary does not overlap the composer`);
    assert.equal(await page.locator('.chat-pane .runtime-stop-state').evaluate(el => el.scrollWidth <= el.clientWidth), true,
      `${client}: mobile stop summary has no horizontal overflow`);
    assert.equal(await page.locator('.chat-pane .runtime-stop-state').evaluate(el => el.scrollHeight <= el.clientHeight), true,
      `${client}: mobile stop summary content is not vertically clipped`);
    const mobileTimelineBox = await page.locator('.chat-pane .chat-timeline').boundingBox();
    assert.ok(mobileTimelineBox && mobileStopPanelBox.y + mobileStopPanelBox.height <= mobileTimelineBox.y,
      `${client}: mobile stop summary does not overlap the timeline`);
    await page.screenshot({ path: resolve(shots, `${client}-chat-stopped-mobile.png`) });
    await page.setViewportSize({ width: 1440, height: 960 });
    await composer.getByRole('button', { name: '继续当前会话', exact: true }).click();
    await composer.getByRole('button', { name: '停止当前会话', exact: true }).waitFor();
    await page.screenshot({ path: resolve(shots, `${client}-chat-stop-control.png`) });
    // Exercise the shared scroll control against both independently built layouts.
    if (client === 'desktop') await page.getByRole('tab', { name: /^群聊消息/ }).click();
    for (let index = 0; index < 30; index++) events.push({
      id: `scroll-${client}-${index}`, sessionId: session.id, type: 'agent_message',
      actor: { type: 'agent', id: 'fixture' }, content: `滚动回归 ${client} ${index} — 需求开发验证返工的执行记录。`,
      metadata: {}, createdAt: new Date().toISOString()
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const timeline = page.locator('.chat-pane .chat-timeline');
    const control = page.locator('.chat-pane .chat-scroll-latest');
    await timeline.locator(`[data-message-id="msg-scroll-${client}-29"]`).waitFor();
    const populatedComposerBox = await composer.boundingBox();
    assert.ok(populatedComposerBox && Math.abs(populatedComposerBox.height - inputHeight) <= 1,
      `${client}: message growth does not resize composer`);
    await page.waitForFunction(() => {
      const el = document.querySelector('.chat-pane .chat-timeline');
      return el && el.scrollHeight > el.clientHeight && el.scrollHeight - el.clientHeight - el.scrollTop < 2;
    });
    await timeline.evaluate(el => { el.scrollTop -= 300; });
    await control.locator('.chat-scroll-dots').waitFor();
    const controlBox = await control.boundingBox();
    const timelineBox = await timeline.boundingBox();
    assert.ok(Math.abs(controlBox.x + controlBox.width / 2 - timelineBox.x - timelineBox.width / 2) < 2, `${client}: centered control`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await control.locator('i').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const readingTop = await timeline.evaluate(el => el.scrollTop);
    // Resize the same final message to model a stream/card expansion with no new ID.
    await timeline.locator('.timeline-item').last().evaluate(el => { el.style.minHeight = '900px'; });
    await page.screenshot({ path: resolve(shots, `${client}-scroll-running.png`) });
    assert.ok(Math.abs(await timeline.evaluate(el => el.scrollTop) - readingTop) < 2, `${client}: keep history position`);
    session.status = 'COMPLETED';
    session.updatedAt = new Date().toISOString();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await control.locator('.chat-scroll-arrow').waitFor();
    await page.screenshot({ path: resolve(shots, `${client}-scroll-completed.png`) });
    await control.click();
    await control.waitFor({ state: 'hidden' });
    await timeline.locator('.timeline-item').last().evaluate(el => { el.style.minHeight = '1200px'; });
    await page.waitForFunction(() => {
      const el = document.querySelector('.chat-pane .chat-timeline');
      return el && el.scrollHeight - el.clientHeight - el.scrollTop < 2;
    });
    if (client === 'desktop') {
      await page.getByRole('tab', { name: '流程图', exact: true }).click();
      const closeInspector = page.locator('.workspace-context-panel').getByRole('button', { name: '关闭', exact: true });
      if (await closeInspector.count()) await closeInspector.click();
      const side = page.locator('.workspace-context-panel .chat-timeline');
      await side.waitFor();
      await side.evaluate(el => { el.scrollTop = 0; });
      await page.locator('.workspace-context-panel .chat-scroll-arrow').waitFor();
      await page.locator('.workspace-context-panel .chat-scroll-latest').click();
      await page.locator('.workspace-context-panel .chat-scroll-latest').waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, [], `${client} page errors`);
    assert.equal(writes.length, 2, `${client}: only the explicit stop and resume may write`);
    assert.ok(writes[0].endsWith(`/sessions/${session.id}/pause`));
    assert.ok(writes[1].endsWith(`/sessions/${session.id}/resume`));
    await page.close();
    console.log(`${client}: navigation, records, workflow presentation, read-only routing passed`);
  }
  console.log(JSON.stringify({ result: 'pass', backend: 'isolated UI fixture', screenshots: shots }));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  // A browser teardown failure must not hide the assertion result or hang the run.
  let closeTimer;
  await Promise.race([
    browser?.close().catch(() => undefined),
    new Promise(resolve => { closeTimer = setTimeout(resolve, 5000); })
  ]);
  clearTimeout(closeTimer);
  let killTimer;
  const browserProcess = browserServer?.process();
  await Promise.race([
    browserServer?.kill().catch(() => undefined),
    new Promise(resolve => {
      killTimer = setTimeout(() => {
        browserProcess?.kill('SIGKILL');
        browserProcess?.unref();
        resolve();
      }, 5000);
    })
  ]);
  clearTimeout(killTimer);
  for (const server of servers) {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
