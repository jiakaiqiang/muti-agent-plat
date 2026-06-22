import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { findFreePort, root, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

const npmCli = process.env.npm_execpath;

export function runNpm(args, env = {}) {
  if (!npmCli) {
    throw new Error('npm_execpath is required; run this script through npm.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env
      }
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm ${args.join(' ')} exited with ${code}`));
      }
    });
    child.on('error', reject);
  });
}

async function waitForWeb(url) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw lastError ?? new Error(`Web preview did not become ready: ${url}`);
}

export async function startWebPreview(apiBase, port) {
  const webBase = `http://127.0.0.1:${port}`;
  const env = {
    VITE_API_BASE_URL: apiBase,
    VITE_SSE_BASE_URL: apiBase
  };

  await runNpm(['run', 'build', '-w', '@project/web'], env);

  const preview = spawn(
    process.execPath,
    [npmCli, 'run', 'preview', '-w', '@project/web', '--', '--host', '127.0.0.1', '--port', port],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env
      }
    }
  );
  preview.stdout.on('data', (chunk) => process.stdout.write(chunk));
  preview.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForWeb(webBase);
  return { webBase, preview };
}

export async function stopWebPreview(handle) {
  if (handle.preview.pid && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(handle.preview.pid), '/T', '/F'], { stdio: 'ignore' });
  } else if (!handle.preview.killed) {
    handle.preview.kill();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    handle.preview.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startBrowserCollaborationSmoke(name, serverEnv = {}) {
  const webPort = await findFreePort();
  const server = await startSmokeServer(name, {
    AGENT_CLUSTER_RUNTIME: 'mock',
    RUNTIME_TYPE: 'mock',
    CORS_ORIGIN: `http://127.0.0.1:${webPort}`,
    ...serverEnv
  });
  const web = await startWebPreview(server.apiBase, webPort);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  return { browser, page, server, web };
}

export async function startBrowserSmokeServer(name, serverEnv = {}) {
  const webPort = await findFreePort();
  const server = await startSmokeServer(name, {
    AGENT_CLUSTER_RUNTIME: 'mock',
    RUNTIME_TYPE: 'mock',
    CORS_ORIGIN: `http://127.0.0.1:${webPort}`,
    ...serverEnv
  });
  return { server, webPort };
}

export async function startBrowserPage(apiBase, webPort) {
  const web = await startWebPreview(apiBase, webPort);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  return { browser, page, web };
}

export async function stopBrowserCollaborationSmoke(handle) {
  if (handle.browser) {
    await handle.browser.close();
  }
  if (handle.web) {
    await stopWebPreview(handle.web);
  }
  if (handle.server) {
    await stopSmokeServer(handle.server);
  }
}

export async function assertVisible(page, text, label) {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (!(await page.getByText(text).first().isVisible())) {
    throw new Error(`${label} must be visible`);
  }
}
