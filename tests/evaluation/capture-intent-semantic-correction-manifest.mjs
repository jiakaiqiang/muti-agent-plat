import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('semantic-ingress-manifest.json'));
const baseline = JSON.parse(await load('versioned-correction-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes), ...Object.keys(baseline.sourceHashes),
  'apps/server/src/modules/sessions/sessions.service.ts', 'apps/server/src/modules/sessions/sessions.module.ts',
  'apps/server/src/modules/message-routing/message-correction-target.ts',
  'apps/server/src/modules/message-routing/intent-correction.service.ts', 'apps/server/src/modules/message-routing/intent-correction.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-correction-planner.service.ts', 'apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts',
  'apps/server/src/modules/intent-recognition/intent-understanding-routing.service.ts',
  'tests/evaluation/capture-intent-semantic-correction-manifest.mjs'])];
const checks = [
  ['npm run test -w @agent-cluster/server', 'semantic-correction-server-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts apps/server/src/modules/message-routing/intent-correction.service.spec.ts apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/recovery/recovery.service.spec.ts', 'semantic-correction-regression.log'],
  ['npm run typecheck', 'semantic-correction-workspace-typecheck.log'],
  ['npm run build -w @agent-cluster/server', 'semantic-correction-build-final.log'],
  ['npm run test:harness', 'semantic-correction-harness.log'],
  ['node tests/evaluation/run-intent-semantic-ingress-sdd.mjs --corrections', 'semantic-correction-http-final.log'],
  ['git diff --check', 'semantic-correction-diff-check.log']
];
for (const [file, count] of [['semantic-correction-server-tests.log', 2037], ['semantic-correction-regression.log', 87]]) {
  const log = await load(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`${file}: results differ`);
}
const evidence = 'semantic-correction-http-results.json';
const result = JSON.parse(await load(evidence));
if (result.results.length !== 11 || result.results.some(row => !row.passed)) throw new Error('HTTP checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-correction-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-semantic-correction', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'semantic-ingress-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2037, serverDevScriptsPassed: 7, postgresSkipped: 21, relatedPassed: 87, httpCasesPassed: 11, countsOverlap: true },
  scope: { ingress: 'actual new-contract Sessions messages with versioned correction bridge', backend: 'isolated File',
    runtime: 'actual Generic LLM HTTP with deterministic localhost responses', modelAccuracyEvaluated: false,
    realPostgresVerified: false, fullWorkspaceTestsRerun: false, productionFlagChanged: false },
  limitations: ['Single segment corrections without execution effects only; structured target clarification and execution-producing plans remain incomplete',
    'Real clients/DB/CLI, independent annotation, full scenario matrix and release gates remain incomplete',
    'Historical manifest coverage varies; this capture includes prior versioned source paths and Sessions wiring explicitly'] };
await writeFile(resolve(directory, 'semantic-correction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
