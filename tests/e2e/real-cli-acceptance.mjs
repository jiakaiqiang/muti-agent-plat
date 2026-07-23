import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildServer } from './smoke-server.mjs';

if (process.env.RUN_REAL_CLI_ACCEPTANCE !== 'true') {
  throw new Error(
    'Real CLI acceptance is cost-bearing. Re-run with RUN_REAL_CLI_ACCEPTANCE=true after explicit approval.'
  );
}

const execFileAsync = promisify(execFile);
const runCount = Number(process.env.REAL_CLI_RUNS_PER_RUNTIME ?? 3);
const minimumRunCount = process.env.REAL_CLI_PHASE === 'sample' ? 20 : 1;
assert.ok(
  Number.isInteger(runCount) && runCount >= minimumRunCount,
  `REAL_CLI_RUNS_PER_RUNTIME must be at least ${minimumRunCount} for this phase.`
);
const reportPath = process.env.REAL_CLI_ACCEPTANCE_REPORT_PATH ?? join(
  process.cwd(),
  '.cache',
  'agent-cluster',
  'real-cli-acceptance-status.json'
);
const report = { startedAt: new Date().toISOString(), status: 'running', checkpoints: [] };
const reportHistoryPath = process.env.REAL_CLI_ACCEPTANCE_HISTORY_PATH ?? join(
  dirname(reportPath),
  'real-cli-acceptance-runs',
  `${report.startedAt.replace(/[:.]/g, '-')}.json`
);
const sampleGoalsPath = process.env.REAL_CLI_SAMPLE_GOALS_PATH;
const sampleGoals = sampleGoalsPath
  ? JSON.parse(await readFile(sampleGoalsPath, 'utf8'))
  : undefined;
if (sampleGoals !== undefined) {
  assert.ok(
    Array.isArray(sampleGoals) && sampleGoals.every((goal) => typeof goal === 'string' && goal.trim()),
    'REAL_CLI_SAMPLE_GOALS_PATH must point to a JSON array of non-empty strings.'
  );
}

async function checkpoint(stage, details = {}) {
  report.updatedAt = new Date().toISOString();
  report.stage = stage;
  report.checkpoints.push({ at: report.updatedAt, stage, ...details });
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(reportHistoryPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(reportHistoryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function resultSummary(execution) {
  return {
    status: execution.result.status,
    errorCode: execution.result.error?.code,
    errorMessage: execution.result.error?.message,
    durationMs: execution.durationMs,
    eventTypes: execution.events.map((event) => event.type),
    totalTokens: execution.result.usage?.totalTokens ?? 0,
    hasCliSessionId: Boolean(execution.result.runtimeSession?.cliSessionId),
    streamMetrics: execution.result.streamMetrics
  };
}

await buildServer();

const { CodexRuntimeAdapterService } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/codex-runtime-adapter.service.js'
);
const { ClaudeCodeRuntimeAdapterService } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.js'
);
const { RuntimeService } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/runtime.service.js'
);
const { WorkdirBriefService } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/streaming/workdir-brief.service.js'
);

const nodeBinDir = dirname(process.execPath);
const codexJs = join(nodeBinDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const claudeExe = join(nodeBinDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const codexCommand = process.env.REAL_CODEX_COMMAND ?? (existsSync(codexJs) ? process.execPath : 'codex');
const codexArgs = existsSync(codexJs)
  ? [codexJs, 'app-server', '--listen', 'stdio://']
  : ['app-server', '--listen', 'stdio://'];
const claudeCommand = process.env.REAL_CLAUDE_COMMAND ?? (existsSync(claudeExe) ? claudeExe : 'claude');

async function version(command, args) {
  const result = await execFileAsync(command, args, { timeout: 20_000, windowsHide: true });
  return result.stdout.trim() || result.stderr.trim();
}

const versions = {
  codex: await version(codexCommand, existsSync(codexJs) ? [codexJs, '--version'] : ['--version']),
  claude: await version(claudeCommand, ['--version'])
};
await checkpoint('versions-recorded', { versions, platform: process.platform });

function makeRuntime(runtimeType, adapter) {
  const stored = new Map();
  const adapters = new Map();
  const persistence = {
    getCollection: (key, fallback) => stored.get(key) ?? fallback,
    setCollection: (key, value) => stored.set(key, value)
  };
  const registry = {
    registerAdapter: async (candidate) => {
      if (candidate?.type) adapters.set(candidate.type, candidate);
    },
    getAdapter: (type) => adapters.get(type)
  };
  const runtime = new RuntimeService(
    persistence,
    registry,
    undefined,
    undefined,
    runtimeType === 'codex' ? adapter : undefined,
    runtimeType === 'claude_code' ? adapter : undefined,
    undefined,
    undefined
  );
  return { runtime, stored };
}

function input(runtimeType, workDir, invocationId, options, goal) {
  const sessionId = `real-${runtimeType}-session`;
  const taskId = `real-${runtimeType}-task`;
  const workspaceId = `real-${runtimeType}-workdir`;
  const agentId = `${runtimeType}-agent`;
  const agentName = runtimeType === 'codex' ? 'Codex acceptance' : 'Claude acceptance';
  return {
    invocationId: invocationId,
    sessionId,
    taskId,
    phase: 'task_execution',
    agent: {
      agentId,
      key: runtimeType,
      name: agentName,
      role: 'backend',
      systemPrompt: 'Perform the read-only acceptance task and return the requested structured output.',
      profileHash: `real-${runtimeType}-profile`,
      profileRevision: 1,
      skillBindings: [],
      requestedToolIds: [],
      requestedToolKeys: [],
      capabilityIds: [],
      knowledgeBaseIds: []
    },
    executionTarget: {
      runtimeType,
      source: 'task_override',
      reason: 'Explicit real CLI acceptance target.',
      requiredCapabilities: ['read'],
      requiredToolIds: [],
      writeMode: 'none',
      workspaceProviderKind: 'server_local'
    },
    toolCatalog: {
      tools: [],
      decisions: [],
      catalogHash: `real-${runtimeType}-catalog`
    },
    contextEnvelope: {
      version: 'v2',
      createdAt: new Date().toISOString(),
      workspaceId,
      sessionId,
      L0: {
        systemRules: ['Do not edit files.', 'Return only the requested structured JSON result.'],
        agentId,
        profileHash: `real-${runtimeType}-profile`,
        profileRevision: 1,
        toolCatalogHash: `real-${runtimeType}-catalog`,
        workspace: {
          workspaceId,
          rootName: 'real-cli-isolated-workspace',
          providerKind: 'server_local',
          revision: { id: invocationId, observedAt: new Date().toISOString() }
        }
      },
      L1: {
        sessionGoal: goal,
        phase: 'task_execution',
        task: {
          id: taskId,
          title: '真实 CLI 流式协议验收',
          description: goal,
          acceptanceCriteria: ['Return a valid agent_message RuntimeOutput.']
        },
        navigation: { entries: [], truncated: false }
      },
      L2: { source: 'generated', modules: [] },
      L3: { files: [], totalByteLength: 0, truncated: false },
      L4: { calls: [] },
      L5: { bullets: [], turnCount: 0 },
      L6: { changeSetIds: [], reportIds: [] },
      budget: { inputTokens: 8_000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3_600 }
    },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    budget: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxTotalTokens: 10_000 },
    ...(options?.resume ? { resume: options.resume } : {})
  };
}

async function execute(runtime, runInput, cancelAfterFirstEvent = false) {
  const startedAt = Date.now();
  const handle = runtime.start(runInput);
  const events = [];
  let firstEventResolve;
  const firstEvent = new Promise((resolve) => {
    firstEventResolve = resolve;
  });
  const consume = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      firstEventResolve?.();
      firstEventResolve = undefined;
    }
  })();
  if (cancelAfterFirstEvent) {
    await Promise.race([firstEvent, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    await handle.cancel();
  }
  const result = await handle.result;
  await consume;
  return { result, events, durationMs: Date.now() - startedAt };
}

async function acceptRuntime(runtimeType, phase = 'all') {
  const root = await mkdtemp(join(tmpdir(), `agent-cluster-real-${runtimeType}-`));
  const workDir = join(root, 'workspace');
  const stagingDir = join(root, 'staging');
  await mkdir(workDir, { recursive: true });
  const instructionFile = join(workDir, runtimeType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  const originalInstruction = Buffer.from('# 用户原始说明\r\n必须逐字节恢复。\r\n', 'utf8');
  await writeFile(instructionFile, originalInstruction);

  process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = stagingDir;
  const workspaceBindings = { resolveServerRoot: () => workDir };
  const brief = new WorkdirBriefService(workspaceBindings);
  const adapter = runtimeType === 'codex'
    ? new CodexRuntimeAdapterService(workspaceBindings, brief)
    : new ClaudeCodeRuntimeAdapterService(workspaceBindings, brief);
  const { runtime } = makeRuntime(runtimeType, adapter);
  const goal = [
    '请用中文给出三条简短的流式协议验收结论，并在 content 中包含以下代码块：',
    '```javascript',
    "console.log('real-cli-ok');",
    '```',
    '不要修改任何文件。'
  ].join('\n');
  const executions = [];

  try {
    let sessionId;
    const primaryRunCount = phase === 'remaining' ? 1 : runCount;
    for (let index = 0; index < primaryRunCount; index += 1) {
      const options = phase === 'all' && sessionId ? { resume: { cliSessionId: sessionId, workDir } } : undefined;
      const runGoal = phase === 'sample' ? sampleGoals[index] : goal;
      const execution = await execute(
        runtime,
        input(runtimeType, workDir, crypto.randomUUID(), options, runGoal)
      );
      const stage =
        phase === 'remaining'
          ? `${runtimeType}:fallback-seed`
          : phase === 'sample'
            ? `${runtimeType}:sample-${index + 1}`
            : `${runtimeType}:primary-${index + 1}`;
      await checkpoint(stage, {
        runtimeType,
        execution: resultSummary(execution)
      });
      assert.equal(execution.result.status, 'completed', JSON.stringify(execution.result.error));
      assert.equal(execution.result.output.kind, 'agent_message');
      if (phase !== 'sample') assert.match(execution.result.output.content, /```javascript|console\.log/);
      assert.ok(execution.result.usage.totalTokens > 0, 'Real CLI usage must be greater than zero.');
      assert.ok(execution.result.runtimeSession?.cliSessionId, 'Real CLI session id is required.');
      assert.equal(execution.result.runtimeSession?.workDir, workDir);
      assert.ok(execution.result.streamMetrics, 'Real CLI stream metrics are required for watchdog analysis.');
      if (phase === 'all' && sessionId) assert.equal(execution.result.runtimeSession.cliSessionId, sessionId);
      sessionId = execution.result.runtimeSession.cliSessionId;
      assert.deepEqual(await readFile(instructionFile), originalInstruction);
      executions.push(execution);
    }

    if (phase === 'all') {
      assert.ok(
        executions.some((item) => item.events.some((event) => event.type === 'runtime_progress')),
        'Expected streaming runtime_progress events.'
      );
      assert.ok(
        executions.some((item) => item.events.some((event) => event.type === 'tool_called' || event.type === 'tool_completed')),
        'Expected at least one real CLI tool event while reading the task sidecar.'
      );
    }

    if (phase === 'probe' || phase === 'sample') {
      const invocationLogs = runtime.listInvocations(`real-${runtimeType}-session`);
      assert.equal(invocationLogs.length, primaryRunCount);
      return {
        runtimeType,
        phase,
        successfulRuns: executions.length,
        resumeSessionId: sessionId,
        durationsMs: executions.map((item) => item.durationMs),
        totalTokens: executions.reduce((sum, item) => sum + item.result.usage.totalTokens, 0),
        invocationCount: invocationLogs.length
      };
    }

    const fallback = await execute(
      runtime,
      input(
        runtimeType,
        workDir,
        crypto.randomUUID(),
        { resume: { cliSessionId: `expired-${crypto.randomUUID()}`, workDir } },
        goal
      )
    );
    await checkpoint(`${runtimeType}:fallback`, { runtimeType, execution: resultSummary(fallback) });
    assert.equal(fallback.result.status, 'completed', JSON.stringify(fallback.result.error));
    assert.ok(fallback.events.some((event) => event.metadata?.code === 'RESUME_FALLBACK'));
    assert.ok(fallback.result.runtimeSession?.cliSessionId);
    assert.ok(fallback.result.usage.totalTokens > 0);
    assert.deepEqual(await readFile(instructionFile), originalInstruction);

    const cancelGoal = [
      '这是取消验收。先读取任务 sidecar，然后执行一个等待 30 秒的命令，等待结束后才返回 agent_message。',
      '不要修改任何文件。'
    ].join('\n');
    const cancelled = await execute(
      runtime,
      input(runtimeType, workDir, crypto.randomUUID(), undefined, cancelGoal),
      true
    );
    await checkpoint(`${runtimeType}:cancel`, { runtimeType, execution: resultSummary(cancelled) });
    assert.equal(cancelled.result.status, 'cancelled');
    assert.equal(cancelled.result.error?.code, 'RUNTIME_CANCELLED');
    assert.deepEqual(await readFile(instructionFile), originalInstruction);

    const invocationLogs = runtime.listInvocations(`real-${runtimeType}-session`);
    assert.equal(invocationLogs.length, primaryRunCount + 2);
    for (const invocation of invocationLogs.filter((item) => item.status === 'completed')) {
      assert.ok(invocation.cliSessionId);
      assert.equal(invocation.workDir, workDir);
      assert.ok((invocation.usage?.totalTokens ?? 0) > 0);
    }

    const previousMode = process.env.RUNTIME_STREAMING;
    const previousCommand = runtimeType === 'codex'
      ? process.env.CODEX_RUNTIME_COMMAND
      : process.env.CLAUDE_CODE_COMMAND;
    const previousArgs = process.env.CODEX_RUNTIME_ARGS_JSON;
    process.env.RUNTIME_STREAMING = 'off';
    if (runtimeType === 'codex') {
      process.env.CODEX_RUNTIME_COMMAND = process.execPath;
      process.env.CODEX_RUNTIME_ARGS_JSON = JSON.stringify(['-e', 'process.exit(7)']);
    } else {
      process.env.CLAUDE_CODE_COMMAND = process.execPath;
    }
    try {
      const legacy = await execute(
        runtime,
        input(runtimeType, workDir, crypto.randomUUID(), undefined, 'Legacy path explicit failure acceptance.')
      );
      await checkpoint(`${runtimeType}:legacy`, { runtimeType, execution: resultSummary(legacy) });
      assert.equal(legacy.result.status, 'failed');
      assert.notEqual(legacy.result.runtimeType, 'mock');
    } finally {
      process.env.RUNTIME_STREAMING = previousMode;
      if (runtimeType === 'codex') {
        process.env.CODEX_RUNTIME_COMMAND = previousCommand;
        if (previousArgs === undefined) delete process.env.CODEX_RUNTIME_ARGS_JSON;
        else process.env.CODEX_RUNTIME_ARGS_JSON = previousArgs;
      } else {
        process.env.CLAUDE_CODE_COMMAND = previousCommand;
      }
    }

    return {
      runtimeType,
      phase,
      successfulRuns: executions.length,
      resumeSessionId: sessionId,
      durationsMs: executions.map((item) => item.durationMs),
      totalTokens: executions.reduce((sum, item) => sum + item.result.usage.totalTokens, 0),
      fallback: { durationMs: fallback.durationMs, sessionId: fallback.result.runtimeSession.cliSessionId },
      cancel: { durationMs: cancelled.durationMs, eventCount: cancelled.events.length },
      invocationCount: runtime.listInvocations(`real-${runtimeType}-session`).length
    };
  } catch (error) {
    await checkpoint(`${runtimeType}:failed`, {
      runtimeType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const previous = { ...process.env };
Object.assign(process.env, {
  CODEX_RUNTIME_ENABLED: 'true',
  CLAUDE_CODE_ENABLED: 'true',
  CODEX_RUNTIME_COMMAND: codexCommand,
  CODEX_RUNTIME_ARGS_JSON: JSON.stringify(codexArgs),
  CODEX_RUNTIME_SHELL: 'false',
  CLAUDE_CODE_COMMAND: claudeCommand,
  CLAUDE_CODE_SHELL: 'false',
  RUNTIME_STREAMING: 'all',
  AGENT_CLUSTER_WORKDIR_BRIEF: 'true',
  CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS: process.env.CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS ?? '60000',
  CODEX_RUNTIME_IDLE_TIMEOUT_MS: process.env.CODEX_RUNTIME_IDLE_TIMEOUT_MS ?? '180000',
  CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS: process.env.CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS ?? '60000',
  CLAUDE_CODE_IDLE_TIMEOUT_MS: process.env.CLAUDE_CODE_IDLE_TIMEOUT_MS ?? '180000'
});

try {
  const reports = [];
  const selected = process.env.REAL_CLI_RUNTIME ?? 'all';
  const phase = process.env.REAL_CLI_PHASE ?? 'all';
  assert.ok(['all', 'remaining', 'probe', 'sample'].includes(phase), 'REAL_CLI_PHASE must be all, remaining, probe, or sample.');
  if (phase === 'sample') {
    assert.ok(runCount >= 20, 'REAL_CLI_RUNS_PER_RUNTIME must be at least 20 for watchdog sampling.');
    assert.ok(sampleGoals?.length >= runCount, 'REAL_CLI_SAMPLE_GOALS_PATH must contain at least one goal per sample run.');
  }
  if (selected === 'all' || selected === 'codex') reports.push(await acceptRuntime('codex', phase));
  if (selected === 'all' || selected === 'claude_code') reports.push(await acceptRuntime('claude_code', phase));
  assert.ok(reports.length > 0, 'REAL_CLI_RUNTIME must be all, codex, or claude_code.');
  report.status = 'passed';
  report.reports = reports;
  await checkpoint('complete', { reports });
  console.log(JSON.stringify({ ok: true, versions, platform: process.platform, reports }, null, 2));
} catch (error) {
  report.status = 'failed';
  await checkpoint('failed', { error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
