#!/usr/bin/env node
// Harness Engineering — Phase 5 (Delivery Memory) conformance validator.
//
// Phase 5 (docs/harness-engineering/README.md roadmap) establishes Delivery
// Memory so each delivery deposits project knowledge. The deliverable is binding
// SPECS, not code — so this validates the spec docs and REALITY-SYNCS them against
// three sources of truth:
//   - MemoryScope          (packages/shared/src/contracts.ts)           [code]
//   - the five deposit categories (08-delivery-memory.md `### ` headings) [protocol]
//   - the deposit locations (final-delivery-template.md "沉淀位置" line)   [template]
// Change any source without updating the bindings and this test fails.
// Pure Node ESM, no deps.
//
// Usage: node tests/harness-engineering/validate-phase5.mjs
// Exit 0 = all checks pass, 1 = at least one failure.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const harnessDir = path.join(repoRoot, 'docs', 'harness-engineering');
const dir = path.join(harnessDir, 'entropy-management', 'delivery-memory');
const contractsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'contracts.ts');
const protocolPath = path.join(harnessDir, 'entropy-management', '08-delivery-memory.md');
const templatePath = path.join(harnessDir, 'templates', 'final-delivery-template.md');

// ---- Parse the three sources of truth ----
function parseUnion(src, name) {
  const m = src.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}
function parseCategories(src) {
  const m = src.match(/## 需要沉淀的内容([\s\S]*?)(?:\n## |$)/);
  const block = m ? m[1] : src;
  return [...block.matchAll(/^###\s+(.+?)\s*$/gm)].map((x) => x[1].trim());
}
function parseDepositPaths(src) {
  const line = src.split('\n').find((l) => l.includes('沉淀位置'));
  return line ? [...line.matchAll(/docs\/[^\s|]+/g)].map((x) => x[0]) : [];
}

const memoryScopes = parseUnion(await readFile(contractsPath, 'utf8'), 'MemoryScope');
const categories = parseCategories(await readFile(protocolPath, 'utf8'));
const depositPaths = parseDepositPaths(await readFile(templatePath, 'utf8'));

// ---- Per-document required markers + reality checks ----
const docs = [
  {
    file: 'README.md',
    markers: [
      '工程化', 'memoriesBySession', 'createContextPack', 'runFinalDelivery', 'confirmMemory',
      'memory-binding.md', 'knowledge-deposit.md', 'gap-analysis.md', '08-delivery-memory', 'final-delivery-template'
    ]
  },
  {
    file: 'memory-binding.md',
    markers: ['作用域绑定', 'confirmMemory', 'createContextPack', 'relevantMemories', 'Rubric', 'sourceEventId'],
    reality: [{ name: 'MemoryScope', values: memoryScopes }]
  },
  {
    file: 'knowledge-deposit.md',
    markers: ['沉淀目标文件', 'runs/', 'Rubric', 'record: delivery_memory'],
    reality: [
      { name: 'category', values: categories },
      { name: 'deposit path', values: depositPaths }
    ]
  },
  {
    file: 'gap-analysis.md',
    markers: ['完整', '部分', '缺失', 'R1', 'R5', 'runFinalDelivery', 'long_term_candidate', 'memoriesBySession', 'Definition of Done']
  }
];

const results = [];
const has = (content, marker) => content.includes(marker);

for (const doc of docs) {
  const full = path.join(dir, doc.file);
  if (!existsSync(full)) {
    results.push({ label: `delivery-memory/${doc.file}`, ok: false, checks: [{ label: 'file exists', ok: false, detail: 'missing' }] });
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

  results.push({ label: `delivery-memory/${doc.file}`, ok: checks.every((c) => c.ok), checks });
}

// ---- Report ----
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nHarness Engineering — Phase 5 (Delivery Memory) conformance\n');
console.log(`docs dir:  ${path.relative(repoRoot, dir)}`);
console.log(`reality:   MemoryScope(${memoryScopes.length}) · categories(${categories.length}) · depositPaths(${depositPaths.length}) parsed from code + protocol + template\n`);

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
  console.log(`\n${RED}Phase 5 conformance FAILED${RESET} — delivery-memory bindings are out of sync with code/protocol/template.\n`);
  process.exit(1);
}
console.log(`\n${GREEN}Phase 5 conformance PASSED${RESET} — Delivery Memory bindings are documented and reality-synced.\n`);
