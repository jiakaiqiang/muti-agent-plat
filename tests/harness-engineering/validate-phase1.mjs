#!/usr/bin/env node
// Harness Engineering — Phase 1 conformance validator.
//
// Phase 1 (docs/harness-engineering/README.md) ships protocols + templates, not
// feature code. This validates the canonical layout:
//   README.md                      index linking the 8 protocols + templates
//   01-..08-*.md                   the eight engineering protocols
//   templates/*.md                 the seven stage artifact templates
// This is the Verification stage applied to Phase 1 itself. Pure Node ESM, no deps.
//
// Usage: node tests/harness-engineering/validate-phase1.mjs
// Exit 0 = all checks pass, 1 = at least one failure.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const docsDir = path.join(repoRoot, 'docs', 'harness-engineering');
const templatesDir = path.join(docsDir, 'templates');

// Core engineering protocols. Each file must exist and carry its protocol name
// in the H1 title plus the required section markers for its phase.
const protocols = [
  { file: '00-boundary-and-principles.md', name: 'Boundary and Principles', sections: ['## 硬规则'] },
  { file: 'context-engineering/01-intent-contract.md', name: 'Intent Contract' },
  {
    file: 'context-engineering/02-context-protocol.md', name: 'Context Protocol',
    sections: ['## 上下文条目模型', '## 上下文生命周期', '## 上下文污染处理', '## 阶段入口检查']
  },
  { file: 'architecture-constraints/03-agent-role-protocol.md', name: 'Agent Role Protocol', sections: ['## 架构边界责任'] },
  {
    file: 'architecture-constraints/04-stage-workflow.md', name: 'Stage Workflow',
    sections: ['Architecture Constraints', 'forbidden_change_scope', '架构不变量未被破坏']
  },
  {
    file: 'architecture-constraints/05-tool-governance.md', name: 'Tool Governance',
    sections: ['forbiddenPaths', 'architecture_signal', 'role_boundary_signal']
  },
  { file: 'feedback-loop/06-human-intervention.md', name: 'Human Intervention' },
  {
    file: 'feedback-loop/07-feedback-loop.md', name: 'Feedback Loop',
    sections: ['Signal', '## 闭环标准', 'memory_signal', 'entropy_signal']
  },
  { file: 'entropy-management/08-delivery-memory.md', name: 'Delivery Memory' },
  { file: 'architecture-constraints/10-agent-working-protocol.md', name: 'Agent Working Protocol' },
  {
    file: 'entropy-management/12-continuous-governance.md', name: 'Continuous Governance',
    sections: ['## 熵管理', '## 反扩张规则', 'quarantine']
  }
];

// The seven stage artifact templates under templates/. Each embeds copy-ready
// frontmatter (artifact/stage/schemaVersion) plus the sections of its template.
const templates = [
  {
    file: 'intent-contract-template.md', artifact: 'intent_contract', stage: 'requirement',
    sections: ['## 目标 (Goal)', '## 背景 (Background)', '## 非目标', '## 约束 (Constraints)', '## 验收标准 (Acceptance Criteria)', '## 风险 (Risks)', '## 需要用户确认的问题']
  },
  {
    file: 'design-plan-template.md', artifact: 'design_plan', stage: 'design',
    sections: ['## 方案概述', '## 架构与模块边界', 'Architecture Constraints', 'forbidden_change_scope', '## 影响范围', '## 契约影响', '## 备选方案', '## 对验收标准的覆盖']
  },
  {
    file: 'task-plan-template.md', artifact: 'task_plan', stage: 'planning',
    sections: ['## 任务拆解', '## 依赖关系', '## 范围与权限总览', 'allowedPaths', 'forbiddenPaths', 'toolPolicy']
  },
  {
    file: 'implementation-summary-template.md', artifact: 'implementation_summary', stage: 'implementation',
    sections: ['## 完成的任务', '## 变更文件', '## 范围偏差', '## 工具调用记录', '## 自检']
  },
  {
    file: 'verification-result-template.md', artifact: 'verification_summary', stage: 'verification',
    sections: ['## 验收标准核对', '## 测试执行', '## 证据', '## 缺陷', '## 结论']
  },
  {
    file: 'review-report-template.md', artifact: 'review_report', stage: 'review',
    sections: ['## 评审输入', '## 一致性检查', '## 发现', '## 范围变化', '## 决策', 'approve', 'rework', 'ask_user', 'fail']
  },
  {
    file: 'final-delivery-template.md', artifact: 'final_delivery', stage: 'delivery',
    sections: ['## 交付摘要', '## 已完成项', '## 未完成项', '## 范围外改动', '## 测试结果', '## 剩余风险', '## 关联产物', '## 交付记忆沉淀']
  }
];

// Every template additionally needs these structural anchors.
const commonTemplateMarkers = ['## 模板正文', '## 完成标准 (Definition of Done)', '## 交接 (Handoff)', 'schemaVersion: "0.1"'];

const results = [];
const has = (content, marker) => content.includes(marker);

function record(name, checks) {
  results.push({ name, checks, ok: checks.every((c) => c.ok) });
}

async function readOrNull(full) {
  return existsSync(full) ? readFile(full, 'utf8') : null;
}

// ---- README index: links to all 8 protocols + lists the 7 templates ----
{
  const content = await readOrNull(path.join(docsDir, 'README.md'));
  if (content === null) {
    record('README.md', [{ label: 'file exists', ok: false, detail: 'missing' }]);
  } else {
    const checks = [{ label: 'file exists', ok: true }];
    for (const p of protocols) checks.push({ label: `links ${p.file}`, ok: has(content, p.file) });
    checks.push({ label: 'mentions templates/', ok: has(content, 'templates/') });
    checks.push({ label: 'section: ## 文档分层', ok: has(content, '## 文档分层') });
    checks.push({ label: 'section: ## 四要素总览', ok: has(content, '## 四要素总览') });
    checks.push({ label: 'links boundary doc', ok: has(content, '00-boundary-and-principles.md') });
    for (const t of templates) checks.push({ label: `lists ${t.file}`, ok: has(content, t.file) });
    record('README.md', checks);
  }
}

// ---- The eight protocols ----
for (const p of protocols) {
  const content = await readOrNull(path.join(docsDir, p.file));
  if (content === null) {
    record(p.file, [{ label: 'file exists', ok: false, detail: 'missing' }]);
    continue;
  }
  record(p.file, [
    { label: 'file exists', ok: true },
    { label: `title: ${p.name}`, ok: has(content, p.name) },
    { label: 'section: ## 目的', ok: p.file === '00-boundary-and-principles.md' || has(content, '## 目的') },
    ...((p.sections ?? []).map((s) => ({ label: `marker: ${s}`, ok: has(content, s) })))
  ]);
}

// ---- The seven templates ----
for (const t of templates) {
  const content = await readOrNull(path.join(templatesDir, t.file));
  if (content === null) {
    record(`templates/${t.file}`, [{ label: 'file exists', ok: false, detail: 'missing' }]);
    continue;
  }
  const checks = [
    { label: 'file exists', ok: true },
    { label: `frontmatter artifact: ${t.artifact}`, ok: has(content, `artifact: ${t.artifact}`) },
    { label: `frontmatter stage: ${t.stage}`, ok: has(content, `stage: ${t.stage}`) }
  ];
  for (const m of commonTemplateMarkers) checks.push({ label: `marker: ${m}`, ok: has(content, m) });
  for (const s of t.sections) checks.push({ label: `section: ${s}`, ok: has(content, s) });
  record(`templates/${t.file}`, checks);
}

// ---- Report ----
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nHarness Engineering — Phase 1 conformance\n');
console.log(`docs dir: ${path.relative(repoRoot, docsDir)}\n`);

let total = 0;
let failed = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  total += r.checks.length;
  failed += bad.length;
  const icon = r.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${icon}  ${r.name}  ${DIM}(${r.checks.length - bad.length}/${r.checks.length})${RESET}`);
  for (const c of bad) console.log(`        ${RED}x${RESET} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'-'.repeat(48)}`);
console.log(`Documents: ${passed}/${results.length} conform`);
console.log(`Checks:    ${total - failed}/${total} passed`);

if (failed > 0) {
  console.log(`\n${RED}Phase 1 conformance FAILED${RESET}\n`);
  process.exit(1);
}
console.log(`\n${GREEN}Phase 1 conformance PASSED${RESET} — protocols & templates are in place.\n`);
