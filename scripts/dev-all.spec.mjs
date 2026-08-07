import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  devWebEnv,
  healthResponseIsUsable,
  healthWatchdogDecision,
  npmWorkspaceInvocation,
  parseEnvFile,
  runDevSupervisor
} from './dev-all.mjs';

test('health response rejects stale or pre-build-id backend processes', () => {
  assert.equal(healthResponseIsUsable({ data: { status: 'ok', buildId: 'build-1', runtimeBuildStale: false } }), true);
  assert.equal(healthResponseIsUsable({ data: { status: 'ok', buildId: 'build-1', runtimeBuildStale: true } }), false);
  assert.equal(healthResponseIsUsable({ data: { status: 'ok' } }), false);
});

test('parseEnvFile reads root development ports without overriding syntax noise', () => {
  assert.deepEqual(parseEnvFile('SERVER_PORT=8099\nWEB_PORT="8089"\n# ignored\nINVALID\n'), {
    SERVER_PORT: '8099',
    WEB_PORT: '8089'
  });
});

test('health watchdog allows startup grace and fails after a previously healthy backend disappears', () => {
  assert.equal(healthWatchdogDecision({ ready: false, consecutiveFailures: 3, elapsedMs: 10_000, healthy: false }).action, 'continue');
  assert.deepEqual(
    healthWatchdogDecision({ ready: false, consecutiveFailures: 3, elapsedMs: 10_000, healthy: true }),
    { ready: true, consecutiveFailures: 0, action: 'continue' }
  );
  assert.equal(
    healthWatchdogDecision({
      ready: true,
      consecutiveFailures: 7,
      elapsedMs: 30_000,
      healthy: false,
      readyFailureLimit: 8
    }).action,
    'fail_lost_health'
  );
});

test('health watchdog allows a 60 second manual backend rebuild after readiness', () => {
  assert.equal(
    healthWatchdogDecision({
      ready: true,
      consecutiveFailures: 7,
      elapsedMs: 30_000,
      healthy: false
    }).action,
    'continue'
  );
  assert.equal(
    healthWatchdogDecision({
      ready: true,
      consecutiveFailures: 29,
      elapsedMs: 60_000,
      healthy: false
    }).action,
    'fail_lost_health'
  );
});

test('health watchdog fails when initial readiness never succeeds', () => {
  assert.equal(
    healthWatchdogDecision({
      ready: false,
      consecutiveFailures: 20,
      elapsedMs: 120_000,
      healthy: false,
      initialTimeoutMs: 120_000
    }).action,
    'fail_initial_readiness'
  );
});

test('npm workspace invocation uses the current node executable and npm cli', () => {
  const invocation = npmWorkspaceInvocation('@project/web', ['--', '--strictPort'], 'C:/npm/npm-cli.js');
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['C:/npm/npm-cli.js', 'run', 'dev', '-w', '@project/web', '--', '--strictPort']);
});

test('local Web API traffic uses the Vite same-origin proxy', () => {
  assert.deepEqual(
    devWebEnv({ VITE_API_BASE_URL: 'http://127.0.0.1:8099/api' }, 'http://127.0.0.1:8099'),
    {
      VITE_API_BASE_URL: '/api',
      VITE_SSE_BASE_URL: '/api',
      AGENT_CLUSTER_DEV_API_PROXY_TARGET: 'http://127.0.0.1:8099'
    }
  );
});

test('explicit remote Web API traffic bypasses the local Vite proxy', () => {
  assert.deepEqual(
    devWebEnv({ VITE_API_BASE_URL: 'https://api.example.com/api' }, 'http://127.0.0.1:8099'),
    {}
  );
});

test('dev supervisor keeps only server and web resident and fails the group when one child exits', async () => {
  const children = [];
  const spawnOptions = [];
  const spawnArgs = [];
  const previousExitCode = process.exitCode;
  const run = runDevSupervisor({
    setProcessExitCode: false,
    npmExecPath: 'C:/npm/npm-cli.js',
    spawnProcess(_command, args, options) {
      const child = new EventEmitter();
      child.pid = undefined;
      child.exitCode = null;
      children.push(child);
      spawnOptions.push(options);
      spawnArgs.push(args);
      return child;
    },
    fetchHealth: async () => true
  });

  assert.equal(children.length, 2);
  assert.equal(spawnOptions[0].env.PUBLIC_WEB_URL, 'http://127.0.0.1:8089');
  assert.equal(spawnOptions[1].env.VITE_API_BASE_URL, '/api');
  assert.equal(spawnOptions[1].env.VITE_SSE_BASE_URL, '/api');
  assert.equal(spawnOptions[1].env.AGENT_CLUSTER_DEV_API_PROXY_TARGET, 'http://127.0.0.1:8099');
  assert.equal(spawnArgs.some((args) => args.includes('@agent-cluster/local-runtime-cli')), false);
  children[0].emit('exit', 1, null);
  assert.equal(await run, 1);
  process.exitCode = previousExitCode;
});

test('dev supervisor preserves an explicit public Web URL', async () => {
  const children = [];
  const spawnOptions = [];
  const spawnArgs = [];
  const previousExitCode = process.exitCode;
  const previousPublicWebUrl = process.env.PUBLIC_WEB_URL;
  process.env.PUBLIC_WEB_URL = 'https://agent.example.com';
  try {
    const run = runDevSupervisor({
      setProcessExitCode: false,
      npmExecPath: 'C:/npm/npm-cli.js',
      spawnProcess(_command, args, options) {
        const child = new EventEmitter();
        child.pid = undefined;
        child.exitCode = null;
        children.push(child);
        spawnOptions.push(options);
        spawnArgs.push(args);
        return child;
      },
      fetchHealth: async () => true
    });

    assert.equal(children.length, 2);
    assert.equal(spawnOptions[0].env.PUBLIC_WEB_URL, 'https://agent.example.com');
    assert.equal(spawnArgs.some((args) => args.includes('@agent-cluster/local-runtime-cli')), false);
    children[0].emit('exit', 1, null);
    assert.equal(await run, 1);
  } finally {
    if (previousPublicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = previousPublicWebUrl;
    process.exitCode = previousExitCode;
  }
});
