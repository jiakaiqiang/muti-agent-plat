import { buildServer } from './smoke-server.mjs';
import {
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

const adminToken = 'runtime-location-selection-administrator-token-2026';

await buildServer();
let handle;

try {
  handle = await startBrowserSmokeServer('runtime-location-selection', {
    LOCAL_RUNTIME_ADMIN_TOKEN: adminToken,
    PROJECT_POLICY_RUNTIME_TYPE: 'mock'
  });
  Object.assign(handle, await startBrowserPage(handle.server.apiBase, handle.webPort));
  const { page, web } = handle;
  await page.addInitScript((token) => {
    sessionStorage.setItem('agent-cluster.local-runtime-admin-token', token);
  }, adminToken);
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建会话' }).click();

  const dialog = page.getByRole('region', { name: '新建会话' });
  const localMode = dialog.getByRole('button', { name: '本地', exact: true });
  const serverMode = dialog.getByRole('button', { name: '服务器', exact: true });

  if (await localMode.count() !== 1 || await serverMode.count() !== 1) {
    throw new Error('Session creation must expose exactly one local mode and one server mode.');
  }
  if (await dialog.getByRole('button', { name: '浏览器兼容', exact: true }).count() !== 0) {
    throw new Error('The retired browser compatibility mode is still visible.');
  }
  if (!(await localMode.evaluate((element) => element.classList.contains('selected')))) {
    throw new Error('Local mode must be the default Session workspace mode.');
  }
  const localWorkspaceSelect = dialog.locator('.local-runtime-workspace-picker select');
  if (!(await localWorkspaceSelect.isVisible())) {
    throw new Error('Local mode must select a workspace registered by Local Runtime CLI.');
  }

  await serverMode.click();
  if (!(await dialog.getByLabel('服务器本地工作目录').isVisible())) {
    throw new Error('Server mode must expose the server workspace path field.');
  }
  if (await localWorkspaceSelect.isVisible()) {
    throw new Error('Server mode must not expose Local Runtime workspaces.');
  }
  await dialog.getByText('本地模式由 Local Runtime CLI 在授权目录内执行；服务器模式在服务器 Runtime 中执行，Codex/Claude Code 使用独立 Worker。').waitFor({
    state: 'visible'
  });

  console.log('local/server Runtime location selection smoke ok');
} finally {
  if (handle) await stopBrowserCollaborationSmoke(handle);
}

process.exit(0);
