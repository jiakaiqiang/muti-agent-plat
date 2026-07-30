import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeBufferedArgs,
  claudeBufferedTimeoutMs,
  ClaudeCodeRuntimeAdapterService,
  parseClaudeBufferedOutput,
  pickClaudeRunMode
} from './claude-code-runtime-adapter.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { RUNTIME_OUTPUT_KINDS, runtimeOutputExamples } from '@agent-cluster/shared';
import { sanitizeClaudeProcessError } from './claude-cli-launcher.js';

function withStreaming(value: string | undefined, fn: () => void) {
  const previous = process.env.RUNTIME_STREAMING;
  if (value === undefined) delete process.env.RUNTIME_STREAMING;
  else process.env.RUNTIME_STREAMING = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previous;
  }
}

async function claudeAvailability(value?: string) {
  const previous = process.env.CLAUDE_CODE_ENABLED;
  const previousCommand = process.env.CLAUDE_CODE_COMMAND;
  if (value === undefined) delete process.env.CLAUDE_CODE_ENABLED;
  else process.env.CLAUDE_CODE_ENABLED = value;
  if (value === 'true') process.env.CLAUDE_CODE_COMMAND = process.execPath;
  try {
    return await new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => undefined } as never).checkAvailability();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previous;
    if (previousCommand === undefined) delete process.env.CLAUDE_CODE_COMMAND;
    else process.env.CLAUDE_CODE_COMMAND = previousCommand;
  }
}

test('Claude registration is unavailable when its enable flag is absent', async () => {
  assert.equal((await claudeAvailability()).available, false);
});

test('Claude unavailable result explains the required enable flag', async () => {
  assert.match((await claudeAvailability('false')).reason ?? '', /CLAUDE_CODE_ENABLED=true/);
});

test('Claude enable flag is fail-closed and case sensitive', async () => {
  assert.equal((await claudeAvailability('TRUE')).available, false);
});

test('Claude registration is available only when explicitly enabled', async () => {
  assert.deepEqual(await claudeAvailability('true'), { available: true });
});

test('Claude uses buffered mode when streaming is not configured', () => {
  withStreaming(undefined, () => assert.equal(pickClaudeRunMode(), 'buffered'));
});

test('Claude uses buffered mode when streaming is off', () => {
  withStreaming('off', () => assert.equal(pickClaudeRunMode(), 'buffered'));
});

test('Claude remains buffered when only Codex streaming is enabled', () => {
  withStreaming('codex', () => assert.equal(pickClaudeRunMode(), 'buffered'));
});

test('Claude uses streaming mode for all', () => {
  withStreaming('all', () => assert.equal(pickClaudeRunMode(), 'streaming'));
});

test('Claude streaming mode is case insensitive', () => {
  withStreaming('ALL', () => assert.equal(pickClaudeRunMode(), 'streaming'));
});

test('Claude rejects unknown streaming modes to buffered', () => {
  withStreaming('bogus', () => assert.equal(pickClaudeRunMode(), 'buffered'));
});

test('Claude buffered arguments enforce the registered JSON Schema', () => {
  const schema = { type: 'object', required: ['kind'] };
  const args = buildClaudeBufferedArgs({
    outputSchema: schema,
    permissionMode: 'dontAsk',
    rootPath: 'C:\\workspace',
    allowedTools: 'Read'
  });

  const schemaFlag = args.indexOf('--json-schema');
  assert.ok(schemaFlag > 0);
  assert.deepEqual(JSON.parse(args[schemaFlag + 1] ?? ''), schema);
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
});

test('Claude buffered command sends prompts through stdin', async () => {
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => process.cwd() } as never);
  const prompt = 'prompt with spaces\nand a second line';
  const result = await (adapter as unknown as {
    runBufferedCommand(
      command: string,
      args: string[],
      prompt: string,
      options: {
        cwd: string;
        timeout: number;
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        diagnosticRef: string;
      }
    ): Promise<{ stdout: string; stderr: string }>;
  }).runBufferedCommand(
    process.execPath,
    [
      '-e',
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, argv: process.argv.slice(1) })));",
      '--',
      '--json-schema',
      JSON.stringify({ type: 'object', required: ['kind'], properties: { kind: { const: 'agent_message' } } })
    ],
    prompt,
    {
      cwd: process.cwd(),
      timeout: 5_000,
      env: process.env,
      maxBuffer: 1024 * 1024,
      diagnosticRef: 'invocation-argv-boundary'
    }
  );

  const received = JSON.parse(result.stdout) as { input: string; argv: string[] };
  assert.equal(received.input, prompt);
  assert.deepEqual(
    JSON.parse(received.argv[received.argv.indexOf('--json-schema') + 1] ?? ''),
    { type: 'object', required: ['kind'], properties: { kind: { const: 'agent_message' } } }
  );
  assert.equal(result.stderr, '');
});

test('Claude buffered command preserves process output and exit code on non-zero exit', async () => {
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => process.cwd() } as never);
  const runBufferedCommand = (adapter as unknown as {
    runBufferedCommand(
      command: string,
      args: string[],
      prompt: string,
      options: {
        cwd: string;
        timeout: number;
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        diagnosticRef: string;
      }
    ): Promise<{ stdout: string; stderr: string }>;
  }).runBufferedCommand.bind(adapter);

  await assert.rejects(
    runBufferedCommand(
      process.execPath,
      [
        '-e',
        "process.stdout.write('valid stdout'); process.stderr.write('update_apply_exe_locked'); process.exitCode = 1;"
      ],
      '',
      {
        cwd: process.cwd(),
        timeout: 5_000,
        env: process.env,
        maxBuffer: 64 * 1024,
        diagnosticRef: 'buffered-nonzero-test'
      }
    ),
    (error: unknown) => {
      const failure = error as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
      };
      assert.equal(failure.stdout, 'valid stdout');
      assert.equal(failure.stderr, 'update_apply_exe_locked');
      assert.equal(failure.exitCode, 1);
      return true;
    }
  );
});

test('Claude buffered timeout uses and cannot exceed the independent absolute deadline', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-timeout-'));
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  const previousTimeout = process.env.CLAUDE_CODE_TIMEOUT_MS;
  const previousAbsoluteTimeout = process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS;
  const previousCommand = process.env.CLAUDE_CODE_COMMAND;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  process.env.CLAUDE_CODE_COMMAND = process.execPath;
  process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS = '1800000';
  try {
    for (const [configuredTimeout, expectedTimeout] of [
      [undefined, 1_800_000],
      ['0', 1_800_000],
      ['250000', 250_000],
      ['2500000', 1_800_000]
    ] as const) {
      if (configuredTimeout === undefined) delete process.env.CLAUDE_CODE_TIMEOUT_MS;
      else process.env.CLAUDE_CODE_TIMEOUT_MS = configuredTimeout;

      let receivedTimeout: number | undefined;
      let receivedArgs: string[] | undefined;
      const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
      Object.defineProperty(adapter, 'runBufferedCommand', {
        value: async (
          _command: string,
          args: string[],
          _prompt: string,
          options: { timeout: number }
        ) => {
          receivedTimeout = options.timeout;
          receivedArgs = args;
          return {
            stdout: JSON.stringify({ result: JSON.stringify(runtimeOutputExamples.agent_message) }),
            stderr: ''
          };
        }
      });

      const result = await adapter.start(makeInvocationPlan({
        executionTarget: { runtimeType: 'claude_code' }
      })).result;

      assert.equal(result.status, 'completed');
      assert.equal(receivedTimeout, expectedTimeout);
      const schemaFlag = receivedArgs?.indexOf('--json-schema') ?? -1;
      assert.ok(schemaFlag > 0);
      const schema = JSON.parse(receivedArgs?.[schemaFlag + 1] ?? '{}') as {
        properties?: { kind?: { const?: unknown } };
      };
      assert.equal(schema.properties?.kind?.const, 'agent_message');
    }
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
    if (previousTimeout === undefined) delete process.env.CLAUDE_CODE_TIMEOUT_MS;
    else process.env.CLAUDE_CODE_TIMEOUT_MS = previousTimeout;
    if (previousAbsoluteTimeout === undefined) delete process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS;
    else process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS = previousAbsoluteTimeout;
    if (previousCommand === undefined) delete process.env.CLAUDE_CODE_COMMAND;
    else process.env.CLAUDE_CODE_COMMAND = previousCommand;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Claude buffered timeout helper defaults to the absolute deadline', () => {
  const previousTimeout = process.env.CLAUDE_CODE_TIMEOUT_MS;
  const previousAbsoluteTimeout = process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS;
  try {
    delete process.env.CLAUDE_CODE_TIMEOUT_MS;
    process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS = '1800000';
    assert.equal(claudeBufferedTimeoutMs(), 1_800_000);
  } finally {
    if (previousTimeout === undefined) delete process.env.CLAUDE_CODE_TIMEOUT_MS;
    else process.env.CLAUDE_CODE_TIMEOUT_MS = previousTimeout;
    if (previousAbsoluteTimeout === undefined) delete process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS;
    else process.env.CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS = previousAbsoluteTimeout;
  }
});

test('Claude buffered output accepts every registered Runtime output through the shared validator', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    const example = runtimeOutputExamples[kind];
    assert.deepEqual(
      parseClaudeBufferedOutput(JSON.stringify({ result: JSON.stringify(example) }), kind),
      example
    );
  }
});

test('Claude buffered output prefers the structured_output provider envelope', () => {
  const example = runtimeOutputExamples.task_brief;
  assert.deepEqual(
    parseClaudeBufferedOutput(JSON.stringify({
      result: 'non-authoritative display text',
      structured_output: example
    }), 'task_brief'),
    example
  );
});

test('Claude buffered output accepts a single complete JSON markdown fence', () => {
  const example = runtimeOutputExamples.agent_message;
  for (const lineEnding of ['\n', '\r\n']) {
    const fenced = `\`\`\`json${lineEnding}${JSON.stringify(example)}${lineEnding}\`\`\``;
    assert.deepEqual(
      parseClaudeBufferedOutput(JSON.stringify({ result: fenced }), 'agent_message'),
      example
    );
  }
});

test('Claude buffered output does not extract JSON from prose or malformed fences', () => {
  const json = JSON.stringify(runtimeOutputExamples.agent_message);
  for (const result of [
    `Result follows:\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`json\n${json}`,
    `\`\`\`text\n${json}\n\`\`\``
  ]) {
    assert.throws(
      () => parseClaudeBufferedOutput(JSON.stringify({ result }), 'agent_message'),
      SyntaxError
    );
  }
});

test('Claude fenced output still uses the strict shared Runtime output contract', () => {
  const invalid = { ...runtimeOutputExamples.agent_message, unexpected: true };
  assert.throws(
    () => parseClaudeBufferedOutput(
      JSON.stringify({ result: `\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\`` }),
      'agent_message'
    ),
    /RUNTIME_OUTPUT_CONTRACT_VIOLATION/
  );
});

test('Claude prompts include the strict output schema and example', () => {
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => process.cwd() } as never);
  const promptFor = (taskSidecarPath?: string) => (adapter as unknown as {
    prompt(input: ReturnType<typeof makeInvocationPlan>, taskSidecarPath?: string): string;
  }).prompt(makeInvocationPlan({ executionTarget: { runtimeType: 'claude_code' } }), taskSidecarPath);

  for (const prompt of [promptFor(), promptFor('task-brief.json')]) {
    assert.match(prompt, /messageKind/);
    assert.match(prompt, /targetAgentIds/);
    assert.match(prompt, /Summarize the result here\./);
  }
  assert.match(promptFor('task-brief.json'), /without markdown fences/);
});

test('Claude task brief prompts make the routingMode enum explicit', () => {
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => process.cwd() } as never);
  const promptFor = (taskSidecarPath?: string) => (adapter as unknown as {
    prompt(input: ReturnType<typeof makeInvocationPlan>, taskSidecarPath?: string): string;
  }).prompt(makeInvocationPlan({
    executionTarget: { runtimeType: 'claude_code' },
    expectedOutput: { kind: 'task_brief', schemaVersion: '1.0' }
  }), taskSidecarPath);

  for (const prompt of [promptFor(), promptFor('task-brief.json')]) {
    assert.match(prompt, /routingMode must be exactly/);
    assert.match(prompt, /coordinator_controlled/);
    assert.match(prompt, /agent_suggested/);
    assert.match(prompt, /agent_delegated/);
  }
});

test('Claude buffered output rejects missing fields, extra fields, old versions, and wrong kinds', () => {
  const valid = runtimeOutputExamples.agent_message;
  const missing = { ...valid } as Record<string, unknown>;
  delete missing.content;
  for (const candidate of [
    missing,
    { ...valid, unexpected: true },
    { ...valid, schemaVersion: '0.1' },
    runtimeOutputExamples.task_brief
  ]) {
    assert.throws(
      () => parseClaudeBufferedOutput(JSON.stringify(candidate), 'agent_message'),
      /RUNTIME_OUTPUT_CONTRACT_VIOLATION/
    );
  }
});

test('Claude buffered run preserves Runtime output contract violations as non-retryable', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-contract-'));
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  const previousCommand = process.env.CLAUDE_CODE_COMMAND;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  process.env.CLAUDE_CODE_COMMAND = process.execPath;
  try {
    const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
    Object.defineProperty(adapter, 'runBufferedCommand', {
      value: async () => ({
        stdout: JSON.stringify({ kind: 'agent_message', schemaVersion: '1.0', messageKind: 'summary' }),
        stderr: ''
      })
    });

    const result = await adapter.start(makeInvocationPlan({
      executionTarget: { runtimeType: 'claude_code' }
    })).result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
    assert.equal(result.error?.retryable, false);
    assert.deepEqual(result.error?.details, { provider: 'claude_code', expectedKind: 'agent_message' });
    assert.equal(result.events[0]?.metadata?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
    if (previousCommand === undefined) delete process.env.CLAUDE_CODE_COMMAND;
    else process.env.CLAUDE_CODE_COMMAND = previousCommand;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Claude buffered run preserves a valid contract result when the CLI exits non-zero afterwards', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-nonzero-valid-'));
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  try {
    const recoveredArtifact = {
      type: 'code_diff' as const,
      title: 'Recovered model artifact',
      content: 'The model result was emitted before the CLI failed.',
      uri: null,
      summary: 'Recovered from valid buffered stdout.',
      metadata: {
        fileChanges: [],
        validationEvidence: null,
        summaryMemoryCheckpoint: null
      }
    };
    const recoveredOutput = {
      ...runtimeOutputExamples.task_execution_result,
      changedArtifacts: [recoveredArtifact]
    };
    const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
    Object.defineProperty(adapter, 'runBufferedCommand', {
      value: async () => {
        writeFileSync(join(workspace, 'recovered.txt'), 'captured after non-zero exit', 'utf8');
        throw Object.assign(new Error('Claude exited with code 1'), {
          stdout: JSON.stringify(recoveredOutput),
          stderr: 'update_apply_exe_locked',
          exitCode: 1
        });
      }
    });

    const result = await adapter.start(makeInvocationPlan({
      executionTarget: { runtimeType: 'claude_code' },
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' }
    })).result;

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, recoveredOutput);
    assert.deepEqual(result.artifacts, [recoveredArtifact]);
    assert.deepEqual(result.systemEvidence.workspaceChangeSet?.changes, [
      {
        operation: 'create',
        path: 'recovered.txt',
        content: 'captured after non-zero exit',
        encoding: 'utf-8'
      }
    ]);
    assert.equal(result.events[0]?.metadata?.warning, 'CLAUDE_NONZERO_EXIT_WITH_VALID_OUTPUT');
    assert.equal(result.events[0]?.metadata?.exitCode, 1);
    assert.equal(result.runtimeDiagnostics?.stderrTail, 'update_apply_exe_locked');
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Claude buffered run does not recover valid stdout from cancellation or timeout', async (t) => {
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  try {
    await t.test('cancellation', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-cancelled-'));
      const controller = new AbortController();
      controller.abort();
      try {
        const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
        Object.defineProperty(adapter, 'runBufferedCommand', {
          value: async () => {
            throw Object.assign(new Error('Claude exited with code 1'), {
              stdout: JSON.stringify(runtimeOutputExamples.agent_message),
              stderr: 'late output after cancellation',
              exitCode: 1
            });
          }
        });

        const result = await adapter.start(makeInvocationPlan({
          executionTarget: { runtimeType: 'claude_code' }
        }), controller.signal).result;

        assert.equal(result.status, 'cancelled');
        assert.equal(result.error?.code, 'RUNTIME_CANCELLED');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    await t.test('timeout', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-timeout-output-'));
      try {
        const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
        Object.defineProperty(adapter, 'runBufferedCommand', {
          value: async () => {
            throw Object.assign(new Error('Claude timed out'), {
              code: 'ETIMEDOUT',
              stdout: JSON.stringify(runtimeOutputExamples.agent_message),
              stderr: 'late output after timeout',
              exitCode: 1
            });
          }
        });

        const result = await adapter.start(makeInvocationPlan({
          executionTarget: { runtimeType: 'claude_code' }
        })).result;

        assert.equal(result.status, 'failed');
        assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
  }
});

test('Claude buffered non-zero recovery remains fail-closed without a valid expected output', async (t) => {
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  try {
    for (const scenario of [
      { name: 'empty stdout', stdout: '', exitCode: 1 },
      { name: 'malformed stdout', stdout: '{', exitCode: 1 },
      {
        name: 'wrong output contract',
        stdout: JSON.stringify(runtimeOutputExamples.task_brief),
        exitCode: 1
      },
      {
        name: 'non-exit process error',
        stdout: JSON.stringify(runtimeOutputExamples.agent_message),
        exitCode: undefined
      }
    ]) {
      await t.test(scenario.name, async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-fail-closed-'));
        try {
          const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
          Object.defineProperty(adapter, 'runBufferedCommand', {
            value: async () => {
              throw Object.assign(new Error('Claude process failed'), {
                stdout: scenario.stdout,
                stderr: 'provider failure',
                exitCode: scenario.exitCode
              });
            }
          });

          const result = await adapter.start(makeInvocationPlan({
            executionTarget: { runtimeType: 'claude_code' }
          })).result;

          assert.equal(result.status, 'failed');
          assert.notEqual(result.events[0]?.metadata?.warning, 'CLAUDE_NONZERO_EXIT_WITH_VALID_OUTPUT');
        } finally {
          rmSync(workspace, { recursive: true, force: true });
        }
      });
    }
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
  }
});

test('Claude buffered provider timeout preserves retry policy and failure diagnostics', async () => {
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  const previousStreaming = process.env.RUNTIME_STREAMING;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  process.env.RUNTIME_STREAMING = 'off';
  const workspace = mkdtempSync(join(tmpdir(), 'claude-buffered-provider-timeout-'));
  try {
    const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => workspace } as never);
    Object.defineProperty(adapter, 'runBufferedCommand', {
      value: async () => {
        const stdout = JSON.stringify({
          result: 'API Error: 524 {"status":524,"error_name":"origin_response_timeout","zone":"api.picpi.top","ray_id":"ray-524","retryable":true,"retry_after":120}'
        });
        const stderr = 'safe stderr tail';
        const error = sanitizeClaudeProcessError({ code: 1, stdout, stderr }, 'provider-timeout-invocation');
        throw Object.assign(error, { stdout, stderr, exitCode: 1 });
      }
    });

    const result = await adapter.start(makeInvocationPlan({
      invocationId: 'provider-timeout-invocation',
      executionTarget: { runtimeType: 'claude_code' }
    })).result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
    assert.equal(result.error?.retryable, true);
    assert.equal(result.error?.details?.httpStatus, 524);
    assert.equal(result.error?.details?.retryAfterMs, 120_000);
    assert.equal(result.runtimeDiagnostics?.stderrTail, 'safe stderr tail');
    assert.deepEqual(result.runtimeDiagnostics?.providerNotifications, [{
      method: 'provider_error',
      disposition: 'debug_only',
      payload: {
        provider: 'claude_code',
        stage: 'provider_response',
        httpStatus: 524,
        errorName: 'origin_response_timeout',
        errorCategory: undefined,
        gatewayZone: 'api.picpi.top',
        rayId: 'ray-524',
        retryAfterMs: 120_000,
        exitCode: 1,
        diagnosticRef: 'provider-timeout-invocation'
      }
    }]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
    if (previousStreaming === undefined) delete process.env.RUNTIME_STREAMING;
    else process.env.RUNTIME_STREAMING = previousStreaming;
  }
});

test('Claude rejects resume when its asserted workDir differs from the workspace binding', async () => {
  const previousEnabled = process.env.CLAUDE_CODE_ENABLED;
  process.env.CLAUDE_CODE_ENABLED = 'true';
  try {
    const root = join(process.cwd(), 'workspace-a');
    const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => root } as never);
    const result = await adapter.start(makeInvocationPlan({
      executionTarget: { runtimeType: 'claude_code' },
      resume: { cliSessionId: 'session-a', workDir: join(process.cwd(), 'workspace-b') }
    })).result;
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /does not match the current workspace binding/);
  } finally {
    if (previousEnabled === undefined) delete process.env.CLAUDE_CODE_ENABLED;
    else process.env.CLAUDE_CODE_ENABLED = previousEnabled;
  }
});
