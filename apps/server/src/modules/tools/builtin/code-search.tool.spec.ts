import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeSearchTool, type CodeSearchOutput } from './code-search.tool.js';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'code-search-tool-'));
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(
      join(workspace, 'src', 'index.ts'),
      ['export function main() {', '  console.log("Hello");', '}', 'const tokenName = "visible";'].join('\n'),
      'utf8'
    );
    await writeFile(join(workspace, 'src', 'helper.ts'), 'export const helper = () => console.log("helper");\n', 'utf8');
    await writeFile(join(workspace, 'README.md'), '# Hello\nconsole.log appears in docs\n', 'utf8');
    await writeFile(join(workspace, 'package.json'), '{"name":"sample"}\n', 'utf8');
    await writeFile(join(workspace, '.env'), 'SECRET_TOKEN=hidden\n', 'utf8');
    await writeFile(join(workspace, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function output(result: { output: unknown }): CodeSearchOutput {
  return result.output as CodeSearchOutput;
}

test('exposes stable code search metadata', () => {
  const tool = new CodeSearchTool();

  assert.equal(tool.name, 'search_code');
  assert.equal(tool.category, 'code');
  assert.equal(tool.riskLevel, 'low');
  assert.deepEqual(tool.inputSchema.required, ['pattern']);
  assert.equal((tool.inputSchema.properties.pattern as { type: string }).type, 'string');
});

test('finds matching file, line number, content, and match text', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: 'console\\.log', filePattern: 'src/' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    const first = output(result).results[0];
    assert.equal(first.file, 'src/helper.ts');
    assert.equal(first.line, 1);
    assert.equal(first.content, 'export const helper = () => console.log("helper");');
    assert.equal(first.match, 'console.log');
  });
});

test('searches case-insensitively by default', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: 'hello', filePattern: '*.ts' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).totalMatches, 1);
    assert.equal(output(result).results[0]?.match, 'Hello');
  });
});

test('respects caseSensitive searches', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute(
      { pattern: 'hello', caseSensitive: true, filePattern: '*.ts' },
      { workingDirectory: workspace, sessionId: 's1' }
    );

    assert.equal(result.success, true);
    assert.equal(output(result).totalMatches, 0);
  });
});

test('filters files with simple glob patterns', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: 'console\\.log', filePattern: '*.md' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).totalFiles, 1);
    assert.deepEqual(
      output(result).results.map((match) => match.file),
      ['README.md']
    );
  });
});

test('limits returned matches with maxResults', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: 'console\\.log', maxResults: 2 }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).results.length, 2);
    assert.equal(output(result).totalMatches, 2);
    assert.equal(output(result).limited, true);
  });
});

test('returns failure for invalid regex patterns', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: '[' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Invalid regular expression|Unterminated/);
  });
});

test('skips sensitive and non-text files', async () => {
  await withWorkspace(async (workspace) => {
    const tool = new CodeSearchTool();

    const result = await tool.execute({ pattern: 'SECRET_TOKEN|\\u0001' }, { workingDirectory: workspace, sessionId: 's1' });

    assert.equal(result.success, true);
    assert.equal(output(result).results.length, 0);
    assert.equal(output(result).skipped.some((item) => item.path === '.env' && item.reason === 'sensitive'), true);
    assert.equal(output(result).skipped.some((item) => item.path === 'image.bin' && item.reason === 'binary'), true);
  });
});

test('rejects invalid params before scanning', async () => {
  const tool = new CodeSearchTool();

  const result = await tool.execute({ pattern: '' }, { workingDirectory: 'D:/workspace', sessionId: 's1' });

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /pattern/);
});
