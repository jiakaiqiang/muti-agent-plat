import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./contracts.ts', import.meta.url)), 'utf8');

function typeBlock(name: string): string {
  const marker = `export type ${name} = {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 2);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test('AgentDefinition owns identity fields and profileRevision', () => {
  const block = typeBlock('AgentDefinition');
  assert.match(block, /profileMarkdown: string/);
  assert.match(block, /profileRevision: number/);
  assert.match(block, /capabilityIds: UUID\[\]/);
});

test('AgentDefinition does not own runtime, model, or materialized skillIds', () => {
  const block = typeBlock('AgentDefinition');
  assert.doesNotMatch(block, /runtimeType|modelId|runtimeSelection|skillIds/);
});

test('CompiledAgentIdentity is runtime-independent and carries a profile hash', () => {
  const block = typeBlock('CompiledAgentIdentity');
  assert.match(block, /profileHash: string/);
  assert.match(block, /systemPrompt: string/);
  assert.doesNotMatch(block, /runtimeType|modelId|runtimeSelection/);
});

test('CompiledAgentIdentity snapshots skill bindings and requested tools', () => {
  const block = typeBlock('CompiledAgentIdentity');
  assert.match(block, /skillBindings: SkillBindingSnapshot\[\]/);
  assert.match(block, /requestedToolIds: UUID\[\]/);
  assert.match(block, /requestedToolKeys: string\[\]/);
});

test('ResolvedToolCatalog carries deterministic tool decisions and hash', () => {
  const block = typeBlock('ResolvedToolCatalog');
  assert.match(block, /tools: WorkspaceToolDescriptor\[\]/);
  assert.match(block, /decisions: ToolAuthorityDecision\[\]/);
  assert.match(block, /catalogHash: string/);
});

test('ToolAuthorityDecision records allowed or blocked reasons and optional approval', () => {
  const block = typeBlock('ToolAuthorityDecision');
  assert.match(block, /status: 'allowed' \| 'blocked'/);
  assert.match(block, /reasons: string\[\]/);
  assert.match(block, /approvalId\?: UUID/);
});

test('RuntimePreference replaces fixed Session execution target semantics', () => {
  const block = typeBlock('RuntimePreference');
  assert.match(block, /preferredRuntimeType\?: RuntimeType/);
  assert.match(block, /preferredModelId\?: string/);
  assert.match(block, /allowedRuntimeTypes\?: RuntimeType\[\]/);
});

test('SessionDetail only exposes runtimePreference for runtime routing input', () => {
  const block = typeBlock('SessionDetail');
  assert.match(block, /runtimePreference\?: RuntimePreference/);
  assert.doesNotMatch(block, /contextPipelineVersion|engineeringRuntime|executionTarget/);
});

test('ResolvedExecutionTarget records required tools and workspace provider kind', () => {
  const block = typeBlock('ResolvedExecutionTarget');
  assert.match(block, /requiredToolIds: readonly UUID\[\]/);
  assert.match(block, /workspaceProviderKind: WorkspaceProviderKind/);
});

test('InvocationPlan requires identity, target, catalog, and ContextEnvelopeV2', () => {
  const block = typeBlock('InvocationPlan');
  assert.match(block, /agent: CompiledAgentIdentity/);
  assert.match(block, /executionTarget: ResolvedExecutionTarget/);
  assert.match(block, /toolCatalog: ResolvedToolCatalog/);
  assert.match(block, /contextEnvelope: ContextEnvelopeV2/);
});

test('SystemDataMetadata records schema version, data epoch, and cutover audit', () => {
  const block = typeBlock('SystemDataMetadata');
  assert.match(block, /dataSchemaVersion: 3/);
  assert.match(block, /dataEpoch: UUID/);
  assert.match(block, /pipelineVersion: 'v2'/);
  assert.match(block, /cutoverAuditId: UUID/);
});

test('legacy runtime selection and RuntimeAgentProfile contracts are removed', () => {
  assert.doesNotMatch(source, /export type EngineeringRuntimeSelection/);
  assert.doesNotMatch(source, /export type EngineeringRuntimeConfig/);
  assert.doesNotMatch(source, /export type RuntimeAgentProfile/);
  assert.doesNotMatch(source, /'agent_override'/);
});
