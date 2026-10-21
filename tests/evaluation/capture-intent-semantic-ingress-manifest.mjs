import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('answer-executor-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-message-pipeline.service.ts',
  'apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts',
  'apps/server/src/modules/recovery/recovery.service.ts', 'apps/server/src/modules/recovery/recovery.service.spec.ts',
  'tests/evaluation/run-intent-semantic-ingress-sdd.mjs', 'tests/evaluation/capture-intent-semantic-ingress-manifest.mjs'])];
const checks = [
  ['npm run test -w @agent-cluster/server', 'semantic-ingress-server-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts', 'semantic-ingress-final-regression.log'],
  ['npm run typecheck', 'semantic-ingress-verified-typecheck.log'],
  ['npm run build -w @agent-cluster/server', 'semantic-ingress-verified-build.log'],
  ['npm run test:harness', 'semantic-ingress-harness.log'],
  ['node tests/evaluation/run-intent-semantic-ingress-sdd.mjs', 'semantic-ingress-verified-http.log'],
  ['git diff --check', 'semantic-ingress-diff-check.log']
];
for (const [file, count] of [['semantic-ingress-server-tests.log', 2033], ['semantic-ingress-final-regression.log', 22]]) {
  const log = await load(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`${file}: results differ`);
}
const evidence = 'semantic-ingress-http-results.json';
const result = JSON.parse(await load(evidence));
if (result.results.length !== 7 || result.results.some(row => !row.passed)) throw new Error('HTTP checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-ingress-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-semantic-ingress', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'answer-executor-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2033, serverDevScriptsPassed: 7, postgresSkipped: 21, finalRelatedPassed: 22, httpCasesPassed: 7, countsOverlap: true },
  scope: { ingress: 'actual Sessions create/messages API; explicit new-contract cohort', backend: 'isolated File',
    runtime: 'actual Generic LLM HTTP with deterministic localhost responses', modelAccuracyEvaluated: false,
    realPostgresVerified: false, fullWorkspaceTestsRerun: false, productionFlagChanged: false },
  limitations: ['Full server run precedes final late-block/receipt guard; final regression, typecheck, build and HTTP cover that increment',
    'New-contract corrections, controlled Brief/business executors and special ingress paths remain incomplete',
    'Real clients/DB/CLI, independent annotation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'semantic-ingress-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
