import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8');

function block(name: string, next: string) {
  const start = source.indexOf(`export type ${name}`);
  const end = source.indexOf(`export type ${next}`, start + 1);
  assert.ok(start >= 0, `${name} is missing`);
  assert.ok(end > start, `${name} boundary is missing`);
  return source.slice(start, end);
}

test('L0 is an authority layer rather than only a Workspace identity', () => {
  const l0 = block('ContextL0Authority', 'ContextL1Task');
  assert.match(l0, /systemRules: string\[\]/);
  assert.match(l0, /workspace: ContextWorkspaceIdentity/);
});

test('L0 records immutable Agent profile identity refs', () => {
  const l0 = block('ContextL0Authority', 'ContextL1Task');
  assert.match(l0, /agentId: UUID/);
  assert.match(l0, /profileHash: string/);
  assert.match(l0, /profileRevision: number/);
});

test('L0 records Tool Authority by stable Catalog hash', () => {
  const l0 = block('ContextL0Authority', 'ContextL1Task');
  assert.match(l0, /toolCatalogHash: string/);
});

test('L1 carries the Session goal and current phase', () => {
  const l1 = block('ContextL1Invocation', 'ContextL2ProjectMapModule');
  assert.match(l1, /sessionGoal: string/);
  assert.match(l1, /phase: AgentRunPhase/);
});

test('L1 carries a bounded current Task contract', () => {
  const task = block('ContextL1Task', 'ContextL1Invocation');
  assert.match(task, /title: string/);
  assert.match(task, /description: string/);
  assert.match(task, /acceptanceCriteria: string\[\]/);
});

test('L1 keeps Workspace navigation under one nested field', () => {
  const l1 = block('ContextL1Invocation', 'ContextL2ProjectMapModule');
  assert.match(l1, /navigation: ContextL1NavigationManifest/);
});

test('ContextEnvelopeV2 uses the authoritative L0 and invocation L1 contracts', () => {
  const envelope = block('ContextEnvelopeV2', 'WorkspaceIndexEntryKind');
  assert.match(envelope, /L0: ContextL0Authority/);
  assert.match(envelope, /L1: ContextL1Invocation/);
});

test('Envelope authority layers cannot contain Runtime or Model selection', () => {
  const start = source.indexOf('export type ContextL0Authority');
  const end = source.indexOf('export type ContextL2ProjectMapModule', start);
  const authority = source.slice(start, end);
  assert.doesNotMatch(authority, /runtimeType|modelId|executionTarget|runtimeSelection/);
});

test('L3 remains the only layer that carries selected source bodies', () => {
  const l3 = block('ContextL3SelectedEvidence', 'ContextL4ToolCall');
  assert.match(l3, /files: ContextL3EvidenceFile\[\]/);
  assert.match(l3, /totalByteLength: number/);
  assert.match(l3, /truncated: boolean/);
});
