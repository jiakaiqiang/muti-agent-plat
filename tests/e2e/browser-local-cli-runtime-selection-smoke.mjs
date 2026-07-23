import { buildServer } from './smoke-server.mjs';
import {
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

await buildServer();
let handle;

try {
  handle = await startBrowserSmokeServer('browser-local-cli-runtime-selection', {
    CODEX_RUNTIME_ENABLED: 'true',
    CLAUDE_CODE_ENABLED: 'true',
    PROJECT_POLICY_RUNTIME_TYPE: 'mock'
  });
  Object.assign(handle, await startBrowserPage(handle.server.apiBase, handle.webPort));
  const { page, web } = handle;
  await page.addInitScript(() => {
    class MemoryDirectoryHandle {
      kind = 'directory';
      name = 'browser-cli-workspace';

      async *entries() {}
      async *values() {}
      async queryPermission() { return 'granted'; }
      async requestPermission() { return 'granted'; }
    }
    window.showDirectoryPicker = async () => new MemoryDirectoryHandle();
  });
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建会话' }).click();
  const dialog = page.getByRole('region', { name: '新建会话' });
  const browserMode = dialog.getByRole('button', { name: '浏览器目录' });
  const runtime = dialog.getByLabel('Runtime 偏好');

  await dialog.getByRole('button', { name: '选择目录' }).click();
  await dialog.getByText('browser-cli-workspace', { exact: true }).waitFor({ state: 'visible' });
  await dialog.getByLabel('任务').fill('分析浏览器本地工作区');
  await dialog.locator('.dialog-agent-picker button').first().click();

  for (const runtimeType of ['codex', 'claude_code']) {
    await runtime.selectOption(runtimeType);
    if (await browserMode.isDisabled()) throw new Error(`${runtimeType} must keep browser-local selection enabled.`);
    if (!(await browserMode.evaluate((element) => element.classList.contains('selected')))) {
      throw new Error(`${runtimeType} unexpectedly switched away from the browser-local workspace.`);
    }
    await dialog.getByText('browser-cli-workspace', { exact: true }).waitFor({ state: 'visible' });
    if (await dialog.getByText('服务器本地工作目录', { exact: true }).isVisible()) {
      throw new Error(`${runtimeType} unexpectedly displayed the server-local path field.`);
    }
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const confirmation = page.getByRole('region', { name: '确认保存会话' });
    await confirmation.waitFor({ state: 'visible' });
    if (await dialog.getByText(`${runtimeType} Runtime 需要服务器本地工作区`, { exact: true }).isVisible()) {
      throw new Error(`${runtimeType} incorrectly rejected the browser-local workspace.`);
    }
    await confirmation.getByRole('button', { name: '取消' }).click();
  }

  await dialog.getByText('浏览器目录通过隔离镜像执行', { exact: false }).waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '新建会话' }).click();
  const reopened = page.getByRole('region', { name: '新建会话' });
  if (await reopened.getByText('browser-cli-workspace', { exact: true }).isVisible()) {
    throw new Error('Cancelling session creation must release the pending browser workspace.');
  }
  console.log('browser-local Codex/Claude runtime selection smoke ok');
} finally {
  if (handle) await stopBrowserCollaborationSmoke(handle);
}
