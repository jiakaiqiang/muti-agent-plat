import test from 'node:test';
import assert from 'node:assert/strict';
import { FileReaderTool } from './file-reader.tool.js';
import type { ReadFileInput, ReadFileResult, WorkspaceToolsService } from '../../runtimes/workspace-tools.service.js';

function makeWorkspaceTools(result: ReadFileResult | Error) {
  const calls: Array<{ rootPath: string; input: ReadFileInput }> = [];
  const workspaceTools = {
    async readFile(rootPath: string, input: ReadFileInput): Promise<ReadFileResult> {
      calls.push({ rootPath, input });
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
  } as WorkspaceToolsService;

  return { workspaceTools, calls };
}

function successResult(overrides: Partial<ReadFileResult> = {}): ReadFileResult {
  return {
    ok: true,
    output: 'console.log("ok");',
    truncated: false,
    resolvedPath: 'D:/workspace/src/index.ts',
    byteLength: 18,
    ...overrides
  };
}

function failureResult(errorCode: string, errorMessage: string): ReadFileResult {
  return {
    ok: false,
    output: '',
    truncated: false,
    errorCode,
    errorMessage
  };
}

test('exposes stable file reader metadata', () => {
  const { workspaceTools } = makeWorkspaceTools(successResult());
  const tool = new FileReaderTool(workspaceTools);

  assert.equal(tool.name, 'read_file');
  assert.equal(tool.category, 'file');
  assert.equal(tool.riskLevel, 'low');
});

test('describes the path input schema', () => {
  const { workspaceTools } = makeWorkspaceTools(successResult());
  const tool = new FileReaderTool(workspaceTools);

  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.required, ['path']);
  assert.equal((tool.inputSchema.properties.path as { type: string }).type, 'string');
});

test('passes workingDirectory and path to WorkspaceToolsService', async () => {
  const { workspaceTools, calls } = makeWorkspaceTools(successResult());
  const tool = new FileReaderTool(workspaceTools);

  await tool.execute({ path: 'src/index.ts' }, { workingDirectory: 'D:/workspace', sessionId: 'session-1' });

  assert.deepEqual(calls, [{ rootPath: 'D:/workspace', input: { path: 'src/index.ts' } }]);
});

test('returns success when WorkspaceToolsService read succeeds', async () => {
  const readResult = successResult();
  const { workspaceTools } = makeWorkspaceTools(readResult);
  const tool = new FileReaderTool(workspaceTools);

  const result = await tool.execute({ path: 'src/index.ts' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, true);
  assert.equal(result.output, readResult);
  assert.equal(result.error, undefined);
});

test('keeps truncated successful read metadata in output', async () => {
  const readResult = successResult({ truncated: true, byteLength: 40000 });
  const { workspaceTools } = makeWorkspaceTools(readResult);
  const tool = new FileReaderTool(workspaceTools);

  const result = await tool.execute({ path: 'large.ts' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal((result.output as ReadFileResult).truncated, true);
  assert.equal((result.output as ReadFileResult).byteLength, 40000);
});

test('returns failure and preserves sensitive path error details', async () => {
  const readResult = failureResult('SENSITIVE_PATH', 'Refusing to read sensitive path');
  const { workspaceTools } = makeWorkspaceTools(readResult);
  const tool = new FileReaderTool(workspaceTools);

  const result = await tool.execute({ path: '.env' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.equal(result.output, readResult);
  assert.equal(result.error, 'Refusing to read sensitive path');
});

test('returns failure and preserves not found error details', async () => {
  const readResult = failureResult('NOT_FOUND', 'File not found');
  const { workspaceTools } = makeWorkspaceTools(readResult);
  const tool = new FileReaderTool(workspaceTools);

  const result = await tool.execute({ path: 'missing.ts' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.equal((result.output as ReadFileResult).errorCode, 'NOT_FOUND');
  assert.equal(result.error, 'File not found');
});

test('returns failure if WorkspaceToolsService throws unexpectedly', async () => {
  const { workspaceTools } = makeWorkspaceTools(new Error('disk unavailable'));
  const tool = new FileReaderTool(workspaceTools);

  const result = await tool.execute({ path: 'src/index.ts' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.equal(result.output, null);
  assert.equal(result.error, 'disk unavailable');
});

test('does not pass unsupported encoding to WorkspaceToolsService', async () => {
  const { workspaceTools, calls } = makeWorkspaceTools(successResult());
  const tool = new FileReaderTool(workspaceTools);

  await tool.execute(
    { path: 'README.md', encoding: 'utf-16' },
    { workingDirectory: 'D:/workspace', sessionId: 'session-1' }
  );

  assert.deepEqual(calls[0]?.input, { path: 'README.md' });
});
