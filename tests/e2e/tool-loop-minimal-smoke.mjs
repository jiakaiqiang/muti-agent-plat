// Minimal real-model tool-loop smoke using the current brief and workflow contracts.
// Uses a very simple requirement that should be easy for even small models.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

const workspace = mkdtempSync(join(tmpdir(), 'tool-loop-minimal-'));
writeFileSync(join(workspace, 'README.md'), '# Test Project\nThis is a test.\n');

let server;

try {
  server = await startSmokeServer('tool-loop-minimal', {
    DISCUSSION_MAX_ROUNDS: '3',
    LLM_MOCK_FALLBACK: 'false'
  });

  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Minimal tool loop workflow', ['backend']);

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Say hello in Chinese.',
    {
      workingDirectory: {
        kind: 'server_local',
        path: workspace,
        id: 'minimal-workspace',
        name: 'minimal',
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'minimal',
        scannedAt: new Date().toISOString(),
        fileCount: 1,
        totalBytes: 50,
        tree: [{ path: 'README.md', kind: 'file' }],
        files: [],
        skipped: [],
        detectedStack: [],
        entrypoints: ['README.md']
      }
    }
  );
  console.log('Session created:', sessionId);

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
  console.log('tool loop minimal smoke ok');
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
} finally {
  if (server) await stopSmokeServer(server);
  rmSync(workspace, { recursive: true, force: true });
}
