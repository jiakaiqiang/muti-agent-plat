import { createRequire } from 'node:module';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const require = createRequire(resolve('apps/web/package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const workspace = await mkdtemp(join(tmpdir(), 'test-authority-ui-'));
const evidencePrefix = process.env.INTENT_TEST_UI_EVIDENCE_PREFIX ?? 'test-authority-ui';
if (!/^[a-z0-9-]+$/.test(evidencePrefix)) throw new Error('Invalid evidence prefix');
await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
const backend = await startSmokeServer('intent-test-authority-ui', { GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
  INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch', INTENT_ISOLATED_TEST_IMAGE: `sha256:${'a'.repeat(64)}`,
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false' });
const created = (await api(backend.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: '解释隔离测试的含义。',
  workingDirectory: { kind: 'server_local', id: 'fixture', name: '测试授权验证工作区', path: workspace, selectedAt: new Date().toISOString() } }) })).data;
const session = created.session;
let stopped = false;
const server = await createServer({ configFile: false, envFile: false,
  root: resolve('tests/evaluation/intent-test-authority-ui'), plugins: [vue(), { name: 'test-authority-ui-fixture',
    configureServer(vite) { vite.middlewares.use('/fixture-session', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: session })); });
      vite.middlewares.use('/fixture-stop', (_req, res) => { res.end('stopping'); setTimeout(() => { void stop(); }, 50); }); } }],
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
  resolve: { alias: { '@': resolve('apps/web/src'), '@agent-cluster/shared': resolve('packages/shared/src/index.ts') } },
  server: { host: '127.0.0.1', port: await findFreePort(), strictPort: true, fs: { allow: [process.cwd()] },
    proxy: { '/api': { target: backend.apiBase.replace(/\/api$/, ''), changeOrigin: true } } }
});
async function stop() {
  if (stopped) return; stopped = true;
  const state = JSON.parse(await readFile(backend.dataFile, 'utf8'));
  await writeFile(resolve(`docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/${evidencePrefix}-browser-state.json`),
    JSON.stringify({ sessionId: session.id, authority: state.sessions.find(row => row.id === session.id).intentTestAuthority,
      events: state.eventsBySession[session.id].filter(event => event.type === 'intent_test_authority_changed'),
      testInvocations: (state.runtimeInvocationsBySession?.[session.id] ?? []).filter(row => row.runtimeType === 'test_runner') }, null, 2));
  await server.close(); await stopSmokeServer(backend);
  const child = relative(resolve(tmpdir()), resolve(workspace));
  if (!child.startsWith('test-authority-ui-') || child.includes('..') || isAbsolute(child)) throw new Error('Unexpected cleanup path');
  await rm(workspace, { recursive: true, force: true });
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
await server.listen();
console.log(`TEST_AUTHORITY_UI_URL=http://127.0.0.1:${server.config.server.port}`);
