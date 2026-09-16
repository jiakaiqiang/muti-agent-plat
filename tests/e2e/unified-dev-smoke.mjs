import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { runDevSupervisor } from '../../scripts/dev-all.mjs';
import { launchDevDesktop } from '../../scripts/dev-desktop.mjs';
import { createSmokeV2State, findFreePort } from './smoke-server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'agent-cluster-unified-dev-'));
const serverPort = await findFreePort();
let webPort = await findFreePort();
while (webPort === serverPort) webPort = await findFreePort();
const dataFile = join(temp, 'state.json');
await writeFile(dataFile, JSON.stringify(createSmokeV2State()));
const overrides = {
  SERVER_PORT: serverPort, WEB_PORT: webPort, PUBLIC_WEB_URL: `http://127.0.0.1:${webPort}`,
  CORS_ORIGIN: `http://127.0.0.1:${webPort}`, VITE_API_BASE_URL: '/api', VITE_SSE_BASE_URL: '/api',
  AGENT_CLUSTER_PERSISTENCE: 'true', AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
  AGENT_CLUSTER_DATA_FILE: dataFile, AGENT_CLUSTER_DATA_DIR: temp,
  AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true', ENABLE_BULLMQ: 'false', QUEUE_PROVIDER: 'memory',
  LLM_DRY_RUN: 'true', LLM_MOCK_FALLBACK: 'true', MOCK_RUNTIME_ENABLED: 'true'
};
const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
Object.assign(process.env, overrides);
let app;
let desktopReady = false;
let supervisorResult;
let output = '';
const completed = runDevSupervisor({
  desktop: true, cleanupExisting: false, setProcessExitCode: false,
  spawnProcess(command, args, options) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return child;
  },
  async launchDesktop(input) {
    await launchDevDesktop({ ...input, spawnProcess(executablePath, args, options) {
      const child = new EventEmitter(); child.unref = () => {};
      electron.launch({ executablePath, args, cwd: options.cwd, env: options.env }).then(instance => {
        app = instance; child.emit('spawn');
      }, error => child.emit('error', error));
      return child;
    } });
    desktopReady = true;
  }
}).then(code => { supervisorResult = code; return code; });
try {
  const deadline = Date.now() + 150000;
  while (!desktopReady && supervisorResult === undefined && Date.now() < deadline) await delay(250);
  assert.equal(desktopReady, true, `unified startup failed (code=${supervisorResult})\n${output.slice(-8000)}`);
  const page = await app.firstWindow();
  await page.locator('.task-workspace').waitFor();
  assert.equal((await page.evaluate(() => window.agentClusterDesktop.status())).serverUrl, `http://127.0.0.1:${serverPort}`);
  const health = await (await fetch(`http://127.0.0.1:${webPort}/api/health`)).json();
  assert.equal(health.data.runtimeBuildStale, false);
  assert.equal(health.data.status, 'ok');
  const web = await (await fetch(`http://127.0.0.1:${webPort}/workspace`)).text();
  assert.match(web, /\/src\/main\.ts/);
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.dev, 'npm run desktop:build && node scripts/dev-all.mjs --desktop');
  assert.equal(packageJson.scripts['dev:all'], 'npm run dev');
  assert.equal(packageJson.scripts['dev:web'], 'node scripts/dev-all.mjs');
  console.log(JSON.stringify({ result: 'pass', backend: 'real Nest with isolated state, no model calls', serverPort, webPort,
    checks: ['real backend ready', 'Web Vite and API proxy', 'desktop window opens automatically', 'same local backend'] }));
} finally {
  await app?.close();
  if (supervisorResult === undefined) process.emit('SIGINT');
  await completed;
  await writeFile(join(temp, 'services.log'), output);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  console.log(`isolated startup log: ${join(temp, 'services.log')}`);
}
