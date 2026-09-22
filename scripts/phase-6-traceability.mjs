import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phases = ['0', '1', '2a', '2b', '2c', '3', '4', '5', '6'];
const outputPath = resolve(root, 'docs/quality/main-agent-collaboration-phase-6-traceability-matrix-v1.md');

function ids(text, kind) {
  return [...new Set([...text.matchAll(new RegExp(`P(?:[0-9]+[A-Z]?)-${kind}[0-9]+`, 'g'))].map((match) => match[0]))];
}

function markdownSection(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const bodyStart = start + heading.length;
  const nextHeading = text.indexOf('\n## ', bodyStart);
  return text.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading);
}

function statusFromChecklist(value) {
  if (/延期|后续专项/.test(value)) return 'deferred';
  if (/部分/.test(value)) return 'partial';
  if (/未执行|跳过/.test(value)) return 'not-executed';
  if (/通过|已验收|\*\*通过/.test(value)) return 'passed';
  if (/失败/.test(value)) return 'failed';
  return 'pending';
}

function checklistFields(line) {
  const first = line.indexOf('|');
  const second = line.indexOf('|', first + 1);
  const third = line.indexOf('|', second + 1);
  const fourth = line.indexOf('|', third + 1);
  const last = line.lastIndexOf('|');
  return {
    taskRefs: line.slice(second + 1, third).trim(),
    evidence: line.slice(fourth + 1, last).trim()
  };
}

const rows = [];
for (const phase of phases) {
  const stem = `main-agent-collaboration-phase-${phase}`;
  const spec = await readFile(resolve(root, 'docs/product', `${stem}-spec-v1.md`), 'utf8');
  const tasks = await readFile(resolve(root, 'docs/implementation', `${stem}-tasks-v1.md`), 'utf8');
  const checklist = await readFile(resolve(root, 'docs/quality', `${stem}-checklist-v1.md`), 'utf8');
  const taskIds = ids(tasks, 'T');
  const acceptanceCriteria = markdownSection(spec, '## 4. 验收条件');
  if (!acceptanceCriteria) throw new Error(`${phase}: missing acceptance criteria section`);
  for (const acId of ids(acceptanceCriteria, 'AC')) {
    const line = checklist.split(/\r?\n/).find((candidate) => candidate.includes(`| ${acId} |`));
    const fields = line ? checklistFields(line) : undefined;
    const taskRefs = fields?.taskRefs ?? taskIds.filter((taskId) => tasks.includes(acId) && tasks.includes(taskId)).join(', ');
    rows.push({ phase, acId, taskRefs: taskRefs || '未解析', status: line ? statusFromChecklist(fields?.evidence ?? '') : 'missing', evidence: fields?.evidence ?? 'checklist row missing' });
  }
}

const counts = rows.reduce((accumulator, row) => {
  (accumulator[row.status] ??= []).push(row);
  return accumulator;
}, {});
const markdown = `# 阶段 6：跨阶段 AC/Task/证据追踪矩阵 v1

> 生成日期：${new Date().toISOString()}  
> 来源：阶段 0～6 的 Spec、Tasks、Checklist；本文件只反映文档中已有的证据状态，不把文档存在视为业务通过。

## 汇总

- 阶段：${phases.length}
- AC：${rows.length}
- passed：${counts.passed?.length ?? 0}；partial：${counts.partial?.length ?? 0}；pending：${counts.pending?.length ?? 0}；not-executed：${counts['not-executed']?.length ?? 0}；deferred：${counts.deferred?.length ?? 0}；failed/missing：${(counts.failed?.length ?? 0) + (counts.missing?.length ?? 0)}

## 矩阵

| 阶段 | AC | 关联 Task | 当前状态 | Checklist 证据摘要 |
| --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.phase} | ${row.acId} | ${row.taskRefs} | ${row.status} | ${row.evidence.replaceAll('|', '\\|')} |`).join('\n')}

## 解释

- \`passed\`：Checklist 已记录实际验证证据。
- \`partial\`：存在明确的未覆盖范围，不能作为阶段全绿。
- \`pending\` / \`not-executed\`：尚无本阶段可接受的执行证据。
- \`deferred\`：明确记录为后续专项，不属于本阶段发布范围；不能被解释为已完成。
- 真实付费模型、生产发布、外部通知和未配置的 PostgreSQL 均不因本矩阵生成而自动执行。
`;

await mkdir(resolve(root, 'docs/quality'), { recursive: true });
await writeFile(outputPath, markdown, 'utf8');
console.log(JSON.stringify({ outputPath, rows: rows.length, counts }, null, 2));
