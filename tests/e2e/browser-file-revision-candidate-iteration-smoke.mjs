import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief
} from './smoke-server.mjs';
import {
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

await buildServer();

const workspaceRoot = mkdtempSync(join(tmpdir(), 'browser-file-revision-candidate-'));
const relativePath = 'docs/result.md';
const absolutePath = join(workspaceRoot, 'docs', 'result.md');
const outputRoot = join(process.cwd(), 'output', 'playwright');
const baselineMarker = 'W0_BASELINE_BROWSER_MARKER';
const firstCandidateMarker = 'U1_FIRST_CANDIDATE_BROWSER_MARKER';
const secondCandidateMarker = 'U2_SECOND_CANDIDATE_BROWSER_MARKER';
let handle;
let smokeError;

try {
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(absolutePath, `${baselineMarker}\n`, 'utf8');

  handle = await startBrowserSmokeServer('browser-file-revision-candidate-iteration', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const { server, webPort } = handle;
  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Process confirmed edits to ${relativePath}.`,
    {
      agentIds: ['coordinator', 'backend', 'architect'],
      workingDirectory: {
        kind: 'server_local',
        id: 'browser-file-revision-workspace',
        name: 'browser-file-revision-candidate-iteration',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );
  const agents = (await api(server.apiBase, '/agents')).data;
  const targetAgentIds = ['backend', 'architect'].map((key) => {
    const agent = agents.find((item) => item.key === key);
    if (!agent) throw new Error(`Expected default ${key} Agent.`);
    return agent.id;
  });

  const baseline = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/baselines`, {
    method: 'POST',
    body: JSON.stringify({ filePath: relativePath, source: 'user_selected' })
  })).data;
  writeFileSync(absolutePath, `${firstCandidateMarker}\n`, 'utf8');
  const first = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions`, {
    method: 'POST',
    body: JSON.stringify({
      baselineId: baseline.id,
      targetAgentIds,
      instruction: 'Preserve the complete current user draft.'
    })
  })).data;
  await waitForRevisionStatus(server.apiBase, sessionId, first.id, 'awaiting_confirmation');

  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await page.goto(`${web.webBase}/workspace/${sessionId}?view=chat`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('.revision-editor');
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.revision-editor__content').filter({ hasText: firstCandidateMarker }).waitFor({
    state: 'visible',
    timeout: 20_000
  });
  await assertCandidateOnly(editor, firstCandidateMarker, baselineMarker);
  await assertNoInternalRevisionProtocol(page);
  await assertNoOverlap(editor);
  await page.screenshot({
    path: join(outputRoot, 'file-revision-candidate-desktop.png'),
    fullPage: true
  });

  const actionButtons = editor.locator('.revision-editor__actions button');
  await actionButtons.nth(1).click();
  const textarea = editor.locator('textarea');
  await textarea.waitFor({ state: 'visible' });
  if (await textarea.evaluate((element) => element !== document.activeElement)) {
    throw new Error('Continue editing must move focus to the candidate textarea.');
  }
  await textarea.fill(`${secondCandidateMarker}\n`);
  await editor.locator('.revision-editor__actions button').nth(0).click();
  await waitForSavedDraft(server.apiBase, sessionId, first.id, secondCandidateMarker);
  await editor.locator('.revision-editor__actions button').nth(1).click();

  const second = await waitForChildRevision(server.apiBase, sessionId, first.id);
  const secondReady = await waitForRevisionStatus(
    server.apiBase,
    sessionId,
    second.id,
    'awaiting_confirmation'
  );
  await page.locator('.revision-editor__content').filter({ hasText: secondCandidateMarker }).waitFor({
    state: 'visible',
    timeout: 20_000
  });
  await assertCandidateOnly(editor, secondCandidateMarker, firstCandidateMarker);
  await assertNoInternalRevisionProtocol(page);
  if (readFileSync(absolutePath, 'utf8') !== `${firstCandidateMarker}\n`) {
    throw new Error('Workspace must remain unchanged before explicit candidate confirmation.');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !document.querySelector('.el-style-message'), undefined, {
    timeout: 5_000
  });
  await assertNoOverlap(editor);
  await page.screenshot({
    path: join(outputRoot, 'file-revision-candidate-mobile.png'),
    fullPage: true
  });

  await editor.locator('.revision-editor__actions button').nth(0).click();
  await waitForRevisionStatus(server.apiBase, sessionId, second.id, 'applied');
  if (readFileSync(absolutePath, 'utf8') !== `${secondCandidateMarker}\n`) {
    throw new Error('Only the explicitly confirmed latest candidate may be written to Workspace.');
  }
  if (secondReady.chain.latestRevisionId !== second.id || second.iteration !== 2) {
    throw new Error('The browser flow did not create the expected second linked revision.');
  }
  if (browserErrors.length > 0) {
    throw new Error(`Browser console errors: ${JSON.stringify(browserErrors)}`);
  }

  console.log('browser file revision candidate iteration smoke ok');
} catch (error) {
  smokeError = error;
} finally {
  if (handle) {
    try {
      await withTimeout(
        stopBrowserCollaborationSmoke(handle),
        20_000,
        'Browser smoke cleanup did not complete within 20 seconds.'
      );
    } catch (error) {
      smokeError ??= error;
    }
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
}

if (smokeError) {
  console.error(smokeError);
  process.exit(1);
}

// Windows can retain idle handles after Playwright and npm child processes have
// both closed. Cleanup above proves the owned process trees exited first.
process.exit(0);

async function waitForRevisionStatus(apiBase, sessionId, revisionId, expectedStatus, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const state = (await api(apiBase, `/sessions/${sessionId}/file-revisions`)).data;
    const run = state.runs.find((item) => item.id === revisionId);
    const chain = run ? state.chains.find((item) => item.id === run.chainId) : undefined;
    last = run;
    if (run?.status === expectedStatus && chain) return { run, chain };
    if (run?.status === 'failed' || run?.status === 'stale') {
      throw new Error(`File revision entered ${run.status}: ${JSON.stringify(run)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${revisionId} -> ${expectedStatus}: ${JSON.stringify(last)}`);
}

async function waitForChildRevision(apiBase, sessionId, parentRevisionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await api(apiBase, `/sessions/${sessionId}/file-revisions`)).data;
    const child = state.runs.find((item) => item.parentRevisionId === parentRevisionId);
    if (child) return child;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for child revision of ${parentRevisionId}.`);
}

async function waitForSavedDraft(apiBase, sessionId, revisionId, marker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const draft = (await api(
        apiBase,
        `/sessions/${sessionId}/file-revisions/${revisionId}/draft`
      )).data;
      if (draft?.content?.includes(marker)) return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('failed: 404')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for saved draft ${marker}.`);
}

async function assertCandidateOnly(editor, expectedMarker, forbiddenMarker) {
  const text = await editor.innerText();
  if (!text.includes(expectedMarker)) {
    throw new Error(`Candidate editor must display ${expectedMarker}.`);
  }
  if (text.includes(forbiddenMarker)) {
    throw new Error(`Candidate editor leaked prior content ${forbiddenMarker}.`);
  }
  if (await editor.locator('[class*="diff"], ins, del').count() > 0) {
    throw new Error('Candidate editor must not render a Diff view.');
  }
}

async function assertNoOverlap(editor) {
  const header = await editor.locator('.revision-editor__header').boundingBox();
  const content = await editor.locator('.revision-editor__content').boundingBox();
  const actions = await editor.locator('.revision-editor__actions').boundingBox();
  if (!header || !content || !actions) throw new Error('Candidate editor layout boxes are unavailable.');
  if (header.y + header.height > content.y + 1 || content.y + content.height > actions.y + 1) {
    throw new Error(`Candidate editor regions overlap: ${JSON.stringify({ header, content, actions })}`);
  }
  const viewport = editor.page().viewportSize();
  if (!viewport || actions.x < 0 || actions.x + actions.width > viewport.width + 1) {
    throw new Error(`Candidate editor actions overflow the viewport: ${JSON.stringify({ actions, viewport })}`);
  }
}

async function assertNoInternalRevisionProtocol(page) {
  const pageText = await page.locator('body').innerText();
  for (const forbidden of [
    baselineMarker,
    'deterministic diff',
    'changedArtifacts metadata.fileChanges',
    'task_execution_result containing one'
  ]) {
    if (pageText.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`Business UI leaked internal file revision protocol text: ${forbidden}`);
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
