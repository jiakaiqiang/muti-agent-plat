import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packageSource = readFileSync(join(root, 'package.json'), 'utf8');
const componentSource = readFileSync(join(root, 'apps/web/src/components/SessionWorkspace.vue'), 'utf8');
const sessionsControllerSource = readFileSync(join(root, 'apps/server/src/modules/sessions/sessions.controller.ts'), 'utf8');
const locationSmokeSource = readFileSync(join(root, 'tests/e2e/runtime-location-selection-smoke.mjs'), 'utf8');
const localRuntimeSmokeSource = readFileSync(join(root, 'tests/e2e/browser-local-runtime-cli-e2e.mjs'), 'utf8');
const serverRuntimeSmokeSource = readFileSync(join(root, 'tests/e2e/codex-runtime-stub-smoke.mjs'), 'utf8');
const contractsSource = readFileSync(join(root, 'packages/shared/src/contracts.ts'), 'utf8');

test('the runtime-location golden path is exposed as a runnable package script', () => {
  assert.match(packageSource, /"test:e2e:runtime-workspace-separation"\s*:/);
  assert.doesNotMatch(packageSource, /"test:e2e:browser-user-golden-path"\s*:/);
});

test('the browser UI exposes exactly local and server workspace modes', () => {
  assert.match(componentSource, /selectSessionWorkspaceKind\('local_bridge'\)/);
  assert.match(componentSource, /selectSessionWorkspaceKind\('server_local'\)/);
  assert.doesNotMatch(componentSource, /browser_local|browser_broker|showDirectoryPicker|workspace-file-apply-button/);
});

test('the location smoke verifies the local and server UI boundaries', () => {
  assert.match(locationSmokeSource, /getByRole\('button', \{ name: '本地', exact: true \}\)/);
  assert.match(locationSmokeSource, /getByRole\('button', \{ name: '服务器', exact: true \}\)/);
  assert.match(locationSmokeSource, /local-runtime-workspace-picker/);
  assert.match(locationSmokeSource, /服务器本地工作目录/);
});

test('the local golden path executes through the Local Runtime CLI', () => {
  assert.match(localRuntimeSmokeSource, /local-runtime-cli/);
  assert.match(localRuntimeSmokeSource, /executionLocation === 'local'/);
  assert.match(localRuntimeSmokeSource, /startBrowserSmokeServer/);
  assert.match(localRuntimeSmokeSource, /Local Runtime CLI -> ChangeSet -> local file E2E ok/);
});

test('the server golden path selects a server directory and executes through the worker', () => {
  assert.match(serverRuntimeSmokeSource, /getByRole\('button', \{ name: '服务器', exact: true \}\)/);
  assert.match(serverRuntimeSmokeSource, /getByLabel\('服务器本地工作目录'\)\.fill\(workspaceRoot\)/);
  assert.match(serverRuntimeSmokeSource, /Server Runtime Worker -> file changes smoke ok/);
});

test('local absolute paths are not persisted by the server', () => {
  assert.match(localRuntimeSmokeSource, /platform persistence file leaked the Local Runtime absolute workspace path/);
});

test('Session creation rejects client-provided workspace snapshots', () => {
  assert.doesNotMatch(sessionsControllerSource, /'workspaceSnapshot',/);
  assert.doesNotMatch(sessionsControllerSource, /workspaceSnapshot\?:/);
});

test('sending the first chat message opens the two-mode creation dialog', () => {
  assert.match(componentSource, /if \(!sessionStore\.currentSession\)[\s\S]*openCreateSessionDialog\(\)[\s\S]*newSessionInput\.value = content/);
  assert.doesNotMatch(componentSource, /if \(!sessionStore\.currentSession\)[\s\S]{0,300}createSession\(content, activeAgentIds\.value\)/);
});

test('shared workspace provider kinds contain only local_bridge and server_local', () => {
  assert.match(contractsSource, /WORKSPACE_PROVIDER_KINDS\s*=\s*\[\s*'server_local',\s*'local_bridge'\s*\]/);
  assert.doesNotMatch(contractsSource, /browser_local|browser_broker|browser_mirror/);
});
