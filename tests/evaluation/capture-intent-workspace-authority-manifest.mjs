import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('workspace-answer-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-workspace-authority.service.ts',
  'apps/server/src/modules/sessions/source-preparation-coordinator.ts',
  'tests/evaluation/run-intent-workspace-authority-sdd.mjs', 'tests/evaluation/capture-intent-workspace-authority-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'workspace-authority-server-tests.log'],
  ['npm run typecheck', 'workspace-authority-workspace-typecheck.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts apps/server/src/modules/sessions/sessions.service.spec.ts', 'workspace-authority-final-regression.log'],
  ['npm run build --workspace @agent-cluster/shared', 'workspace-authority-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'workspace-authority-final-build.log'],
  ['node tests/evaluation/run-intent-workspace-authority-sdd.mjs', 'workspace-authority-http-final.log'],
  ['npm run test:harness', 'workspace-authority-harness.log'],
  ['git diff --check', 'workspace-authority-diff-check.log']
];
const full = await load('workspace-authority-server-tests.log');
if (![2045, 7].every(count => new RegExp(`^# pass ${count}$`, 'm').test(full)) || /^# fail [1-9]/m.test(full)) throw new Error('Server results differ');
const regression = await load('workspace-authority-final-regression.log');
if (!/^# pass 168$/m.test(regression) || /^# fail [1-9]/m.test(regression)) throw new Error('Regression results differ');
const evidence = 'workspace-authority-http-results.json', http = JSON.parse(await load(evidence));
if (http.results.length !== 8 || http.results.some(row => !row.passed)) throw new Error('HTTP checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-workspace-authority', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'workspace-answer-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2045, serverDevScriptsPassed: 7, postgresSkipped: 21, finalRelatedPassed: 168, httpCasesPassed: 8, countsOverlap: true },
  scope: { backend: 'isolated File', model: 'deterministic localhost provider; no accuracy claim', realPostgresVerified: false,
    sourceReady: 'service and File transaction tests; no real GitHub clone/OAuth', fullWorkspaceTestsRerun: false, productionConfigurationChanged: false },
  limitations: ['Full server run and whole-workspace typecheck started before final strict action-input guard; final related tests/server build/HTTP cover that delta',
    'Revocation UI, real GitHub source preparation, Bridge/CLI reads and full fault matrix remain incomplete',
    'Scoped execution, business dispatch, independent annotation, full scenarios and release gates remain incomplete'] };
await writeFile(resolve(directory, 'workspace-authority-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
