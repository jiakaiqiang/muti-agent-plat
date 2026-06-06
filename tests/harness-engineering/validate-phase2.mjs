#!/usr/bin/env node
// Harness Engineering — Phase 2 (Runtime Alignment) conformance validator.
//
// Phase 2 (docs/harness-engineering/README.md §14) aligns the existing
// session / orchestrator / events / artifacts with the protocols. The
// deliverable is alignment SPECS, not feature code — so this validator checks
// the alignment docs, and additionally REALITY-SYNCS them against the source:
// it parses the real SessionStatus / AgentRunPhase / ArtifactType unions from
// packages/shared/src/contracts.ts and asserts every value is documented. Add a
// new enum value in code and this test fails until the alignment doc catches up.
//
// Usage: node tests/harness-engineering/validate-phase2.mjs
// Exit 0 = all checks pass, 1 = at least one failure. Pure Node ESM, no deps.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const alignDir = path.join(repoRoot, 'docs', 'harness-engineering', 'alignment');
const contractsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'contracts.ts');

// ---- Parse real string-union enums from contracts.ts (reality sync) ----
function parseUnion(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const contractsSrc = await readFile(contractsPath, 'utf8');
const sessionStatuses = parseUnion(contractsSrc, 'SessionStatus');
const agentRunPhases = parseUnion(contractsSrc, 'AgentRunPhase');
const artifactTypes = parseUnion(contractsSrc, 'ArtifactType');

// Curated, stable markers that aren't clean string unions in source.
const executionOutcomeKinds = ['delivered', 'rework', 'ask_user', 'cancelled', 'failed'];
const stageSignalEvents = [
  'brief_created', 'brief_confirmed', 'task_created', 'task_completed',
  'post_review_started', 'post_review_completed', 'final_delivery_created',
  'user_confirmation_requested', 'tool_called', 'error_reported'
];
const harnessArtifactSemantics = [
  'intent_contract', 'design_plan', 'task_plan', 'implementation_summary',
  'verification_summary', 'review_report', 'final_delivery'
];
const stageNames = ['requirement', 'design', 'planning', 'implementation', 'verification', 'review', 'delivery'];

// ---- Per-document required markers ----
const docs = [
  {
    file: 'README.md',
    label: 'alignment/README.md',
    markers: [
      '工程化', '对齐结论矩阵', 'metadata.payload', '后续阶段',
      'session-alignment.md', 'orchestrator-alignment.md', 'events-alignment.md',
      'artifacts-alignment.md', 'gap-analysis.md'
    ]
  },
  {
    file: 'session-alignment.md',
    label: 'alignment/session-alignment.md',
    markers: ['Harness', 'WAIT_USER_CONFIRM', '07-feedback-loop'],
    realityCheck: { name: 'SessionStatus', values: sessionStatuses }
  },
  {
    file: 'orchestrator-alignment.md',
    label: 'alignment/orchestrator-alignment.md',
    markers: ['ExecutionOutcome', 'runPipeline', 'runOneTask', 'runPostReview', 'runFinalDelivery', ...executionOutcomeKinds],
    realityCheck: { name: 'AgentRunPhase', values: agentRunPhases }
  },
  {
    file: 'events-alignment.md',
    label: 'alignment/events-alignment.md',
    markers: ['CollaborationEventType', 'harness_decision_made', ...stageSignalEvents]
  },
  {
    file: 'artifacts-alignment.md',
    label: 'alignment/artifacts-alignment.md',
    markers: ['harnessArtifactType', ...harnessArtifactSemantics],
    realityCheck: { name: 'ArtifactType', values: artifactTypes }
  },
  {
    file: 'gap-analysis.md',
    label: 'alignment/gap-analysis.md',
    markers: ['完整', '部分', '缺失', 'G1', 'G10', '后续阶段', ...stageNames]
  }
];

const results = [];
const has = (content, marker) => content.includes(marker);

for (const doc of docs) {
  const full = path.join(alignDir, doc.file);
  if (!existsSync(full)) {
    results.push({ label: doc.label, ok: false, checks: [{ label: 'file exists', ok: false, detail: 'missing' }] });
    continue;
  }
  const content = await readFile(full, 'utf8');
  const checks = [{ label: 'file exists', ok: true }];

  if (doc.realityCheck) {
    const { name, values } = doc.realityCheck;
    if (!values || !values.length) {
      checks.push({ label: `parse ${name} from contracts.ts`, ok: false, detail: 'union not found' });
    } else {
      for (const value of values) {
        checks.push({ label: `${name} '${value}' documented`, ok: has(content, value) });
      }
    }
  }

  for (const marker of doc.markers) {
    checks.push({ label: `marker: ${marker}`, ok: has(content, marker) });
  }

  results.push({ label: doc.label, ok: checks.every((c) => c.ok), checks });
}

// ---- Report ----
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nHarness Engineering — Phase 2 (Runtime Alignment) conformance\n');
console.log(`docs dir:  ${path.relative(repoRoot, alignDir)}`);
console.log(`reality:   SessionStatus(${sessionStatuses?.length ?? 0}) · AgentRunPhase(${agentRunPhases?.length ?? 0}) · ArtifactType(${artifactTypes?.length ?? 0}) parsed from contracts.ts\n`);

let total = 0;
let failed = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  total += r.checks.length;
  failed += bad.length;
  const icon = r.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${icon}  ${r.label}  ${DIM}(${r.checks.length - bad.length}/${r.checks.length})${RESET}`);
  for (const c of bad) {
    console.log(`        ${RED}x${RESET} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
}

const passedDocs = results.filter((r) => r.ok).length;
console.log(`\n${'-'.repeat(52)}`);
console.log(`Documents: ${passedDocs}/${results.length} conform`);
console.log(`Checks:    ${total - failed}/${total} passed`);

if (failed > 0) {
  console.log(`\n${RED}Phase 2 conformance FAILED${RESET} — alignment docs are out of sync with the spec or the code.\n`);
  process.exit(1);
}
console.log(`\n${GREEN}Phase 2 conformance PASSED${RESET} — session/orchestrator/events/artifacts alignment is documented and reality-synced.\n`);
