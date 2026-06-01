import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const fakeCli = join(root, 'tests', 'e2e', 'fixtures', 'fake-coding-cli.mjs');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(String(address.port));
        } else {
          reject(new Error('Could not allocate a free port'));
        }
      });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
    child.on('error', reject);
  });
}

function runNpm(args) {
  if (!npmCli) {
    throw new Error('npm_execpath is required; run this script through npm.');
  }
  return run(process.execPath, [npmCli, ...args]);
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw lastError ?? new Error('Server did not become ready');
}

async function startServer(extraEnv) {
  const port = await findFreePort();
  const apiBase = `http://127.0.0.1:${port}/api`;
  const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVER_PORT: port,
      MOCK_RUNTIME_ENABLED: 'false',
      LLM_MOCK_FALLBACK: 'false',
      LLM_DRY_RUN: 'false',
      ...extraEnv
    }
  });
  let logs = '';
  server.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  server.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  try {
    await waitForServer(apiBase);
  } catch (error) {
    process.stderr.write(logs);
    throw error;
  }
  return {
    apiBase,
    async stop() {
      if (!server.killed) {
        server.kill();
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function smoke(apiBase, runtime) {
  const response = await fetch(`${apiBase}/runtimes/${runtime}/smoke`);
  if (!response.ok) {
    throw new Error(`${runtime} smoke HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).data;
}

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

// Scenario 1: runtime disabled -> visible structured failure, no crash.
{
  const dataFile = join(root, '.cache', 'agent-cluster', `v2-disabled-${Date.now()}.json`);
  const server = await startServer({ AGENT_CLUSTER_DATA_FILE: dataFile, CODEX_RUNTIME_ENABLED: 'false' });
  try {
    const result = await smoke(server.apiBase, 'codex');
    assert(result.status === 'failed', `disabled codex should fail, got ${result.status}`);
    assert(
      result.error?.code === 'CAPABILITY_BLOCKED',
      `disabled codex should report CAPABILITY_BLOCKED, got ${result.error?.code}`
    );
    console.log('scenario 1 ok: disabled runtime fails visibly');
  } finally {
    await server.stop();
    rmSync(dataFile, { force: true });
  }
}

// Scenario 2: enabled CLI + file_write tool -> completed with a deferred write *proposal* (no direct
// disk write). Real writes now require explicit user confirmation through the orchestrator, so a bare
// runtime smoke must surface proposedWrites and leave the workspace untouched.
{
  const dataFile = join(root, '.cache', 'agent-cluster', `v2-enabled-${Date.now()}.json`);
  const workspace = join(root, '.cache', `v2-ws-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  const server = await startServer({
    AGENT_CLUSTER_DATA_FILE: dataFile,
    CODEX_RUNTIME_ENABLED: 'true',
    CLAUDE_CODE_RUNTIME_ENABLED: 'true',
    CODEX_CLI_COMMAND: process.execPath,
    CODEX_CLI_ARGS: fakeCli,
    CLAUDE_CODE_CLI_COMMAND: process.execPath,
    CLAUDE_CODE_CLI_ARGS: fakeCli,
    ENABLE_HIGH_RISK_TOOLS: 'true',
    ALLOW_FILE_WRITE_RUNTIME: 'true',
    REQUIRE_USER_CONFIRMATION: 'false',
    AGENT_WORKSPACE_ROOT: workspace,
    FAKE_CLI_MODE: 'ok'
  });
  try {
    const codex = await smoke(server.apiBase, 'codex');
    assert(codex.status === 'completed', `enabled codex should complete, got ${codex.status} ${JSON.stringify(codex.error)}`);
    assert(codex.usage?.model === 'codex-fake', `codex usage should come from CLI, got ${codex.usage?.model}`);
    const proposal = (codex.proposedWrites ?? []).find((write) => write.path === 'codex-output.txt');
    assert(proposal, 'file_write should surface as a deferred write proposal');
    assert(
      proposal.content.includes('written by fake coding runtime'),
      'proposed write content mismatch'
    );
    const written = join(workspace, 'codex-output.txt');
    assert(!existsSync(written), 'runtime must NOT write to disk before user confirmation');

    const claude = await smoke(server.apiBase, 'claude-code');
    assert(claude.status === 'completed', `enabled claude_code should complete, got ${claude.status}`);
    console.log('scenario 2 ok: CLI file_write is deferred to a confirmation proposal, not written directly');
  } finally {
    await server.stop();
    rmSync(dataFile, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

// Scenario 3: hanging CLI + small timeout + no retry -> RUNTIME_TIMEOUT.
{
  const dataFile = join(root, '.cache', 'agent-cluster', `v2-timeout-${Date.now()}.json`);
  const server = await startServer({
    AGENT_CLUSTER_DATA_FILE: dataFile,
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_CLI_COMMAND: process.execPath,
    CODEX_CLI_ARGS: fakeCli,
    FAKE_CLI_MODE: 'hang',
    RUNTIME_TIMEOUT_MS: '1200',
    RUNTIME_MAX_RETRIES: '0'
  });
  try {
    const result = await smoke(server.apiBase, 'codex');
    assert(result.status === 'failed', `hanging codex should fail, got ${result.status}`);
    assert(result.error?.code === 'RUNTIME_TIMEOUT', `hanging codex should time out, got ${result.error?.code}`);
    console.log('scenario 3 ok: hanging CLI is bounded by RUNTIME_TIMEOUT');
  } finally {
    await server.stop();
    rmSync(dataFile, { force: true });
  }
}

console.log('v2 runtime smoke ok');
