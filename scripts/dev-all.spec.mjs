import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { devDesktopProfile } from './dev-desktop.mjs';
import {
  devWebEnv,
  defaultFetchHealth,
  healthResponseIsUsable,
  healthWatchdogDecision,
  livenessResponseIsUsable,
  normalizeHealthProbe,
  cleanupExistingDevServices,
  parseNetstatListeningPids,
  listeningPidsForPort,
  npmWorkspaceInvocation,
  parseEnvFile,
  runDevSupervisor
} from './dev-all.mjs';

test('health response rejects stale or pre-build-id backend processes', () => {
  assert.equal(healthResponseIsUsable({ data: { status: 'ok', buildId: 'build-1', runtimeBuildStale: false } }), true);
  assert.equal(healthResponseIsUsable({ data: { status: 'ok', buildId: 'build-1', runtimeBuildStale: true } }), false);
  assert.equal(healthResponseIsUsable({ data: { status: 'ok' } }), false);
});

test('liveness response checks only the running server process contract', () => {
  assert.equal(livenessResponseIsUsable({ data: { status: 'ok', service: 'agent-cluster-server', processId: 42 } }), true);
  assert.equal(livenessResponseIsUsable({ data: { status: 'ok', service: 'agent-cluster-server' } }), false);
  assert.equal(normalizeHealthProbe(false).reason, 'probe returned false');
});

test('health probe preserves HTTP failure diagnostics', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    const result = await defaultFetchHealth('http://127.0.0.1:8099/api/live', { kind: 'liveness' });
    assert.equal(result.healthy, false);
    assert.equal(result.reason, 'HTTP 503');
    assert.ok(result.durationMs >= 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('netstat parser finds only listeners for the requested port', () => {
  const output = [
    '  TCP    0.0.0.0:8099       0.0.0.0:0       LISTENING       1234',
    '  TCP    0.0.0.0:8089       0.0.0.0:0       LISTENING       5678',
    '  TCP    [::]:8099          [::]:0          LISTENING       1234'
  ].join('\n');
  assert.deepEqual(parseNetstatListeningPids(output, 8099), [1234]);
});

test('startup cleanup stops the old launcher and listeners once per PID', () => {
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, args]);
    if (command === 'netstat.exe') {
      return { stdout: 'TCP 0.0.0.0:8099 0.0.0.0:0 LISTENING 1234\n' };
    }
    return { stdout: '' };
  };
  const stopped = cleanupExistingDevServices({
    ports: [8099, 8089],
    lockPath: 'dev-server.lock',
    platform: 'win32',
    runCommand,
    readLock: () => ({ pid: 1234 })
  });
  assert.deepEqual(stopped, [1234]);
  assert.equal(commands.filter(([command]) => command === 'taskkill.exe').length, 1);
});

test('port lookup ignores invalid ports', () => {
  assert.deepEqual(listeningPidsForPort('not-a-port', { platform: 'win32' }), []);
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

test('desktop dev profile is local and separated by backend port', () => {
  assert.notEqual(devDesktopProfile('http://127.0.0.1:8099'), devDesktopProfile('http://127.0.0.1:9099'));
  assert.match(devDesktopProfile('http://127.0.0.1:8099'), /desktop-dev-8099$/);
  for (const url of ['https://example.com', 'http://127.0.0.1:8099/api', 'http://user:pass@127.0.0.1:8099']) {
    assert.throws(() => devDesktopProfile(url));
  }
});

test('unified dev opens desktop once after readiness, not during startup or health recovery', async () => {
  const children = [];
  const launches = [];
  const runtimeLaunches = [];
  let healthy = false;
  const run = runDevSupervisor({
    desktop: true, localRuntime: true, cleanupExisting: false, setProcessExitCode: false,
    healthIntervalMs: 5, npmExecPath: 'C:/npm/npm-cli.js',
    spawnProcess() {
      const child = new EventEmitter(); child.exitCode = null; children.push(child); return child;
    },
    fetchHealth: async () => healthy,
    launchDesktop: async input => { launches.push(input); },
    launchRuntime: async input => { runtimeLaunches.push(input); return { state: 'connected' }; }
  });
  try {
    await delay(25);
    assert.equal(launches.length, 0);
    assert.equal(runtimeLaunches.length, 0);
    healthy = true; await delay(25);
    assert.equal(launches.length, 1);
    assert.equal(runtimeLaunches.length, 1);
    assert.equal(runtimeLaunches[0].serverUrl, 'http://127.0.0.1:8099');
    assert.equal(launches[0].serverUrl, 'http://127.0.0.1:8099');
    healthy = false; await delay(15);
    healthy = true; await delay(15);
    assert.equal(launches.length, 1);
    assert.equal(runtimeLaunches.length, 1);
    assert.equal(children.length, 2, 'desktop must not join force-killed service process group');
  } finally { children[0].emit('exit', 1, null); await run; }
});

test('runtime startup failure is retried and the resident worker is checked again', async () => {
  const children = [];
  let calls = 0;
  let active = 0;
  const run = runDevSupervisor({
    localRuntime: true, cleanupExisting: false, setProcessExitCode: false,
    healthIntervalMs: 5, runtimeCheckIntervalMs: 5, npmExecPath: 'C:/npm/npm-cli.js',
    spawnProcess() { const child = new EventEmitter(); children.push(child); return child; },
    fetchHealth: async () => true,
    launchRuntime: async () => {
      assert.equal(active++, 0, 'startup attempts must not overlap');
      const attempt = ++calls;
      await delay(15);
      active--;
      if (attempt === 1) throw new Error('temporary startup failure');
      return { state: 'existing' };
    }
  });
  try {
    for (let i = 0; i < 100 && calls < 3; i++) await delay(5);
    assert.ok(calls >= 3);
  } finally { children[0].emit('exit', 1, null); await run; }
});

test('desktop launch failure fails unified startup with a nonzero result', async () => {
  const children = [];
  const run = runDevSupervisor({
    desktop: true, cleanupExisting: false, setProcessExitCode: false,
    healthIntervalMs: 5, npmExecPath: 'C:/npm/npm-cli.js',
    spawnProcess() {
      const child = new EventEmitter(); child.exitCode = null; children.push(child); return child;
    },
    fetchHealth: async () => true,
    launchDesktop: async () => { throw new Error('Electron missing'); }
  });
  try { await delay(25); assert.equal(await run, 1); }
  finally { children[0].emit('exit', 1, null); }
});

test('late readiness cannot open desktop after services have stopped', async () => {
  const children = [];
  let resolveProbe;
  let launches = 0;
  const run = runDevSupervisor({
    desktop: true, cleanupExisting: false, setProcessExitCode: false,
    healthIntervalMs: 5, npmExecPath: 'C:/npm/npm-cli.js',
    spawnProcess() { const child = new EventEmitter(); children.push(child); return child; },
    fetchHealth: () => new Promise(resolve => { resolveProbe = resolve; }),
    launchDesktop: async () => { launches++; }
  });
  await delay(8);
  children[0].emit('exit', 1, null);
  assert.equal(await run, 1);
  resolveProbe?.(true); await delay(10);
  assert.equal(launches, 0);
});

test('dev supervisor keeps only server and web resident and fails the group when one child exits', async () => {
  const children = [];
  const spawnOptions = [];
  const spawnArgs = [];
  const previousExitCode = process.exitCode;
  const run = runDevSupervisor({
    setProcessExitCode: false,
    cleanupExisting: false,
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
      cleanupExisting: false,
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
