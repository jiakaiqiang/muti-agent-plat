import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { launchDevLocalRuntime } from './dev-local-runtime.mjs';

test('real worker recovers missing credentials, survives backend outage and stale tokens, and reuses its lock', { timeout: 40_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-reconnect-'));
  const stateFile = join(dir, 'state.json');
  let worker;
  let token = 'initial';
  let recoveries = 0;
  let connections = 0;
  let unavailable = true;
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (unavailable) { res.writeHead(503).end('{}'); return; }
    if (req.url.endsWith('/resume')) {
      assert.equal(JSON.parse(raw).deviceId, 'saved-device');
      recoveries++;
      token = `recovered-${recoveries}`;
      res.end(JSON.stringify({ deviceId: 'saved-device', accessToken: token, refreshToken: token,
        accessTokenExpiresAt: '2099-01-01T00:00:00Z', refreshTokenExpiresAt: '2099-02-01T00:00:00Z' }));
    } else { res.writeHead(401).end('{}'); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (unavailable || req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.kind === 'local_runtime.hello') {
        connections++;
        ws.send(JSON.stringify({ kind: 'local_runtime.connected', payload: { deviceId: 'saved-device' } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile, NODE_ENV: 'development',
    LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true', AGENT_CLUSTER_DEV_AUTO_RUNTIME: 'true',
    AGENT_RUNTIME_CODEX_VERSION: 'fixture 1.0', AGENT_RUNTIME_CLAUDE_VERSION: 'fixture 1.0' };
  const waitFor = async predicate => {
    const deadline = Date.now() + 15_000;
    while (!predicate() && Date.now() < deadline) await delay(50);
    assert.ok(predicate(), 'worker failed to reconnect before deadline');
  };
  try {
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 2, deviceId: 'saved-device',
      displayName: 'original', serverUrl, workspaces: [] }));
    const pending = await launchDevLocalRuntime({ serverUrl, env, timeoutMs: 700,
      spawnProcess(...args) { worker = spawn(...args); return worker; } });
    assert.equal(pending.state, 'connecting');
    t.diagnostic('worker is retrying the unavailable backend');
    unavailable = false;
    await waitFor(() => connections === 1);
    assert.equal(recoveries, 1);
    t.diagnostic('missing credentials recovered and worker connected');
    const firstPid = JSON.parse(await readFile(stateFile + '.dev.lock', 'utf8')).pid;
    assert.equal((await launchDevLocalRuntime({ serverUrl, env })).state, 'existing');
    t.diagnostic('second launcher reused the existing worker');
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await delay(2_200);
    token = 'server-token-rotated';
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    await waitFor(() => connections >= 2);
    assert.equal(recoveries, 2);
    t.diagnostic('backend restart with stale credentials recovered');
    assert.equal(JSON.parse(await readFile(stateFile + '.dev.lock', 'utf8')).pid, firstPid);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).deviceId, 'saved-device');
  } finally {
    // Only the isolated fixture process is stopped; no user Runtime is involved.
    if (worker && worker.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-worker.pid, 'SIGTERM'); } catch {} }
    }
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
