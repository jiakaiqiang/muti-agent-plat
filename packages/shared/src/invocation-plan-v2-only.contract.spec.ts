import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8');

function block(name: string, nextExport: string) {
  const start = source.indexOf(`export type ${name}`);
  const end = source.indexOf(`export type ${nextExport}`, start + 1);
  assert.ok(start >= 0, `${name} contract is missing`);
  assert.ok(end > start, `${name} contract boundary is missing`);
  return source.slice(start, end);
}

test('AgentRuntimeAdapter requires start with InvocationPlan', () => {
  const adapter = source.slice(source.indexOf('export type AgentRuntimeAdapter'));
  assert.match(adapter, /start\(input: InvocationPlan/);
  assert.doesNotMatch(adapter, /AgentRunInput/);
});

test('AgentRuntimeAdapter exposes no second run or stream protocol', () => {
  const adapter = source.slice(source.indexOf('export type AgentRuntimeAdapter'));
  assert.doesNotMatch(adapter, /\brun\(|\bstream\(|start\?:|cancel\??:/);
});

test('InvocationPlan requires one authoritative ContextEnvelopeV2', () => {
  const plan = block('InvocationPlan', 'ValidationVerdictStatus');
  assert.match(plan, /contextEnvelope: ContextEnvelopeV2/);
  assert.doesNotMatch(plan, /contextEnvelope\?:/);
});

test('InvocationPlan keeps identity, target, and Tool Catalog as separate snapshots', () => {
  const plan = block('InvocationPlan', 'ValidationVerdictStatus');
  assert.match(plan, /agent: CompiledAgentIdentity/);
  assert.match(plan, /executionTarget: ResolvedExecutionTarget/);
  assert.match(plan, /toolCatalog: ResolvedToolCatalog/);
});

test('InvocationPlan does not expose legacy ContextAssembly or Workspace duplicate fields', () => {
  const plan = block('InvocationPlan', 'ValidationVerdictStatus');
  assert.doesNotMatch(
    plan,
    /ContextAssembly|workspaceSnapshot|workspaceManifest|selectedEvidenceContents|projectMap|runtimeSelection/
  );
});

test('legacy AgentRunInput contract is removed', () => {
  assert.doesNotMatch(source, /export type AgentRunInput\s*=/);
});

test('RuntimeInvocationProfileSnapshot remains identity-only', () => {
  const snapshot = block('RuntimeInvocationProfileSnapshot', 'TaskBrief');
  assert.doesNotMatch(snapshot, /runtimeType|modelId|executionTarget|toolCatalog/);
  assert.match(snapshot, /profileHash: string/);
  assert.match(snapshot, /resolvedSkillRevisions: Record<string, number>/);
});

test('ContextEnvelopeV2 cannot carry Runtime selection', () => {
  const envelope = block('ContextEnvelopeV2', 'WorkspaceIndexEntryKind');
  assert.doesNotMatch(envelope, /runtimeType|modelId|runtimeSelection|executionTarget/);
});

test('ResolvedToolCatalog contains descriptors and decisions but no executable functions', () => {
  const catalog = block('ResolvedToolCatalog', 'RuntimeInvocationProfileSnapshot');
  assert.match(catalog, /tools: WorkspaceToolDescriptor\[\]/);
  assert.match(catalog, /decisions: ToolAuthorityDecision\[\]/);
  assert.doesNotMatch(catalog, /execute|handler|callback/);
});

test('InvocationPlan carries budget and expected output without mutable options', () => {
  const plan = block('InvocationPlan', 'ValidationVerdictStatus');
  assert.match(plan, /expectedOutput: ExpectedRuntimeOutput/);
  assert.match(plan, /budget: RuntimeBudget/);
  assert.doesNotMatch(plan, /options\??:|estimatedInputTokens/);
});

test('InvocationPlan exposes only the narrow typed Runtime resume request', () => {
  const plan = block('InvocationPlan', 'ValidationVerdictStatus');
  assert.match(plan, /resume\?: RuntimeResumeRequest/);
  assert.match(plan, /cliSessionId: string/);
  assert.match(plan, /workDir\?: string/);
  assert.doesNotMatch(plan, /options\??:/);
});
