import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-source-guard-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test-smoke.mjs' } }, null, 2));
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'original source\n');
  await writeFile(join(workspaceRoot, 'test-smoke.mjs'), "console.log('guard tests passed');\n");

  server = await startSmokeServer('server-local-source-write-guard-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mock' })
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Generate concrete source updates in ${workspaceRoot}`
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const events = await listEvents(server.apiBase, sessionId);
  const sourceFile = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  if (sourceFile !== 'original source\n') {
    throw new Error(`Mock runtime must not directly overwrite server-local source files. Got: ${sourceFile}`);
  }

  const sourceFileChange = events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.fileChanges ?? [])
    .find((change) => change.path === 'src/feature.txt' && change.operation === 'update');
  if (!sourceFileChange) {
    throw new Error('Expected mock runtime artifact to still expose proposed source fileChanges for chat diff display.');
  }

  await stat(join(workspaceRoot, 'agent-output', 'final-delivery.md'));

  console.log('server local source write guard smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
