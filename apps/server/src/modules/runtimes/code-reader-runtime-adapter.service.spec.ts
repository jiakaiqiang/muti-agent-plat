import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput } from '@agent-cluster/shared';
import type { Tool, ToolExecutionContext, ToolResult } from '../tools/tool.interface.js';
import { isRuntimeType, runtimeModeLabel } from '../../common/runtime-config.js';
import { CodeReaderRuntimeAdapterService } from './code-reader-runtime-adapter.service.js';

function makeReadTool(results: ToolResult[]) {
  const calls: Array<{ params: unknown; context: ToolExecutionContext }> = [];
  const tool: Tool = {
    name: 'read_file',
    description: 'Read file',
    category: 'file',
    riskLevel: 'low',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute(params, context) {
      calls.push({ params, context });
      return results[Math.min(calls.length - 1, results.length - 1)];
    }
  };
  return { tool, calls };
}

function makeRegistry(tool?: Tool) {
  return {
    getTool(name: string) {
      return name === 'read_file' ? tool : undefined;
    }
  };
}

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    phase: 'execute_task',
    agent: {
      id: 'agent-1',
      key: 'code-reader',
      name: 'Code Reader',
      role: 'reader',
      systemPrompt: '',
      runtimeType: 'code_reader',
      capabilityIds: ['cap-file-read']
    },
    contextPack: {
      workingDirectory: { path: 'D:/workspace' },
      taskContext: { targetFiles: ['src/index.ts'] }
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
    budget: { maxTokens: 1000 },
    ...overrides
  } as unknown as AgentRunInput;
}

function readSuccess(path: string, output: string): ToolResult {
  return {
    success: true,
    output: {
      ok: true,
      output,
      truncated: false,
      resolvedPath: `D:/workspace/${path}`,
      byteLength: output.length
    }
  };
}

test('code_reader is a recognized RuntimeType with a label', () => {
  assert.equal(isRuntimeType('code_reader'), true);
  assert.equal(runtimeModeLabel('code_reader'), 'Code Reader');
});

test('exposes internal self-hosted metadata', () => {
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry() as never);

  assert.equal(runtime.type, 'code_reader');
  assert.equal(runtime.metadata.category, 'internal');
  assert.equal(runtime.metadata.provider, 'self-hosted');
  assert.equal(runtime.metadata.capabilityIds.includes('cap-file-read'), true);
});

test('checkAvailability returns available', async () => {
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry() as never);

  assert.deepEqual(await runtime.checkAvailability(), { available: true });
});

test('reads target files from taskContext using ToolRegistry read_file', async () => {
  const { tool, calls } = makeReadTool([readSuccess('src/index.ts', 'console.log("ok");')]);
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry(tool) as never);
  const signal = new AbortController().signal;

  const result = await runtime.run(makeInput(), signal);

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], {
    params: { path: 'src/index.ts' },
    context: { workingDirectory: 'D:/workspace', sessionId: 'session-1', agentId: 'agent-1', signal }
  });
});

test('falls back to workspaceFocus relevantFiles when targetFiles are absent', async () => {
  const { tool, calls } = makeReadTool([readSuccess('src/fallback.ts', 'export const value = 1;')]);
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry(tool) as never);

  await runtime.run(
    makeInput({
      contextPack: {
        workingDirectory: { path: 'D:/workspace' },
        taskContext: {},
        workspaceFocus: { relevantFiles: ['src/fallback.ts'] }
      }
    } as unknown as AgentRunInput)
  );

  assert.deepEqual(calls.map((call) => call.params), [{ path: 'src/fallback.ts' }]);
});

test('summarizes successful file reads as task execution output', async () => {
  const { tool } = makeReadTool([readSuccess('src/index.ts', 'line 1\nline 2')]);
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.match(result.output.summary, /Analyzed 1 file/);
  assert.equal(result.events.some((event) => event.type === 'runtime_completed'), true);
});

test('returns failed when read_file tool is missing', async () => {
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry() as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('read_file tool not found'), true);
  assert.equal(result.events.some((event) => event.type === 'runtime_failed'), true);
});

test('returns failed when read_file tool returns failure', async () => {
  const { tool } = makeReadTool([{ success: false, output: { ok: false }, error: 'SENSITIVE_PATH' }]);
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(makeInput());

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message.includes('SENSITIVE_PATH'), true);
});

test('returns completed with zero files when no targets are present', async () => {
  const { tool, calls } = makeReadTool([readSuccess('unused.ts', 'unused')]);
  const runtime = new CodeReaderRuntimeAdapterService(makeRegistry(tool) as never);

  const result = await runtime.run(
    makeInput({
      contextPack: {
        workingDirectory: { path: 'D:/workspace' },
        taskContext: {}
      }
    } as unknown as AgentRunInput)
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.kind, 'task_execution_result');
  assert.match(result.output.summary, /Analyzed 0 files/);
  assert.equal(calls.length, 0);
});
