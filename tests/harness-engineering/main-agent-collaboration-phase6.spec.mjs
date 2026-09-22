import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const phases = ['0', '1', '2a', '2b', '2c', '3', '4', '5', '6'];
const ids = (text, kind) => [...text.matchAll(new RegExp(`P(?:[0-9]+[A-Z]?)-${kind}[0-9]+`, 'g'))].map((match) => match[0]);
const markdownSection = (text, heading) => {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const bodyStart = start + heading.length;
  const nextHeading = text.indexOf('\n## ', bodyStart);
  return text.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading);
};

const results = [];
for (const phase of phases) {
  const stem = `main-agent-collaboration-phase-${phase}`;
  const paths = {
    spec: resolve(root, 'docs/product', `${stem}-spec-v1.md`),
    tasks: resolve(root, 'docs/implementation', `${stem}-tasks-v1.md`),
    checklist: resolve(root, 'docs/quality', `${stem}-checklist-v1.md`)
  };
  for (const path of Object.values(paths)) assert.ok(existsSync(path), `missing ${path}`);
  const [spec, tasks, checklist] = await Promise.all(Object.values(paths).map((path) => readFile(path, 'utf8')));
  const acceptanceCriteria = markdownSection(spec, '## 4. 验收条件');
  assert.ok(acceptanceCriteria, `${phase}: missing acceptance criteria section`);
  const acIds = [...new Set(ids(acceptanceCriteria, 'AC'))];
  const taskIds = [...new Set(ids(tasks, 'T'))];
  assert.ok(acIds.length > 0, `${phase}: no AC ids`);
  assert.ok(taskIds.length > 0, `${phase}: no task ids`);
  for (const id of acIds) {
    assert.match(tasks, new RegExp(id.replace('-', '\\-')), `${phase}: ${id} missing from tasks`);
    assert.match(checklist, new RegExp(id.replace('-', '\\-')), `${phase}: ${id} missing from checklist`);
  }
  for (const id of taskIds) assert.match(checklist, new RegExp(id.replace('-', '\\-')), `${phase}: ${id} missing from checklist`);
  results.push({ phase, acCount: acIds.length, taskCount: taskIds.length, checklistHasEvidenceSection: checklist.includes('证据') });
}

assert.ok(results.every((item) => item.checklistHasEvidenceSection));
const serverMain = await readFile(resolve(root, 'apps/server/src/main.ts'), 'utf8');
assert.match(serverMain, /assertPhase6ProductionPolicyAdmission\(\)/, 'server bootstrap must enforce phase 6 policy admission');
const smokeServer = await readFile(resolve(root, 'tests/e2e/smoke-server.mjs'), 'utf8');
assert.match(smokeServer, /NODE_ENV: 'test'/, 'isolated smoke server must identify itself as test');
assert.match(smokeServer, /PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only'/,
  'isolated smoke server must use only the exact test admission bypass');
console.log(`phase 6 traceability harness passed: ${results.length} phases, ${results.reduce((sum, item) => sum + item.acCount, 0)} ACs, ${results.reduce((sum, item) => sum + item.taskCount, 0)} tasks`);
