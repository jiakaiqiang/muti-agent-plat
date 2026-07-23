import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function readTree(path, extensions = new Set(['.ts', '.vue', '.mjs'])) {
  const absolute = resolve(root, path);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) return readTree(child, extensions);
      return extensions.has(extname(entry.name)) ? [readFileSync(child, 'utf8')] : [];
    })
    .join('\n');
}

function readFiles(path, extensions = new Set(['.ts', '.vue', '.mjs'])) {
  const absolute = resolve(root, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return readFiles(child, extensions);
    return extensions.has(extname(entry.name))
      ? [{ path: child.slice(root.length + 1), source: readFileSync(child, 'utf8') }]
      : [];
  });
}

test('shared contracts expose ContextAssembly and no ContextPack', () => {
  const source = read('packages/shared/src/contracts.ts');
  assert.match(source, /export type ContextAssembly/);
  assert.doesNotMatch(source, /ContextPack|contextPack/);
});

test('server context budgeting and Orchestrator use ContextAssembly names only', () => {
  const source = [
    read('apps/server/src/common/token.ts'),
    read('apps/server/src/modules/orchestrator/orchestrator.service.ts')
  ].join('\n');
  assert.doesNotMatch(source, /ContextPack|contextPack/);
});

test('context conversion is named from ContextAssembly', () => {
  assert.equal(existsSync(resolve(root, 'apps/server/src/modules/context-v2/build-envelope-from-context-pack.ts')), false);
  assert.equal(existsSync(resolve(root, 'apps/server/src/modules/context-v2/build-envelope-from-context-assembly.ts')), true);
});

test('Debug API exposes context-envelopes instead of context-packs', () => {
  const source = read('apps/server/src/modules/debug/debug.controller.ts');
  assert.match(source, /context-envelopes/);
  assert.doesNotMatch(source, /context-packs|contextPacks|ContextPack|contextAssembl/i);
});

test('active Web views contain no ContextPack vocabulary', () => {
  assert.doesNotMatch(readTree('apps/web/src', new Set(['.ts', '.vue'])), /ContextPack|contextPack|Context Pack/);
});

test('Runtime result and event contracts use invocationId instead of runId', () => {
  const source = read('packages/shared/src/contracts.ts');
  const block = source.slice(source.indexOf('export type AgentRuntimeEvent'), source.indexOf('export type RuntimeOutput'));
  const adapter = source.slice(source.indexOf('export type AgentRuntimeAdapter'));
  assert.match(block, /invocationId: UUID/);
  assert.doesNotMatch(block, /runId|@deprecated/);
  assert.match(adapter, /start\(input: InvocationPlan/);
  assert.doesNotMatch(adapter, /\brun\(|\bstream\(|start\?:/);
});

test('Runtime streaming implementation uses invocationId consistently', () => {
  assert.doesNotMatch(readTree('apps/server/src/modules/runtimes/streaming'), /runId/);
});

test('Orchestrator invocation flow contains no Runtime runId alias', () => {
  assert.doesNotMatch(read('apps/server/src/modules/orchestrator/orchestrator.service.ts'), /\brunId\b/);
});

test('shared output contract has only task_acceptance_decision', () => {
  const source = [
    read('packages/shared/src/contracts.ts'),
    read('packages/shared/src/runtime-contracts/contract-types.ts'),
    read('packages/shared/src/runtime-contracts/output-contracts.ts')
  ].join('\n');
  assert.match(source, /task_acceptance_decision/);
  assert.doesNotMatch(source, /TaskClaimDecisionOutput|task_claim_decision/);
});

test('Orchestrator emits one acceptance decision without a claim compatibility payload', () => {
  const source = read('apps/server/src/modules/orchestrator/orchestrator.service.ts');
  assert.doesNotMatch(source, /legacyClaimDecision|acceptanceDecisionToLegacyClaimDecision|claimDecision:|TaskClaimDecisionOutput|task_claim_decision/);
});

test('Runtime adapters and output mappers contain no claim decision compatibility', () => {
  assert.doesNotMatch(readTree('apps/server/src/modules/runtimes'), /TaskClaimDecisionOutput|task_claim_decision|legacy task_claim/);
});

test('Web workflow views contain no claim decision phase', () => {
  const source = [
    read('apps/web/src/components/ChatTimeline.vue'),
    read('apps/web/src/components/CollaborationGraphView.vue'),
    read('apps/web/src/components/WorkflowRuntimeView.vue')
  ].join('\n');
  assert.doesNotMatch(source, /task_claim_decision/);
});

test('E2E sources use context envelopes and acceptance decisions only', () => {
  const source = readTree('tests/e2e', new Set(['.mjs', '.ts']));
  assert.doesNotMatch(
    source,
    /debug\/context-packs|task_claim_decision|TaskClaimDecisionOutput|contextAssembly|claimDecision|assignedByAgentId|assigneeAgentId|previousAssigneeAgentId/
  );
});

test('RuntimeOutput fixtures do not reintroduce schemaVersion 0.1', () => {
  for (const file of readFiles('tests/e2e', new Set(['.mjs', '.ts']))) {
    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/schemaVersion\s*:\s*['"]0\.1['"]/.test(line)) return;
      const outputWindow = lines.slice(Math.max(0, index - 8), index + 9).join('\n');
      assert.doesNotMatch(
        outputWindow,
        /kind\s*:\s*['"](?:agent_message|task_acceptance_decision|task_brief|task_execution_result|post_review_report|final_delivery|user_message_handling_plan)['"]/,
        `${file.path} contains a RuntimeOutput 0.1 fixture near line ${index + 1}`
      );
    });
  }
});

test('completion E2E flows explicitly select a published workflow after brief confirmation', () => {
  for (const file of readFiles('tests/e2e', new Set(['.mjs', '.ts']))) {
    const confirmsBrief = /\/briefs\/[^\s`'"]+\/confirm|confirmBrief/.test(file.source);
    const expectsCompletion = /['"]COMPLETED['"]/.test(file.source);
    if (!confirmsBrief || !expectsCompletion) continue;
    assert.match(
      file.source,
      /workflow\/select|confirmBriefAndSelectWorkflow|selectPublishedWorkflow|selectWorkflow/,
      `${file.path} confirms a brief and expects completion without selecting a workflow`
    );
  }
});

test('active task contracts use ActorRef fields without legacy task Agent ids', () => {
  const source = [
    read('packages/shared/src/contracts.ts'),
    readTree('apps/server/src', new Set(['.ts'])),
    readTree('apps/web/src', new Set(['.ts', '.vue'])),
    read('docs/contracts/api-contract-v0.1.md'),
    read('docs/contracts/event-contract-v0.1.md'),
    read('docs/contracts/ui-state-contract-v0.1.md')
  ].join('\n');
  assert.doesNotMatch(source, /assignedByAgentId|assigneeAgentId|previousAssigneeAgentId/);
});

test('root scripts expose acceptance terminology and no task-claim command', () => {
  const source = read('package.json');
  assert.match(source, /test:e2e:task-acceptance-decision/);
  assert.match(source, /test:e2e:task-acceptance-fallback/);
  assert.doesNotMatch(source, /test:e2e:task-claim/);
});
