import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { launchDevDesktop, devDesktopProfile } from '../../scripts/dev-desktop.mjs';

const fixture = createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  let data = [];
  if (path === '/api/health') data = { status: 'ok', pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, buildId: 'unified-start-fixture' };
  if (path === '/api/sessions' || path === '/api/workflows/catalog/published') data = { items: [], hasMore: false };
  if (path === '/api/runtimes/availability') data = { items: [] };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data, requestId: 'unified-start-fixture' }));
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const serverUrl = `http://127.0.0.1:${fixture.address().port}`;
let app;
let rawChild;
let unreferenced = false;
try {
  // Exercise the launcher config/env/arguments with a real Electron process.
  // Playwright owns process teardown; the production launcher uses detached spawn.
  await launchDevDesktop({
    serverUrl, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    spawnProcess(executablePath, args, options) {
      assert.equal(options.detached, true);
      assert.equal(options.windowsHide, false);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      const child = new EventEmitter();
      child.unref = () => { unreferenced = true; };
      electron.launch({ executablePath, args, cwd: options.cwd, env: options.env }).then(instance => {
        app = instance; child.emit('spawn');
      }, error => child.emit('error', error));
      return child;
    }
  });
  assert.equal(unreferenced, true);
  const page = await app.firstWindow();
  await page.waitForURL('agent-cluster://app/workspace');
  await page.locator('.task-workspace').waitFor();
  const status = await page.evaluate(() => window.agentClusterDesktop.status());
  assert.equal(status.serverUrl, serverUrl);
  assert.equal(status.packaged, false);
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), devDesktopProfile(serverUrl));
  const config = JSON.parse(await readFile(resolve(devDesktopProfile(serverUrl), 'desktop-config.json'), 'utf8'));
  assert.equal(config.serverUrl, serverUrl);
  const second = await launchDevDesktop({ serverUrl });
  const code = second.exitCode ?? (await once(second, 'exit'))[0];
  assert.equal(code, 0, 'second launch should reuse the existing desktop instance');
  assert.equal(app.windows().length, 1);
  await app.close(); app = undefined;
  // No Playwright process adapter: verify the actual detached Windows launch flags
  // by requiring the main process's visible-window receipt.
  await launchDevDesktop({ serverUrl, spawnProcess(command, args, options) {
    rawChild = spawn(command, args, options); return rawChild;
  } });
  assert.equal(rawChild.exitCode, null);
  console.log(JSON.stringify({ result: 'pass', backend: 'isolated fixture', checks: ['desktop opens workspace', 'automatic local platform', 'isolated dev profile', 'Electron env cleaned', 'single-instance reuse', 'raw detached spawn confirms visible window'] }));
} finally {
  await app?.close();
  // This exact fixture-owned process never starts a helper or any task.
  if (rawChild?.pid && rawChild.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(rawChild.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else rawChild.kill('SIGTERM');
  }
  fixture.closeAllConnections();
  await new Promise(resolveClosed => fixture.close(resolveClosed));
}
