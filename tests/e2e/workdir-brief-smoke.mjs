import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, buildServer, createSessionAndWaitForBrief, startSmokeServer, stopSmokeServer, waitForStatus } from './smoke-server.mjs';

await buildServer();
const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'fixtures', 'codex-appserver-stub.mjs');
let server;
let root;

async function findManifest(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findManifest(path);
      if (found) return found;
    } else if (entry.name === 'backup-manifest.json') return path;
  }
}

try {
  root = await mkdtemp(join(tmpdir(), 'agent-cluster-workdir-brief-'));
  const workspace = join(root, 'workspace');
  const staging = join(root, 'staging');
  await mkdir(workspace, { recursive: true });
  const original = '# Existing instructions\r\nkeep exactly\r\n';
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  server = await startSmokeServer('workdir-brief-smoke', {
    DISCUSSION_MAX_ROUNDS: '0', REQUIRE_USER_CONFIRMATION: 'false', CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: process.execPath, CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubPath]),
    CODEX_RUNTIME_SHELL: 'false', ENGINEERING_RUNTIME_STREAMING: 'codex', STUB_KIND: 'task_execution_result',
    AGENT_CLUSTER_BRIEF_STAGING_DIR: staging
  });
  await api(server.apiBase, '/agents/backend', { method: 'PATCH', body: JSON.stringify({ runtimeType: 'codex' }) });
  const { sessionId, briefId } = await createSessionAndWaitForBrief(server.apiBase, `Implement safely in ${workspace}`);
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);
  if ((await readFile(join(workspace, 'AGENTS.md'), 'utf8')) !== original) throw new Error('AGENTS.md was not restored exactly.');
  const manifestPath = await findManifest(staging);
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
  if (manifest?.status !== 'restored') throw new Error('Expected restored workdir brief manifest.');
  console.log('workdir brief smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  if (root) await rm(root, { recursive: true, force: true });
}
