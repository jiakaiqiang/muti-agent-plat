import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const adapterFiles = [
  'runtime.service.ts',
  'mock-runtime.service.ts',
  'generic-llm-runtime.service.ts',
  'code-reader-runtime-adapter.service.ts',
  'test-runner-runtime-adapter.service.ts',
  'codex-runtime-adapter.service.ts',
  'claude-code-runtime-adapter.service.ts',
  'streaming/codex-streaming-runner.ts',
  'streaming/claude-streaming-runner.ts'
];

function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

test('every Runtime implementation removes the legacy AgentRunInput type', () => {
  for (const file of adapterFiles) assert.doesNotMatch(read(file), /AgentRunInput/, file);
});

test('every Runtime implementation removes ContextAssembly access', () => {
  for (const file of adapterFiles) assert.doesNotMatch(read(file), /contextAssembly/, file);
});

test('RuntimeService dispatches by final executionTarget', () => {
  const source = read('runtime.service.ts');
  assert.match(source, /executionTarget\.runtimeType/);
  assert.doesNotMatch(source, /agent\.runtimeType/);
});

test('RuntimeService audit uses invocationId as the canonical run identifier', () => {
  const source = read('runtime.service.ts');
  assert.match(source, /input\.invocationId/);
  assert.doesNotMatch(source, /input\.runId/);
});

test('Runtime adapters use agentId instead of a legacy identity id alias', () => {
  for (const file of adapterFiles) assert.doesNotMatch(read(file), /input\.agent\.id\b/, file);
});

test('Runtime model selection comes only from executionTarget', () => {
  for (const file of adapterFiles) assert.doesNotMatch(read(file), /input\.agent\.modelId/, file);
});

test('Generic LLM exposes only the resolved Tool Catalog', () => {
  const source = read('generic-llm-runtime.service.ts');
  assert.match(source, /input\.toolCatalog\.tools/);
  assert.doesNotMatch(source, /availableTools/);
});

test('CLI streaming runners accept InvocationPlan', () => {
  assert.match(read('streaming/codex-streaming-runner.ts'), /InvocationPlan/);
  assert.match(read('streaming/claude-streaming-runner.ts'), /InvocationPlan/);
});

test('Runtime result events do not derive legacy runId from input.runId', () => {
  for (const file of adapterFiles.slice(1)) assert.doesNotMatch(read(file), /runId:\s*input\.runId/, file);
});

test('Runtime boundary never reconstructs Runtime selection on Agent identity', () => {
  for (const file of adapterFiles) {
    assert.doesNotMatch(read(file), /agent:\s*\{[^}]*runtimeType/s, file);
    assert.doesNotMatch(read(file), /configuredRuntimeType|runtimeSelection/, file);
  }
});
