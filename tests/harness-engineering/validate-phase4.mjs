#!/usr/bin/env node
// Harness Engineering — Phase 4 (Tool Governance & Human Intervention → capabilities).
//
// Phase 4 (docs/harness-engineering/README.md roadmap) binds Tool Governance (05)
// and Human Intervention (06) into the capabilities module. The deliverable is
// binding SPECS, not code — so this validates the spec docs and REALITY-SYNCS the
// Tool Governance binding against source: it parses the capability keys and risk
// levels from default-capabilities.ts and asserts the binding covers every one.
// Add a capability or change a risk level in code and this test fails until the
// binding catches up. Pure Node ESM, no deps.
//
// Usage: node tests/harness-engineering/validate-phase4.mjs
// Exit 0 = all checks pass, 1 = at least one failure.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dir = path.join(repoRoot, 'docs', 'harness-engineering', 'architecture-constraints', 'capability-binding');
const capsPath = path.join(repoRoot, 'apps', 'server', 'src', 'modules', 'capabilities', 'default-capabilities.ts');

// ---- Parse capabilities source for reality sync ----
const capsSrc = await readFile(capsPath, 'utf8');
// In default-capabilities.ts only capability objects use `key: '...'`; the
// agent->capability record uses bare property names (coordinator: [...]).
const capabilityKeys = [...capsSrc.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
const riskLevels = [...new Set([...capsSrc.matchAll(/riskLevel: '([^']+)'/g)].map((m) => m[1]))];

// ---- Per-document required markers + reality checks ----
const docs = [
  {
    file: 'README.md',
    markers: [
      '工程化', 'resolve', 'checkInvocation', 'approve', 'ENABLE_HIGH_RISK_TOOLS', 'REQUIRE_USER_CONFIRMATION',
      'tool-governance-binding.md', 'human-intervention-binding.md', 'gap-analysis.md',
      '05-tool-governance', '06-human-intervention'
    ]
  },
  {
    file: 'tool-governance-binding.md',
    markers: ['逐能力策略矩阵', 'resolve', 'checkInvocation', 'CapabilityRiskLevel', 'Hard Rules'],
    reality: [
      { name: 'capability key', values: capabilityKeys },
      { name: 'riskLevel', values: riskLevels }
    ]
  },
  {
    file: 'human-intervention-binding.md',
    markers: [
      'CAPABILITY_REQUIRES_CONFIRMATION', 'approve_high_risk_capability', 'REQUIRE_USER_CONFIRMATION',
      'approvalKey', '/check', '/approve', 'Rubric', 'tool.file_write', 'tool.command_run'
    ]
  },
  {
    file: 'gap-analysis.md',
    markers: ['完整', '部分', '缺失', 'Q1', 'Q5', 'checkInvocation', 'approvalKey', 'capability_invocations', 'Definition of Done']
  }
];

const results = [];
const has = (content, marker) => content.includes(marker);

for (const doc of docs) {
  const full = path.join(dir, doc.file);
  if (!existsSync(full)) {
    results.push({ label: `capability-binding/${doc.file}`, ok: false, checks: [{ label: 'file exists', ok: false, detail: 'missing' }] });
    continue;
  }
  const content = await readFile(full, 'utf8');
  const checks = [{ label: 'file exists', ok: true }];

  for (const rc of doc.reality ?? []) {
    if (!rc.values.length) {
      checks.push({ label: `parse ${rc.name} from source`, ok: false, detail: 'not found' });
    } else {
      for (const v of rc.values) checks.push({ label: `${rc.name} '${v}' covered`, ok: has(content, v) });
    }
  }
  for (const marker of doc.markers) checks.push({ label: `marker: ${marker}`, ok: has(content, marker) });

  results.push({ label: `capability-binding/${doc.file}`, ok: checks.every((c) => c.ok), checks });
}

// ---- Report ----
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nHarness Engineering — Phase 4 (Tool Governance & Human Intervention → capabilities)\n');
console.log(`docs dir:  ${path.relative(repoRoot, dir)}`);
console.log(`reality:   capabilityKeys(${capabilityKeys.length}) · riskLevels(${riskLevels.length}) parsed from default-capabilities.ts\n`);

let total = 0;
let failed = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  total += r.checks.length;
  failed += bad.length;
  const icon = r.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${icon}  ${r.label}  ${DIM}(${r.checks.length - bad.length}/${r.checks.length})${RESET}`);
  for (const c of bad) console.log(`        ${RED}x${RESET} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'-'.repeat(54)}`);
console.log(`Documents: ${passed}/${results.length} conform`);
console.log(`Checks:    ${total - failed}/${total} passed`);

if (failed > 0) {
  console.log(`\n${RED}Phase 4 conformance FAILED${RESET} — capability bindings are out of sync with the spec or the code.\n`);
  process.exit(1);
}
console.log(`\n${GREEN}Phase 4 conformance PASSED${RESET} — Tool Governance & Human Intervention bindings are documented and reality-synced.\n`);
