import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('shared Runtime metadata declares workspace capabilities', () => {
  assert.match(read('packages/shared/src/contracts.ts'), /supportedWorkspaceCapabilities: readonly WorkspaceCapabilityKey\[\]/);
});

test('shared Runtime metadata declares supported Tool names', () => {
  assert.match(read('packages/shared/src/contracts.ts'), /supportedToolNames: readonly string\[\]/);
});

test('InvocationResolver derives candidates from RuntimeRegistry', () => {
  const source = read('apps/server/src/modules/runtime-routing/invocation-resolver.service.ts');
  assert.match(source, /runtimeRegistry\.listAll\(\)/);
  assert.doesNotMatch(source.slice(source.indexOf('export type ResolveInvocationInput'), source.indexOf('export class InvocationResolutionError')), /runtimeCandidates/);
});

test('Orchestrator contains no hard-coded Runtime capability matrix', () => {
  const source = read('apps/server/src/modules/orchestrator/orchestrator.service.ts');
  assert.doesNotMatch(source, /invocationRuntimeCandidates|runtimeCandidates:|supportedWorkspaceCapabilities|supportedToolNames/);
});

for (const [name, path] of [
  ['Codex', 'apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts'],
  ['Claude Code', 'apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts'],
  ['Generic LLM', 'apps/server/src/modules/runtimes/generic-llm-runtime.service.ts'],
  ['Code Reader', 'apps/server/src/modules/runtimes/code-reader-runtime-adapter.service.ts'],
  ['Test Runner', 'apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.ts'],
  ['Mock', 'apps/server/src/modules/runtimes/mock-runtime.service.ts']
]) {
  test(`${name} Adapter declares routing capabilities in metadata`, () => {
    const source = read(path);
    assert.match(source, /readonly metadata =/);
    assert.match(source, /supportedWorkspaceCapabilities:/);
    assert.match(source, /supportedToolNames:/);
  });
}
