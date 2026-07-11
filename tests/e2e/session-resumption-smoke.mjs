import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './smoke-server.mjs';

await buildServer();

const root = fileURLToPath(new URL('../..', import.meta.url));
const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'fixtures', 'codex-appserver-stub.mjs');
const { CodexRuntimeAdapterService } = await import('../../apps/server/dist/apps/server/src/modules/runtimes/codex-runtime-adapter.service.js');
const { RuntimeService } = await import('../../apps/server/dist/apps/server/src/modules/runtimes/runtime.service.js');

const workspace = await mkdtemp(join(tmpdir(), 'agent-cluster-resume-'));
await mkdir(join(workspace, 'src'), { recursive: true });

const previous = { ...process.env };
Object.assign(process.env, {
  CODEX_RUNTIME_ENABLED: 'true',
  ENGINEERING_RUNTIME_STREAMING: 'codex',
  CODEX_RUNTIME_COMMAND: process.execPath,
  CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubPath]),
  AGENT_CLUSTER_WORKDIR_BRIEF: 'false'
});

function input() {
  return {
    runId: crypto.randomUUID(),
    sessionId: 'session-resume-smoke',
    taskId: 'task-1',
    phase: 'task_execution',
    agent: {
      id: 'backend', key: 'backend', name: 'Backend', role: 'backend', systemPrompt: '', runtimeType: 'codex', capabilityIds: []
    },
    contextPack: {
      systemRules: [], sessionGoal: 'Verify resume fallback.', taskContext: {}, summaryMemory: {}, continuationState: {},
      workingDirectory: { id: 'wd-1', name: 'workspace', kind: 'server_local', path: workspace, selectedAt: new Date().toISOString() },
      agentProfile: {}, relevantEvents: [], relevantMemories: [], ragSnippets: [], artifacts: [], capabilities: [], constraints: [], budget: {}
    },
    expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
    budget: {},
    options: { resume: { cliSessionId: 'old-session', workDir: workspace } }
  };
}

try {
  process.env.STUB_RESUME_FAIL = '1';
  const adapter = new CodexRuntimeAdapterService();
  const persistence = { getCollection: (_key, fallback) => fallback, setCollection: () => {} };
  const registry = { registerAdapter: async () => {}, getAdapter: () => adapter };
  const runtime = new RuntimeService(
    persistence,
    registry,
    {},
    {},
    adapter,
    {},
    {},
    {}
  );
  const execution = runtime.start(input());
  const events = [];
  const consume = (async () => {
    for await (const event of execution.events) events.push(event);
  })();
  const result = await execution.result;
  await consume;
  if (result.status !== 'completed' || result.runtimeSession?.cliSessionId !== 'stub-session-1') {
    throw new Error(`Expected fallback to a fresh completed Codex session: ${JSON.stringify(result)}`);
  }
  if (!events.some((event) => event.metadata?.code === 'RESUME_FALLBACK')) {
    throw new Error('Expected RESUME_FALLBACK runtime event.');
  }
  console.log('session resumption smoke ok');
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
  await rm(workspace, { recursive: true, force: true });
}
