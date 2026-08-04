import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvocationPlan, LocalRuntimeInvocationRequest } from '@agent-cluster/shared';
import { buildClaudeArgs, ClaudeCodeLocalRuntimeAdapter } from './adapters/claude-code-adapter.js';
import { buildCodexArgs } from './adapters/codex-adapter.js';
import {
  buildRuntimeProcessEnv,
  executeLocalInvocation,
  intersectPermissionPolicies,
  shouldApplyStagedChangeSet
} from './runtime.js';
import { createWorkspaceState, LocalWorkspace } from './workspace.js';

test('proposal_only keeps staged edits as evidence without applying them to the user workspace', () => {
  assert.equal(shouldApplyStagedChangeSet('proposal_only'), false);
  assert.equal(shouldApplyStagedChangeSet('none'), false);
  assert.equal(shouldApplyStagedChangeSet('propose_changes'), true);
  assert.equal(shouldApplyStagedChangeSet('direct_audited'), true);
});

test('Codex local adapter permits the managed staging directory without relying on repository trust', () => {
  assert.deepEqual(buildCodexArgs(), [
    'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-'
  ]);
});

test('local Runtime executes in staging and returns an isolated ChangeSet for platform writeback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-source-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-fixture-'));
  const fixturePath = join(fixtureRoot, 'runtime-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CODEX_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# Original\n', 'utf8');
    await writeFile(join(root, 'delete-me.txt'), 'remove me\n', 'utf8');
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'README.md'), '# Changed\\n');",
      "fs.unlinkSync(path.join(process.cwd(), 'delete-me.txt'));",
      "fs.writeFileSync(path.join(process.cwd(), 'created.txt'), process.cwd());",
      "process.stdout.write(JSON.stringify({schemaVersion:'1.0',kind:'agent_message',messageKind:'progress',content:'done',targetAgentIds:[],targetAgentKeys:[],mentionedAgentIds:[],relatedTaskIds:[]}) + '\\n');"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CODEX_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = JSON.stringify([fixturePath]);

    const state = await createWorkspaceState(root, 'runtime-test');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);
    const request = await invocationRequest(workspace);
    const blocked = await executeLocalInvocation(request, workspace, new AbortController().signal, () => {});

    assert.equal(blocked.status, 'failed');
    assert.match(blocked.error?.message ?? '', /LOCAL_CONFIRMATION_REQUIRED/);
    assert.deepEqual(blocked.error?.details, {
      confirmationRequired: true,
      permission: 'workspace_delete',
      workspaceId: state.workspaceId,
      phase: 'task_execution'
    });
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Original\n');
    assert.equal(await readFile(join(root, 'delete-me.txt'), 'utf8'), 'remove me\n');
    assert.equal(existsSync(join(root, 'created.txt')), false);

    state.permissions = { ...state.permissions, workspace_delete: 'allow' };
    const completed = await executeLocalInvocation(
      await invocationRequest(workspace),
      workspace,
      new AbortController().signal,
      () => {}
    );
    assert.equal(completed.status, 'completed');
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Original\n');
    assert.equal(existsSync(join(root, 'delete-me.txt')), true);
    assert.equal(existsSync(join(root, 'created.txt')), false);
    assert.equal(completed.workspaceExecution?.mode, 'staging_copy');
    assert.deepEqual(
      completed.workspaceExecution?.changeSet.changes.map((change) => [
        change.operation,
        'path' in change ? change.path : change.toPath
      ]).sort((left, right) => String(left[1]).localeCompare(String(right[1]))),
      [['update', 'README.md'], ['create', 'created.txt'], ['delete', 'delete-me.txt']]
        .sort((left, right) => left[1].localeCompare(right[1]))
    );
    const update = completed.workspaceExecution?.changeSet.changes.find(
      (change) => change.operation === 'update' && change.path === 'README.md'
    );
    assert.equal(update?.operation === 'update' ? update.baseContent : undefined, '# Original\n');
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CODEX_COMMAND;
    else process.env.AGENT_RUNTIME_CODEX_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('local Runtime child receives only operational environment variables', () => {
  const environment = buildRuntimeProcessEnv({
    Path: 'C:\\tools',
    TEMP: 'C:\\temp',
    CODEX_HOME: 'C:\\codex',
    OPENAI_API_KEY: 'must-not-leak',
    DATABASE_URL: 'must-not-leak',
    AGENT_CLUSTER_SECRET_KEY: 'must-not-leak',
    UNRELATED_VALUE: 'must-not-leak'
  });

  assert.equal(environment.Path, 'C:\\tools');
  assert.equal(environment.TEMP, 'C:\\temp');
  assert.equal(environment.CODEX_HOME, 'C:\\codex');
  assert.equal(environment.AGENT_CLUSTER_EXECUTION_LOCATION, 'local');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.AGENT_CLUSTER_SECRET_KEY, undefined);
  assert.equal(environment.UNRELATED_VALUE, undefined);
});

test('Claude Code local adapter consumes stream-json and applies staged changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-source-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-fixture-'));
  const fixturePath = join(fixtureRoot, 'claude-runtime-fixture.cjs');
  const stdinPath = join(fixtureRoot, 'claude-stdin.jsonl');
  const previousCommand = process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# Original\n', 'utf8');
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.argv[2], stdin);",
      "  fs.writeFileSync(path.join(process.cwd(), 'README.md'), '# Claude changed\\n');",
      "  const output = {schemaVersion:'1.0',kind:'agent_message',messageKind:'progress',content:'claude done',targetAgentIds:[],targetAgentKeys:[],mentionedAgentIds:[],relatedTaskIds:[]};",
      "  process.stdout.write(JSON.stringify({type:'system',subtype:'init'}) + '\\n');",
      "  process.stdout.write(JSON.stringify({type:'result',subtype:'success',structured_output:output,result:JSON.stringify(output),usage:{input_tokens:12,output_tokens:7},session_id:'claude-session-test'}) + '\\n');",
      "});"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CLAUDE_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = JSON.stringify([fixturePath, stdinPath]);

    const state = await createWorkspaceState(root, 'claude-runtime-test');
    state.permissions = {
      ...state.permissions,
      command_execute: 'allow',
      workspace_write: 'allow'
    };
    const workspace = new LocalWorkspace(state);
    const result = await executeLocalInvocation(
      await invocationRequest(workspace, 'claude_code'),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.runtimeType, 'claude_code');
    assert.equal(result.output.kind, 'agent_message');
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 7);
    assert.equal(result.usage.totalTokens, 19);
    assert.equal(result.runtimeSession?.cliSessionId, 'claude-session-test');
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Original\n');
    assert.equal(result.workspaceExecution?.mode, 'staging_copy');
    const inputFrame = JSON.parse((await readFile(stdinPath, 'utf8')).trim()) as {
      type: string;
      message: { content: Array<{ text: string }> };
    };
    assert.equal(inputFrame.type, 'user');
    assert.match(inputFrame.message.content[0]?.text ?? '', /local Claude Code Runtime/);
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
    else process.env.AGENT_RUNTIME_CLAUDE_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Claude Code default arguments isolate MCP/settings and expose only authorized tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-args-'));
  const previousMaxBudget = process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD;
  try {
    delete process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD;
    await writeFile(join(root, 'README.md'), '# args\n', 'utf8');
    const state = await createWorkspaceState(root, 'claude-args');
    const workspace = new LocalWorkspace(state);
    const request = await invocationRequest(workspace, 'claude_code');
    request.plan.toolCatalog = {
      ...request.plan.toolCatalog,
      tools: [
        { name: 'read_file', description: 'read', inputSchema: {} },
        { name: 'write_file', description: 'write', inputSchema: {} },
        { name: 'run_test', description: 'test', inputSchema: {} }
      ]
    };
    const permissions = {
      ...state.permissions,
      workspace_write: 'allow' as const,
      test_execute: 'allow' as const
    };
    const args = buildClaudeArgs(request.plan, permissions);
    const tools = args[args.indexOf('--tools') + 1] ?? '';
    const settingSources = args[args.indexOf('--setting-sources') + 1];

    assert.equal(args.includes('--strict-mcp-config'), true);
    assert.equal(args.includes('--setting-sources'), true);
    assert.equal(settingSources, 'user');
    assert.equal(args.includes('--json-schema'), true);
    assert.equal(args.includes('--max-budget-usd'), false);
    assert.equal(args.includes('--bare'), false);
    assert.match(tools, /Read/);
    assert.match(tools, /Edit/);
    assert.match(tools, /Bash\(npm test\*\)/);
  } finally {
    if (previousMaxBudget === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD;
    else process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD = previousMaxBudget;
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude Code applies a per-invocation cost limit only when explicitly configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-budget-'));
  const previousMaxBudget = process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD;
  try {
    process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD = '5';
    await writeFile(join(root, 'README.md'), '# budget\n', 'utf8');
    const state = await createWorkspaceState(root, 'claude-budget');
    const workspace = new LocalWorkspace(state);
    const request = await invocationRequest(workspace, 'claude_code');
    request.plan.toolCatalog = {
      ...request.plan.toolCatalog,
      tools: [],
      decisions: []
    };
    const args = buildClaudeArgs(request.plan, state.permissions);
    const budgetIndex = args.indexOf('--max-budget-usd');

    assert.notEqual(budgetIndex, -1);
    assert.equal(args[budgetIndex + 1], '5');
  } finally {
    if (previousMaxBudget === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD;
    else process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD = previousMaxBudget;
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude Code non-zero exit surfaces the structured stdout error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-error-source-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-error-fixture-'));
  const fixturePath = join(fixtureRoot, 'claude-runtime-error-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# unchanged\n', 'utf8');
    await writeFile(fixturePath, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'assistant',error:'authentication_failed',is_api_error_message:true,message:{content:[{type:'text',text:'Not logged in · Please run /login'}]}}) + '\\n');",
      "  process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Not logged in · Please run /login'}) + '\\n');",
      "  process.exitCode = 1;",
      "});"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CLAUDE_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = JSON.stringify([fixturePath]);

    const state = await createWorkspaceState(root, 'claude-error-test');
    const workspace = new LocalWorkspace(state);
    const result = await executeLocalInvocation(
      await invocationRequest(workspace, 'claude_code'),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.message, 'Claude Code exited with code 1: Not logged in · Please run /login');
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
    else process.env.AGENT_RUNTIME_CLAUDE_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Claude Code tool-call parsing failures are retryable provider failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-tool-parse-source-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-tool-parse-fixture-'));
  const fixturePath = join(fixtureRoot, 'claude-runtime-tool-parse-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# unchanged\n', 'utf8');
    await writeFile(fixturePath, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'result',subtype:'error',is_error:true,result:\"The model's tool call could not be parsed (retry also failed).\"}) + '\\n');",
      "  process.exitCode = 1;",
      "});"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CLAUDE_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = JSON.stringify([fixturePath]);

    const state = await createWorkspaceState(root, 'claude-tool-parse-test');
    const workspace = new LocalWorkspace(state);
    const result = await executeLocalInvocation(
      await invocationRequest(workspace, 'claude_code'),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MODEL_ERROR');
    assert.equal(result.error?.message, 'Claude Code could not parse a model tool call after retry.');
    assert.equal(result.error?.retryable, true);
    assert.equal(result.error?.details?.providerFailure, true);
    assert.equal(result.error?.details?.failureKind, 'tool_call_parse');
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
    else process.env.AGENT_RUNTIME_CLAUDE_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Claude Code format mismatch is a permanent provider configuration failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-format-source-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-claude-format-fixture-'));
  const fixturePath = join(fixtureRoot, 'claude-runtime-format-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# unchanged\n', 'utf8');
    await writeFile(fixturePath, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const text = \"API Error: 400 Format mismatch: Request appears to be in format ['claude_chat'], but only [['openai_chat', 'openai_responses']] is allowed. (request id: private-request-id)\";",
      "  process.stdout.write(JSON.stringify({type:'assistant',error:'api_error',is_api_error_message:true,message:{content:[{type:'text',text}]}}) + '\\n');",
      "  process.exitCode = 1;",
      "});"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CLAUDE_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = JSON.stringify([fixturePath]);

    const state = await createWorkspaceState(root, 'claude-format-test');
    const workspace = new LocalWorkspace(state);
    const result = await executeLocalInvocation(
      await invocationRequest(workspace, 'claude_code'),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MODEL_ERROR');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.error?.details?.providerFailure, true);
    assert.equal(result.error?.details?.httpStatus, 400);
    assert.equal(result.error?.details?.failureKind, 'provider_format_mismatch');
    assert.doesNotMatch(result.error?.message ?? '', /private-request-id/);
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_COMMAND;
    else process.env.AGENT_RUNTIME_CLAUDE_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Claude Code local Runtime can be disabled explicitly', async () => {
  const previous = process.env.AGENT_RUNTIME_CLAUDE_ENABLED;
  try {
    process.env.AGENT_RUNTIME_CLAUDE_ENABLED = 'false';
    assert.equal(await new ClaudeCodeLocalRuntimeAdapter().detectVersion(), undefined);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUNTIME_CLAUDE_ENABLED;
    else process.env.AGENT_RUNTIME_CLAUDE_ENABLED = previous;
  }
});

test('ChangeSet captures extensionless and non-JavaScript UTF-8 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-text-types-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-text-fixture-'));
  const fixturePath = join(fixtureRoot, 'runtime-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CODEX_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
  try {
    await writeFile(join(root, 'script.py'), 'print("old")\n', 'utf8');
    await writeFile(join(root, 'Dockerfile'), 'FROM node:20\n', 'utf8');
    await writeFile(join(root, 'Makefile'), 'test:\n\t@echo old\n', 'utf8');
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'script.py'), 'print(\"new\")\\n');",
      "fs.writeFileSync(path.join(process.cwd(), 'Dockerfile'), 'FROM node:22\\n');",
      "fs.writeFileSync(path.join(process.cwd(), 'Makefile'), 'test:\\n\\t@echo new\\n');",
      "fs.writeFileSync(path.join(process.cwd(), 'main.go'), 'package main\\n');",
      "process.stdout.write(JSON.stringify({schemaVersion:'1.0',kind:'agent_message',messageKind:'progress',content:'done',targetAgentIds:[],targetAgentKeys:[],mentionedAgentIds:[],relatedTaskIds:[]}) + '\\n');"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CODEX_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = JSON.stringify([fixturePath]);

    const state = await createWorkspaceState(root, 'text-types');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);
    const result = await executeLocalInvocation(
      await invocationRequest(workspace),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'completed');
    assert.equal(await readFile(join(root, 'script.py'), 'utf8'), 'print("old")\n');
    assert.equal(await readFile(join(root, 'Dockerfile'), 'utf8'), 'FROM node:20\n');
    assert.equal(await readFile(join(root, 'Makefile'), 'utf8'), 'test:\n\t@echo old\n');
    assert.equal(existsSync(join(root, 'main.go')), false);
    assert.deepEqual(
      result.systemEvidence.workspaceChangeSet?.changes.map((change) =>
        change.operation === 'move' ? change.toPath : change.path
      ).sort(),
      ['Dockerfile', 'Makefile', 'main.go', 'script.py']
    );
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CODEX_COMMAND;
    else process.env.AGENT_RUNTIME_CODEX_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('changed binary files fail explicitly and are not written back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-binary-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-binary-fixture-'));
  const fixturePath = join(fixtureRoot, 'runtime-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CODEX_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
  try {
    await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1, 2]));
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'asset.bin'), Buffer.from([0, 9, 2]));",
      "process.stdout.write(JSON.stringify({schemaVersion:'1.0',kind:'agent_message',messageKind:'progress',content:'done',targetAgentIds:[],targetAgentKeys:[],mentionedAgentIds:[],relatedTaskIds:[]}) + '\\n');"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CODEX_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = JSON.stringify([fixturePath]);
    const state = await createWorkspaceState(root, 'binary-change');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);

    const result = await executeLocalInvocation(
      await invocationRequest(workspace),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /LOCAL_CHANGESET_UNSUPPORTED_FILE: asset\.bin: file contains binary data/);
    assert.deepEqual(await readFile(join(root, 'asset.bin')), Buffer.from([0, 1, 2]));
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CODEX_COMMAND;
    else process.env.AGENT_RUNTIME_CODEX_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('platform and CLI permission policies use the stricter decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-permissions-'));
  try {
    await writeFile(join(root, 'README.md'), '# permissions\n', 'utf8');
    const state = await createWorkspaceState(root, 'permissions');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);
    const request = await invocationRequest(workspace);
    request.permissions = { ...request.permissions, command_execute: 'deny' };

    const result = await executeLocalInvocation(request, workspace, new AbortController().signal, () => {});
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /LOCAL_PERMISSION_DENIED: command_execute/);

    assert.equal(intersectPermissionPolicies(
      { ...state.permissions, dependency_install: 'allow' },
      { ...state.permissions, dependency_install: 'confirm' }
    ).dependency_install, 'confirm');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new oversized files fail explicitly instead of disappearing from the ChangeSet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-large-file-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-large-file-fixture-'));
  const fixturePath = join(fixtureRoot, 'runtime-fixture.cjs');
  const previousCommand = process.env.AGENT_RUNTIME_CODEX_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
  try {
    await writeFile(join(root, 'README.md'), '# large file\n', 'utf8');
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'large.txt'), 'x'.repeat(1000001));",
      "process.stdout.write(JSON.stringify({schemaVersion:'1.0',kind:'agent_message',messageKind:'progress',content:'done',targetAgentIds:[],targetAgentKeys:[],mentionedAgentIds:[],relatedTaskIds:[]}) + '\\n');"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CODEX_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = JSON.stringify([fixturePath]);
    const state = await createWorkspaceState(root, 'large-file');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);

    const result = await executeLocalInvocation(
      await invocationRequest(workspace),
      workspace,
      new AbortController().signal,
      () => {}
    );

    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /LOCAL_CHANGESET_UNSUPPORTED_FILE: large\.txt: file exceeds 1000000 bytes/);
    assert.equal(existsSync(join(root, 'large.txt')), false);
  } finally {
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CODEX_COMMAND;
    else process.env.AGENT_RUNTIME_CODEX_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('aborting a local Runtime terminates its descendant process tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-process-tree-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-process-tree-fixture-'));
  const fixturePath = join(fixtureRoot, 'runtime-fixture.cjs');
  const pidPath = join(fixtureRoot, 'descendant.pid');
  const previousCommand = process.env.AGENT_RUNTIME_CODEX_COMMAND;
  const previousArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
  let descendantPid: number | undefined;
  try {
    await writeFile(join(root, 'README.md'), '# process tree\n', 'utf8');
    await writeFile(fixturePath, [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[2], String(descendant.pid));",
      "setInterval(() => {}, 1000);"
    ].join('\n'), 'utf8');
    process.env.AGENT_RUNTIME_CODEX_COMMAND = process.execPath;
    process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = JSON.stringify([fixturePath, pidPath]);
    const state = await createWorkspaceState(root, 'process-tree');
    state.permissions = { ...state.permissions, command_execute: 'allow' };
    const workspace = new LocalWorkspace(state);
    const controller = new AbortController();
    const running = executeLocalInvocation(
      await invocationRequest(workspace),
      workspace,
      controller.signal,
      () => {}
    );

    await waitFor(() => existsSync(pidPath));
    descendantPid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processExists(descendantPid), true);
    controller.abort(new Error('disconnect test'));

    const result = await running;
    assert.equal(result.status, 'cancelled');
    await waitFor(() => !processExists(descendantPid!), 8_000);
    assert.equal(processExists(descendantPid), false);
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already exited */ }
    }
    if (previousCommand === undefined) delete process.env.AGENT_RUNTIME_CODEX_COMMAND;
    else process.env.AGENT_RUNTIME_CODEX_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.AGENT_RUNTIME_CODEX_ARGS_JSON;
    else process.env.AGENT_RUNTIME_CODEX_ARGS_JSON = previousArgs;
    await rm(root, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function invocationRequest(
  workspace: LocalWorkspace,
  runtimeType: 'codex' | 'claude_code' = 'codex'
): Promise<LocalRuntimeInvocationRequest> {
  const workspaceRevision = await workspace.revision();
  const plan = {
    invocationId: `invocation-${workspaceRevision.id.slice(0, 12)}`,
    sessionId: 'session-local-staging',
    phase: 'task_execution',
    agent: { name: 'Local Agent' },
    executionTarget: {
      runtimeType,
      executionLocation: 'local',
      workspaceProviderKind: 'local_bridge',
      requiredCapabilities: ['read', 'write', 'command'],
      writeMode: 'propose_changes'
    },
    contextEnvelope: {},
    toolCatalog: { decisions: [] },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' }
  } as unknown as InvocationPlan;
  return {
    plan,
    workspaceId: workspace.state.workspaceId,
    workspaceRevision,
    permissions: workspace.state.permissions
  };
}
