import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';

const supplementMarker = 'SUPPLEMENT_MARKER_BLUE_4821';
const firstExecutionMarker = '.first-codex-execution-started';
const execFile = promisify(execFileCallback);

async function findFile(directory, filename) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return path;
    }
  }
}

async function waitForFile(directory, filename, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = await findFile(directory, filename);
    if (path) return path;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filename} under ${directory}`);
}

async function waitForCompletion(apiBase, sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const session = (await api(apiBase, `/sessions/${sessionId}`)).data;
    lastStatus = session.status;
    if (lastStatus === 'COMPLETED') return session;
    if (lastStatus === 'FAILED' || lastStatus === 'WAIT_USER_DECISION') {
      throw new Error(`Session stopped before completion: ${lastStatus}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for COMPLETED, last=${lastStatus}`);
}

await buildServer();

let server;
let workspaceRoot;
let worktreeRoot;

try {
  worktreeRoot = join(tmpdir(), `ac-wt-s-${process.pid}-${Date.now()}`);
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
      "const sidecarPath = prompt.match(/task sidecar at:\\s*([^\\r\\n]+)/i)?.[1]?.trim();",
      "const sidecar = sidecarPath && existsSync(sidecarPath) ? readFileSync(sidecarPath, 'utf8') : '';",
      "const runtimeContext = `${prompt}\\n${sidecar}`;",
      "const requiredKind = process.env.AGENT_CLUSTER_EXPECTED_OUTPUT_KIND ?? 'task_execution_result';",
      "if (requiredKind === 'task_brief') {",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'task_brief', goal: 'Update backend source while preserving supplemental context.', scope: [], outOfScope: [], constraints: [], acceptanceCriteria: [], risks: [], openQuestions: [], suggestedTasks: [] }));",
      "} else if (requiredKind === 'post_review_report') {",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'post_review_report', isConsistentWithBrief: true, matchedItems: [], mismatchedItems: [], missingItems: [], outOfScopeChanges: [], testResults: [], recommendation: 'deliver', actions: [] }));",
      "} else if (requiredKind === 'final_delivery') {",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'final_delivery', summary: 'Supplement-aware backend execution completed.', completedItems: [], incompleteItems: [], risks: [], artifactRefs: [] }));",
      "} else if (requiredKind === 'agent_message') {",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'agent_message', messageKind: 'summary', content: 'Codex supplement workflow phase completed.', targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] }));",
      "} else if (requiredKind === 'task_acceptance_decision') {",
      '  console.log(JSON.stringify({',
      "    schemaVersion: '1.0',",
      "    kind: 'task_acceptance_decision',",
      "    status: 'accepted',",
      "    reason: 'Backend Codex accepts the active task and can absorb user supplements.',",
      '    missingContext: [],',
      '    requestedContext: null,',
      '    handoffSuggestion: null,',
      '    confidence: 0.95,',
      '    alternativeAgentKeys: [],',
      '    alternativeAgentIds: [],',
      '    agentMessages: []',
      '  }));',
      '} else {',
      `  const firstExecutionMarker = '${firstExecutionMarker}';`,
      '  if (!existsSync(firstExecutionMarker)) {',
      "    writeFileSync(firstExecutionMarker, 'started before user supplement\\n');",
      '    await delay(8000);',
      '    console.log(JSON.stringify({',
      "      schemaVersion: '1.0',",
      "      kind: 'task_execution_result',",
      "      status: 'completed',",
      "      summary: 'This first execution should be cancelled before completion.',",
      '      completedItems: [],',
      '      changedArtifacts: [],',
      '      requestedContext: null,',
      '      agentMessages: [],',
      '      nextSuggestedActions: [],',
      "      risks: ['first execution was not cancelled']",
      '    }));',
      '  } else {',
      `    const hasSupplement = runtimeContext.includes('${supplementMarker}');`,
      '    const hasRelevantMemory = hasSupplement;',
      "    mkdirSync('src', { recursive: true });",
      "    writeFileSync('src/feature.txt', `after supplement ${hasRelevantMemory ? 'from relevant memory' : 'missing relevant memory'} ${runtimeContext.includes('user_message_routing') ? 'with routing event' : 'without routing event'} ${runtimeContext.includes('SUPPLEMENT_MARKER_BLUE_4821') ? 'SUPPLEMENT_MARKER_BLUE_4821' : 'NO_SUPPLEMENT'}\\n`);",
      "    writeFileSync('src/context-proof.json', JSON.stringify({ hasSupplement, hasRelevantMemory }, null, 2));",
      '    console.log(JSON.stringify({',
      "      schemaVersion: '1.0',",
      "      kind: 'task_execution_result',",
      "      status: hasRelevantMemory ? 'completed' : 'failed',",
      "      summary: hasRelevantMemory ? 'Codex restarted with supplemental requirement memory and edited real files.' : 'Codex prompt missed supplemental memory.',",
      "      completedItems: hasRelevantMemory ? ['Supplemental requirement was present in relevantMemories', 'Real source file updated after restart'] : [],",
      '      changedArtifacts: [],',
      '      requestedContext: null,',
      "      agentMessages: [{ schemaVersion: '1.0', kind: 'agent_message', messageKind: 'progress', content: 'Backend absorbed the user supplement after reschedule and updated the source diff.', targetAgentIds: [], targetAgentKeys: ['coordinator', 'review'], mentionedAgentIds: [], relatedTaskIds: [] }],",
      "      nextSuggestedActions: ['Inspect actual filesystem diff and test report'],",
      "      risks: hasRelevantMemory ? [] : ['supplement context was not injected']",
      '    }));',
      '  }',
      '}'
    ].join('\n')
  );
  await execFile('git', ['init'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.email', 'codex-supplement@example.invalid'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.name', 'Codex Supplement'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspaceRoot });

  server = await startSmokeServer('codex-executing-supplement-context-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: 'node',
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubScript]),
    CODEX_RUNTIME_PROMPT_MODE: 'file',
    CODEX_RUNTIME_SHELL: 'false',
    RUNTIME_STREAMING: 'off',
    CODEX_RUNTIME_TEST_COMMAND: 'npm test',
    CODEX_RUNTIME_TIMEOUT_MS: '30000',
    AGENT_CLUSTER_WORKTREE_ROOT: worktreeRoot
  });

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Codex executing supplement workflow',
    ['backend']
  );

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
      },
      runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
    }
  );
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

  const firstCodexStart = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_started',
    (event) => event.metadata.payload?.runtimeType === 'codex' && Boolean(event.taskId),
    20_000
  );
  const activeTaskId = firstCodexStart.taskId;
  if (!activeTaskId) {
    throw new Error('Expected Codex runtime start to identify the active task.');
  }
  await waitForFile(worktreeRoot, firstExecutionMarker);
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
  try {
    await waitForCompletion(server.apiBase, sessionId);
  } catch (error) {
    const events = await listEvents(server.apiBase, sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nEvents: ${JSON.stringify(
        events
          .filter((event) =>
            [
              'runtime_started',
              'runtime_completed',
              'runtime_failed',
              'task_started',
              'task_completed',
              'task_rejected',
              'workflow_node_started',
              'workflow_node_completed',
              'workflow_run_failed',
              'session_status_changed',
              'error_reported'
            ].includes(event.type)
          )
          .map((event) => ({ type: event.type, taskId: event.taskId, content: event.content, payload: event.metadata.payload })),
        null,
        2
      )}`
    );
  }

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
      (event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes ?? []).some(
        (change) =>
          change.path === 'src/feature.txt' &&
          change.content?.includes(supplementMarker)
      )
  );
  if (!taskArtifact) {
    throw new Error('Expected final artifact to expose actual filesystem diff containing the supplemental requirement.');
  }

  const verifiedTest = (taskArtifact.metadata.payload?.systemEvidence?.verifiedTestResults ?? []).find(
    (result) => result.status === 'passed'
  );
  if (!verifiedTest) {
    throw new Error('Expected platform-verified test evidence after supplement restart.');
  }

  const contextProofChange = (taskArtifact.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes ?? []).find(
    (change) => change.path === 'src/context-proof.json' && change.content?.includes('"hasRelevantMemory": true')
  );
  if (!contextProofChange) {
    throw new Error('Expected captured worktree evidence proving that relevant supplement memory reached Codex.');
  }

  const finalFeature = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  const sourceContextProof = await readFile(join(workspaceRoot, 'src', 'context-proof.json'), 'utf8').catch(() => '');
  if (finalFeature !== 'before supplement\n' || sourceContextProof) {
    throw new Error('Managed Codex worktree must not directly mutate the selected source workspace.');
  }

  console.log('codex executing supplement context smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  if (worktreeRoot) {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}
