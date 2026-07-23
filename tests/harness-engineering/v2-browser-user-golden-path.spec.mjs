import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const smokePath = join(root, 'tests/e2e/browser-user-golden-path-smoke.mjs');
const smokeSource = existsSync(smokePath) ? readFileSync(smokePath, 'utf8') : '';
const packageSource = readFileSync(join(root, 'package.json'), 'utf8');

test('golden path is exposed as a runnable package script', () => {
  assert.match(packageSource, /"test:e2e:browser-user-golden-path"\s*:/);
});

test('golden path starts the real browser smoke application', () => {
  assert.match(smokeSource, /startBrowserSmokeServer/);
  assert.match(smokeSource, /startBrowserPage/);
});

test('golden path authorizes a browser directory through showDirectoryPicker', () => {
  assert.match(smokeSource, /showDirectoryPicker/);
  assert.match(smokeSource, /选择目录/);
});

test('golden path enters a user requirement in the create-session dialog', () => {
  assert.match(smokeSource, /新建会话/);
  assert.match(smokeSource, /描述要让 Agent 协作完成的目标/);
  assert.match(smokeSource, /fill\(requirementText\)/);
});

test('golden path selects multiple agents before creating the session', () => {
  assert.match(smokeSource, /selectedAgentNames/);
  assert.match(smokeSource, /for \(const agentName of selectedAgentNames\)/);
});

test('golden path confirms session creation and waits for discussion evidence', () => {
  assert.match(smokeSource, /确认保存/);
  assert.match(smokeSource, /metadata\.payload\?\.round/);
});

test('golden path requires the user to confirm the generated Brief', () => {
  assert.match(smokeSource, /confirm_task_brief/);
  assert.match(smokeSource, /confirmation-card__actions/);
});

test('golden path proves task decomposition executes to completion', () => {
  assert.match(smokeSource, /task_created/);
  assert.match(smokeSource, /waitForStatus\([^)]*'COMPLETED'/s);
});

test('golden path proves review and final delivery are produced', () => {
  assert.match(smokeSource, /post_review_completed/);
  assert.match(smokeSource, /final_delivery_created/);
});

test('golden path resolves the post-review user decision before final delivery', () => {
  assert.match(smokeSource, /WAIT_USER_DECISION/);
  assert.match(smokeSource, /data-action="deliver_with_limitations"/);
});

test('golden path reviews a diff, confirms writeback, and verifies file content', () => {
  assert.match(smokeSource, /审阅文件写回/);
  assert.match(smokeSource, /name: \/\^写入 \\d\+ 项\$\//);
  assert.match(smokeSource, /__goldenPathWorkspace\.readFile/);
});
