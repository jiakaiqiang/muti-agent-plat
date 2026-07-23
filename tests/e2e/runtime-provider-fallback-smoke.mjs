import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer
} from './smoke-server.mjs';

await buildServer();

let server;
let workspaceRoot;
try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-provider-fallback-'));
  await writeFile(join(workspaceRoot, 'README.md'), '# Provider fallback smoke\n');
  server = await startSmokeServer('runtime-provider-fallback-smoke', {
    DISCUSSION_AGENT_KEYS: 'backend',
    DISCUSSION_MAX_ROUNDS: '1',
    REQUIRE_USER_CONFIRMATION: 'false',
    CLAUDE_CODE_ENABLED: 'true',
    CLAUDE_CODE_COMMAND: process.execPath,
    CLAUDE_CODE_ARGS_JSON: JSON.stringify([
      join(process.cwd(), 'tests', 'e2e', 'fixtures', 'claude-stream-json-stub.mjs')
    ]),
    RUNTIME_STREAMING: 'all',
    STUB_PROVIDER_524: '1',
    RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS: '0',
    RUNTIME_PROVIDER_CIRCUIT_TTL_MS: '120000',
    RUNTIME_PROVIDER_MAX_ATTEMPTS: '3',
    LLM_DRY_RUN: 'true',
    LLM_MOCK_FALLBACK: 'true'
  });

  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Verify retryable Claude gateway timeout fallback.',
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspaceRoot,
        name: 'provider-fallback-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: {
        preferredRuntimeType: 'claude_code',
        allowedRuntimeTypes: ['claude_code', 'generic_llm']
      }
    }
  );

  const invocations = (await api(
    server.apiBase,
    `/sessions/${sessionId}/debug/runtime-invocations`
  )).data.items;
  const discussion = invocations.filter((item) => item.phase === 'discussion');
  const claudeAttempts = discussion.filter((item) => item.executionTarget.runtimeType === 'claude_code');
  const fallbackAttempt = discussion.find((item) => item.executionTarget.runtimeType === 'generic_llm');
  if (claudeAttempts.length !== 2) {
    throw new Error(`Expected exactly two Claude attempts: ${JSON.stringify(discussion)}`);
  }
  for (const attempt of claudeAttempts) {
    if (
      attempt.status !== 'failed' ||
      attempt.error?.code !== 'RUNTIME_TIMEOUT' ||
      attempt.error?.retryable !== true ||
      attempt.error?.details?.httpStatus !== 524
    ) {
      throw new Error(`Claude 524 classification was not preserved: ${JSON.stringify(attempt)}`);
    }
  }
  if (
    !fallbackAttempt ||
    fallbackAttempt.status !== 'completed' ||
    fallbackAttempt.attempt?.attempt !== 3 ||
    fallbackAttempt.attempt?.fallbackFromRuntimeType !== 'claude_code'
  ) {
    throw new Error(`Expected audited Generic LLM fallback: ${JSON.stringify(fallbackAttempt)}`);
  }
  if (!invocations.some(
    (item) => item.phase === 'brief_generation' && item.executionTarget.runtimeType === 'generic_llm'
  )) {
    throw new Error(`Open Claude circuit should route Brief generation to fallback: ${JSON.stringify(invocations)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  for (const code of ['RUNTIME_PROVIDER_RETRY_SCHEDULED', 'RUNTIME_PROVIDER_FALLBACK']) {
    if (!events.some((event) => event.metadata.payload?.code === code)) {
      throw new Error(`Missing ${code} event: ${JSON.stringify(events)}`);
    }
  }
  console.log('runtime provider fallback smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
}
