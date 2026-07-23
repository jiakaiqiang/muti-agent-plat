import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const serverEntry = resolve(root, 'apps/server/dist/apps/server/src/main.js');
const cutoverCommand = resolve(root, 'scripts/cutover-context-v2.mjs');
const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-v2-startup-'));
const dataFile = join(directory, 'state.json');
const archiveDirectory = `${directory}-archive`;
const tokenSecret = 'startup-e2e-secret-with-entropy';
let server: ChildProcessWithoutNullStreams | undefined;
let apiBase = '';
let serverOutput = '';
let expectedEpoch = '';
let createdSessionId = '';

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port')));
    });
  });
}

function serverEnv(filePath: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SERVER_PORT: String(port),
    AGENT_CLUSTER_PERSISTENCE: 'true',
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_DATA_DIR: directory,
    AGENT_CLUSTER_DATA_FILE: filePath,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    AGENT_CLUSTER_RECOVER_ON_BOOT: 'false',
    ENABLE_BULLMQ: 'false',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    MOCK_RUNTIME_ENABLED: 'true',
    LLM_DRY_RUN: 'true',
    LLM_MOCK_FALLBACK: 'true'
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 8_000) {
  return new Promise<{ code: number | null; output: string }>((resolveExit, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not exit; output=${output}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit({ code, output });
    });
  });
}

async function start(filePath = dataFile) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: serverEnv(filePath, port),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  const base = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${serverOutput}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { child, base };
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  child.kill();
  throw new Error(`server did not become ready: ${serverOutput}`);
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill();
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(resolveStop, 3_000);
    child.once('exit', () => { clearTimeout(timeout); resolveStop(); });
  });
  server = undefined;
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<{ data: any }>;
}

before(async () => {
  writeFileSync(dataFile, `${JSON.stringify({ sessions: [{ id: 'old-session' }] })}\n`, 'utf8');
  const dryRun = spawnSync(process.execPath, [cutoverCommand, '--dry-run'], {
    cwd: root,
    env: {
      ...serverEnv(dataFile, 0),
      AGENT_CLUSTER_CUTOVER_ENVIRONMENT: 'startup-e2e',
      AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: tokenSecret,
      AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: archiveDirectory,
      AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'startup-e2e-archive-key-with-entropy',
      AGENT_CLUSTER_CUTOVER_OPERATOR: 'startup-e2e-operator',
      AGENT_CLUSTER_CUTOVER_QUIESCED: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const token = JSON.parse(dryRun.stdout.trim()).confirmToken as string;
  const apply = spawnSync(process.execPath, [cutoverCommand, '--apply', '--confirm', token], {
    cwd: root,
    env: {
      ...serverEnv(dataFile, 0),
      AGENT_CLUSTER_MAINTENANCE_MODE: 'true',
      AGENT_CLUSTER_CUTOVER_ENVIRONMENT: 'startup-e2e',
      AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: tokenSecret,
      AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: archiveDirectory,
      AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'startup-e2e-archive-key-with-entropy',
      AGENT_CLUSTER_CUTOVER_OPERATOR: 'startup-e2e-operator',
      AGENT_CLUSTER_CUTOVER_QUIESCED: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(apply.status, 0, apply.stderr);
  expectedEpoch = JSON.parse(apply.stdout.trim()).metadata.dataEpoch;
  const started = await start();
  server = started.child;
  apiBase = started.base;
});

after(async () => {
  await stop();
  rmSync(directory, { recursive: true, force: true });
  rmSync(archiveDirectory, { recursive: true, force: true });
});

test('server rejects legacy state without SystemDataMetadata', async () => {
  const legacyFile = join(directory, 'legacy.json');
  writeFileSync(legacyFile, JSON.stringify({ sessions: [] }), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], { cwd: root, env: serverEnv(legacyFile, port), stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await waitForExit(child);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /CUTOVER_REQUIRED/);
});

test('server rejects metadata with a non-v2 schema', async () => {
  const wrongFile = join(directory, 'wrong.json');
  writeFileSync(wrongFile, JSON.stringify({ systemDataMetadata: { dataSchemaVersion: 1, pipelineVersion: 'v1' } }), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], { cwd: root, env: serverEnv(wrongFile, port), stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await waitForExit(child);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /CUTOVER_REQUIRED/);
});

test('server starts from an isolated CLI-cutover v2 state', async () => {
  const response = await api('/health');
  assert.equal(response.data.status, 'ok');
});

test('Health reports data schema v3 and pipeline v2', async () => {
  const response = await api('/health');
  assert.equal(response.data.dataSchemaVersion, 3);
  assert.equal(response.data.pipelineVersion, 'v2');
});

test('Health dataEpoch matches cutover output', async () => {
  const response = await api('/health');
  assert.equal(response.data.dataEpoch, expectedEpoch);
});

test('freshly started v2 server is not in maintenance mode', async () => {
  const response = await api('/ops/maintenance');
  assert.deepEqual(response.data, { active: false, state: null });
});

test('new Session is stamped and persisted with the current dataEpoch', async () => {
  const response = await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: 'Verify v2 startup epoch persistence' })
  });
  assert.equal(response.data.session.dataEpoch, expectedEpoch);
  createdSessionId = response.data.session.id;
  const state = JSON.parse(readFileSync(dataFile, 'utf8')) as { sessions: Array<{ id: string; dataEpoch: string }> };
  assert.equal(state.sessions.find((session) => session.id === createdSessionId)?.dataEpoch, expectedEpoch);
});

test('server restart preserves the same epoch and current v2 Session', async () => {
  await stop();
  const restarted = await start();
  server = restarted.child;
  apiBase = restarted.base;
  const health = await api('/health');
  const sessions = await api('/sessions');
  assert.equal(health.data.dataEpoch, expectedEpoch);
  assert.equal(sessions.data.items.some((session: { id: string }) => session.id === createdSessionId), true);
});
