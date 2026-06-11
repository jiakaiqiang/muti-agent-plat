#!/usr/bin/env node
// Harness Engineering — Phase 3 (Prompt & Context Conformance) validator.
//
// Phase 3 (docs/harness-engineering/README.md roadmap) makes Agent prompts and
// runtime context obey Context Protocol (02) and Agent Role Protocol (03). The
// deliverable is conformance SPECS, not prompt/code changes — so this validates
// the spec docs and REALITY-SYNCS them against source: it parses the ContextPack
// fields + AgentRunPhase from contracts.ts and the agent keys from
// default-agents.ts, asserting both contracts cover every one. Add a ContextPack
// field, a phase, or an agent in code and this test fails until the contract
// catches up. Pure Node ESM, no deps.
//
// Usage: node tests/harness-engineering/validate-phase3.mjs
// Exit 0 = all checks pass, 1 = at least one failure.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dir = path.join(repoRoot, 'docs', 'harness-engineering', 'prompt-context');
const contractsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'contracts.ts');
const agentsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'default-agents.ts');
const agentPresetsPath = path.join(repoRoot, 'packages', 'shared', 'src', 'default-agent-presets.ts');

// ---- Parse source for reality sync ----
function parseUnion(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}
function parseObjectFields(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=\\s*{([\\s\\S]*?)};`));
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((x) => x[1]);
}

const contractsSrc = await readFile(contractsPath, 'utf8');
const agentsSrc = `${await readFile(agentsPath, 'utf8')}\n${await readFile(agentPresetsPath, 'utf8')}`;
const contextPackFields = parseObjectFields(contractsSrc, 'ContextPack');
const agentRunPhases = parseUnion(contractsSrc, 'AgentRunPhase');
const agentKeys = [...agentsSrc.matchAll(/key: '([^']+)'/g)].map((x) => x[1]);

// ---- Per-document required markers + reality checks ----
const docs = [
  {
    file: 'README.md',
    markers: [
      '工程化', 'system message', 'user message', 'ContextPack', 'profileMarkdown',
      'agent-prompt-contract.md', 'runtime-context-contract.md', 'gap-analysis.md',
      '02-context-protocol', '03-agent-role-protocol'
    ]
  },
  {
    file: 'agent-prompt-contract.md',
    markers: ['通用提示词骨架', '## 所属阶段', '不负责', '越权与返工', 'Rubric'],
    reality: [{ name: 'agent key', values: agentKeys }]
  },
  {
    file: 'runtime-context-contract.md',
    markers: ['分阶段注入矩阵', '不应该看到', 'Rubric'],
    reality: [
      { name: 'ContextPack field', values: contextPackFields },
      { name: 'AgentRunPhase', values: agentRunPhases }
    ]
  },
  {
    file: 'gap-analysis.md',
    markers: ['完整', '部分', '缺失', 'P1', 'P6', 'profileMarkdown', 'createContextPack', 'relevantEvents', 'Definition of Done']
  }
];

const results = [];
const has = (content, marker) => content.includes(marker);

for (const doc of docs) {
  const full = path.join(dir, doc.file);
  if (!existsSync(full)) {
    results.push({ label: `prompt-context/${doc.file}`, ok: false, checks: [{ label: 'file exists', ok: false, detail: 'missing' }] });
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

  results.push({ label: `prompt-context/${doc.file}`, ok: checks.every((c) => c.ok), checks });
}

// ---- Report ----
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nHarness Engineering — Phase 3 (Prompt & Context Conformance)\n');
console.log(`docs dir:  ${path.relative(repoRoot, dir)}`);
console.log(`reality:   ContextPack(${contextPackFields.length}) · AgentRunPhase(${agentRunPhases.length}) · agentKeys(${agentKeys.length}) parsed from source\n`);

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
  console.log(`\n${RED}Phase 3 conformance FAILED${RESET} — prompt/context contracts are out of sync with the spec or the code.\n`);
  process.exit(1);
}
console.log(`\n${GREEN}Phase 3 conformance PASSED${RESET} — prompt & runtime-context contracts are documented and reality-synced.\n`);
