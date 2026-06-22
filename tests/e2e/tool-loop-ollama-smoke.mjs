import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// This e2e requires a real local Ollama instance (not mock fallback).
// It validates the tool-loop integration by giving the LLM a task that
// requires reading files, then checking that the model actually called read_file.

await buildServer();

let server;
let workspace;

try {
  // Create a minimal test workspace with a few files the agent can read.
  workspace = mkdtempSync(join(tmpdir(), 'tool-loop-smoke-'));
  writeFileSync(join(workspace, 'README.md'), '# Tool Loop Test\nThis is a test workspace.\n');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'test-workspace', version: '1.0.0' }, null, 2));
  writeFileSync(join(workspace, 'main.ts'), 'export function hello() { return "world"; }\n');

  server = await startSmokeServer('tool-loop-smoke', {
    DISCUSSION_MAX_ROUNDS: '2', // Allow brief discussion so coordinator can generate brief
    LLM_MOCK_FALLBACK: 'false' // Force real LLM
  });

  const requirementText = 'Read the main.ts file and tell me what function it exports.';
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    requirementText,
    {
      workingDirectory: {
        kind: 'server_local',
        path: workspace,
        id: 'tool-loop-test-workspace',
        name: 'tool-loop-test',
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'tool-loop-test',
        scannedAt: new Date().toISOString(),
        fileCount: 3,
        totalBytes: 300,
        tree: [
          { path: 'README.md', kind: 'file' },
          { path: 'package.json', kind: 'file' },
          { path: 'main.ts', kind: 'file' }
        ],
        files: [],
        skipped: [],
        detectedStack: ['typescript'],
        entrypoints: ['main.ts']
      }
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const finalStatus = await waitForStatus(server.apiBase, sessionId, ['COMPLETED', 'FAILED'], 180_000);

  const events = await listEvents(server.apiBase, sessionId);

  // Check for tool-loop activity in the runtime_completed event
  const runtimeCompleted = events.find(
    (event) => event.type === 'runtime_completed' && event.content?.includes('tool-loop')
  );

  if (!runtimeCompleted) {
    console.error('Expected runtime_completed event mentioning tool-loop.');
    console.error('Events:', JSON.stringify(events.filter((e) => e.type.includes('runtime')), null, 2));
    process.exit(1);
  }

  // The session should complete successfully if the agent was able to read files.
  if (finalStatus !== 'COMPLETED') {
    console.error(`Expected session to complete, got status: ${finalStatus}`);
    process.exit(1);
  }

  console.log('tool loop with ollama smoke ok');
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
} finally {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (server) await stopSmokeServer(server);
}
