import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

const supplementMarker = 'SUPPLEMENT_MARKER_BLUE_4821';
const firstExecutionMarker = '.first-codex-execution-started';

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

await buildServer();

let server;
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-supplement-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ scripts: { test: 'node test-smoke.mjs' } }, null, 2)
  );
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'before supplement\n');
  await writeFile(
    join(workspaceRoot, 'test-smoke.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const content = readFileSync('src/feature.txt', 'utf8');",
      `if (!content.includes('${supplementMarker}')) throw new Error('supplement marker missing from feature file');`,
      "console.log('codex supplement context tests passed');"
    ].join('\n')
  );

  const stubScript = join(workspaceRoot, 'codex-supplement-stub.mjs');
  await writeFile(
    stubScript,
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const prompt = process.env.AGENT_CLUSTER_PROMPT_FILE ? readFileSync(process.env.AGENT_CLUSTER_PROMPT_FILE, 'utf8') : (process.argv.at(-1) ?? '');",
      "const requiredKind = process.env.AGENT_CLUSTER_EXPECTED_OUTPUT_KIND ?? 'task_execution_result';",
      "if (requiredKind === 'task_claim_decision') {",
      '  console.log(JSON.stringify({',
      "    kind: 'task_claim_decision',",
      '    accepted: true,',
      "    reason: 'Backend Codex accepts the active task and can absorb user supplements.',",
      '    confidence: 0.95',
      '  }));',
      '} else {',
      `  const firstExecutionMarker = '${firstExecutionMarker}';`,
      '  if (!existsSync(firstExecutionMarker)) {',
      "    writeFileSync(firstExecutionMarker, 'started before user supplement\\n');",
      '    await delay(8000);',
      '    console.log(JSON.stringify({',
      "      kind: 'task_execution_result',",
      "      status: 'completed',",
      "      summary: 'This first execution should be cancelled before completion.',",
      '      completedItems: [],',
      '      changedArtifacts: [],',
      '      nextSuggestedActions: [],',
      "      risks: ['first execution was not cancelled']",
      '    }));',
      '  } else {',
      `    const hasSupplement = prompt.includes('${supplementMarker}');`,
      "    const hasRelevantMemory = prompt.includes('relevantMemories') && hasSupplement;",
      "    mkdirSync('src', { recursive: true });",
      "    writeFileSync('src/feature.txt', `after supplement ${hasRelevantMemory ? 'from relevant memory' : 'missing relevant memory'} ${prompt.includes('user_message_routing') ? 'with routing event' : 'without routing event'} ${prompt.includes('SUPPLEMENT_MARKER_BLUE_4821') ? 'SUPPLEMENT_MARKER_BLUE_4821' : 'NO_SUPPLEMENT'}\\n`);",
      "    writeFileSync('src/context-proof.json', JSON.stringify({ hasSupplement, hasRelevantMemory }, null, 2));",
      '    console.log(JSON.stringify({',
      "      kind: 'task_execution_result',",
      "      status: hasRelevantMemory ? 'completed' : 'failed',",
      "      summary: hasRelevantMemory ? 'Codex restarted with supplemental requirement memory and edited real files.' : 'Codex prompt missed supplemental memory.',",
      "      completedItems: hasRelevantMemory ? ['Supplemental requirement was present in relevantMemories', 'Real source file updated after restart'] : [],",
      '      changedArtifacts: [],',
      "      agentMessages: [{ kind: 'agent_message', messageKind: 'progress', content: 'Backend absorbed the user supplement after reschedule and updated the source diff.', targetAgentKeys: ['coordinator', 'review'] }],",
      "      nextSuggestedActions: ['Inspect actual filesystem diff and test report'],",
      "      risks: hasRelevantMemory ? [] : ['supplement context was not injected']",
      '    }));',
      '  }',
      '}'
    ].join('\n')
  );

  server = await startSmokeServer('codex-executing-supplement-context-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: 'node',
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubScript]),
    CODEX_RUNTIME_PROMPT_MODE: 'file',
    CODEX_RUNTIME_SHELL: 'false',
    CODEX_RUNTIME_TEST_COMMAND: 'npm test',
    CODEX_RUNTIME_TIMEOUT_MS: '30000'
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'codex' })
  });
  await api(server.apiBase, '/agents/test', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mock' })
  });
  await api(server.apiBase, '/agents/review', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mock' })
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use the backend Codex agent to update source files in ${workspaceRoot}; keep the active task restartable.`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: '00000000-0000-0000-0000-00000000c0df',
        name: 'codex-supplement-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      }
    }
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const firstCodexStart = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_started',
    (event) => event.metadata.payload?.runtimeType === 'codex',
    20_000
  );
  const activeTaskId = firstCodexStart.taskId;
  if (!activeTaskId) {
    throw new Error('Expected Codex runtime start to identify the active task.');
  }
  await waitForFile(join(workspaceRoot, firstExecutionMarker));
  const beforeSupplement = await api(server.apiBase, `/sessions/${sessionId}`);
  if (beforeSupplement.data.status !== 'EXECUTING') {
    const events = await listEvents(server.apiBase, sessionId);
    throw new Error(
      `Expected session to still be EXECUTING before supplement, got ${beforeSupplement.data.status}.\nEvents: ${JSON.stringify(
        events.map((event) => ({
          type: event.type,
          taskId: event.taskId,
          content: event.content,
          payload: event.metadata.payload
        })),
        null,
        2
      )}`
    );
  }

  await api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: `While executing, inject this backend-only supplemental requirement: ${supplementMarker}.`,
      mentionedAgentIds: ['backend']
    })
  });

  try {
    await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'session_status_changed',
      (event) =>
        event.metadata.payload?.reason === 'executing_user_interrupt_rescheduled' &&
        (event.metadata.payload?.affectedTaskIds ?? []).includes(activeTaskId),
      20_000
    );
  } catch (error) {
    const events = await listEvents(server.apiBase, sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nEvents: ${JSON.stringify(
        events.map((event) => ({
          type: event.type,
          taskId: event.taskId,
          content: event.content,
          payload: event.metadata.payload
        })),
        null,
        2
      )}`
    );
  }
  await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_failed',
    (event) => event.taskId === activeTaskId && event.metadata.payload?.code === 'RUNTIME_CANCELLED',
    20_000
  );
  await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'memory_used',
    (event) =>
      event.taskId === activeTaskId &&
      (event.metadata.payload?.memories ?? []).some((memory) => memory.content?.includes(supplementMarker)),
    20_000
  );
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  const events = await listEvents(server.apiBase, sessionId);
  const startsForActiveTask = events.filter((event) => event.type === 'task_started' && event.taskId === activeTaskId);
  if (startsForActiveTask.length < 2) {
    throw new Error(`Expected the interrupted Codex task to restart, got ${startsForActiveTask.length} starts.`);
  }

  const routed = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'user_message_routing' &&
      event.content.includes(supplementMarker)
  );
  if (!routed) {
    throw new Error('Expected supplemental requirement routing message to stay visible in the group chat.');
  }

  const runtimeCommunication = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'agent_runtime_communication' &&
      event.content.includes('absorbed the user supplement')
  );
  if (!runtimeCommunication) {
    throw new Error(
      `Expected restarted Codex runtime to emit an agent communication message. Agent messages: ${JSON.stringify(
        events
          .filter((event) => event.type === 'agent_message')
          .map((event) => ({
            taskId: event.taskId,
            content: event.content,
            payload: event.metadata.payload
          })),
        null,
        2
      )}`
    );
  }

  const taskArtifact = events.find(
    (event) =>
      event.type === 'artifact_created' &&
      event.taskId === activeTaskId &&
      (event.metadata.payload?.fileChanges ?? []).some(
        (change) =>
          change.path === 'src/feature.txt' &&
          change.source === 'actual_filesystem_snapshot' &&
          change.content?.includes(supplementMarker)
      )
  );
  if (!taskArtifact) {
    throw new Error('Expected final artifact to expose actual filesystem diff containing the supplemental requirement.');
  }

  const testReport = (taskArtifact.metadata.payload?.runtimeArtifacts ?? []).find(
    (artifact) => artifact.type === 'test_report' && artifact.metadata?.status === 'completed'
  );
  if (!testReport) {
    throw new Error('Expected runtime test report to be attached to the artifact created after supplement restart.');
  }

  const finalFeature = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  const contextProof = await readFile(join(workspaceRoot, 'src', 'context-proof.json'), 'utf8');
  if (!finalFeature.includes(supplementMarker) || !contextProof.includes('"hasRelevantMemory": true')) {
    throw new Error('Expected restarted Codex execution to persist proof that supplement memory reached its context.');
  }

  console.log('codex executing supplement context smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
