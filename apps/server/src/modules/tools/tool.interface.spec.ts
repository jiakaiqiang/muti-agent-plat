import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool, ToolCategory, ToolExecutionContext, ToolResult } from './tool.interface.js';
import { toWorkspaceToolDescriptor } from './tool.interface.js';

const schema = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' }
  },
  required: ['path']
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'read_file',
    description: 'Read a file',
    category: 'file',
    riskLevel: 'low',
    inputSchema: schema,
    async execute() {
      return { success: true, output: { path: 'README.md' } };
    },
    ...overrides
  };
}

test('toWorkspaceToolDescriptor keeps the tool name', () => {
  assert.equal(toWorkspaceToolDescriptor(makeTool()).name, 'read_file');
});

test('toWorkspaceToolDescriptor keeps the description', () => {
  assert.equal(toWorkspaceToolDescriptor(makeTool()).description, 'Read a file');
});

test('toWorkspaceToolDescriptor keeps the exact input schema object', () => {
  assert.equal(toWorkspaceToolDescriptor(makeTool()).inputSchema, schema);
});

test('toWorkspaceToolDescriptor does not expose internal execution fields', () => {
  const descriptor = toWorkspaceToolDescriptor(makeTool()) as Record<string, unknown>;

  assert.equal('execute' in descriptor, false);
  assert.equal('riskLevel' in descriptor, false);
  assert.equal('category' in descriptor, false);
});

test('ToolCategory supports the planned built-in categories', () => {
  const categories: ToolCategory[] = ['file', 'code', 'test', 'db', 'network', 'custom'];

  assert.equal(categories.length, 6);
});

test('ToolExecutionContext carries runtime invocation context', () => {
  const controller = new AbortController();
  const context: ToolExecutionContext = {
    workingDirectory: 'D:/workspace',
    sessionId: 'session-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    signal: controller.signal
  };

  assert.equal(context.workingDirectory, 'D:/workspace');
  assert.equal(context.signal, controller.signal);
});

test('ToolResult represents successful tool output with metadata', () => {
  const result: ToolResult = {
    success: true,
    output: { lineCount: 10 },
    metadata: { cached: false }
  };

  assert.equal(result.success, true);
  assert.deepEqual(result.metadata, { cached: false });
});

test('ToolResult represents failed tool output with an error', () => {
  const result: ToolResult = {
    success: false,
    output: null,
    error: 'File not found'
  };

  assert.equal(result.success, false);
  assert.equal(result.error, 'File not found');
});

test('Tool execute returns a ToolResult promise', async () => {
  const result = await makeTool().execute({ path: 'README.md' }, {
    workingDirectory: 'D:/workspace',
    sessionId: 'session-1'
  });

  assert.equal(result.success, true);
});
