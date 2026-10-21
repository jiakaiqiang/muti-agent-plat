import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('correction-test-dispatch-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/semantic-clarification.ts',
  'apps/server/src/modules/message-routing/semantic-clarification.service.ts',
  'apps/server/src/modules/message-routing/semantic-clarification.service.spec.ts',
  'tests/evaluation/run-intent-semantic-clarification-sdd.mjs',
  'tests/evaluation/capture-intent-semantic-clarification-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'semantic-clarification-server-tests.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (semantic router, clarification, plan commit, message pipeline suites)', 'semantic-clarification-related-verified.log', 0],
  ['npm run test --workspace @agent-cluster/shared', 'semantic-clarification-shared-tests.log', 0],
  ['npm run test --workspace @project/web', 'semantic-clarification-web-tests.log', 0],
  ['npm run typecheck', 'semantic-clarification-workspace-typecheck-final.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'semantic-clarification-build-final-verified.log', 0],
  ['INTENT_CLARIFICATION_EVIDENCE_PREFIX=semantic-clarification-final node tests/evaluation/run-intent-semantic-clarification-sdd.mjs', 'semantic-clarification-http-final.log', 0],
  ['npm run test:harness', 'semantic-clarification-harness.log', 0],
  ['git diff --check', 'semantic-clarification-diff-check.log', 0]
];
for (const [file, count] of [['semantic-clarification-server-tests.log', 2113], ['semantic-clarification-related-verified.log', 65], ['semantic-clarification-shared-tests.log', 281]]) {
  const log = await read(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`Unexpected results: ${file}`);
}
if (!/493 passed/.test(await read('semantic-clarification-web-tests.log'))) throw new Error('Web evidence incomplete');
const httpPath = 'semantic-clarification-final-http-results.json', http = JSON.parse(await read(httpPath));
if (http.results.length !== 8 || http.results.some(row => !row.passed) || !http.results.find(row => row.id === 'SC08')?.actual.actualServerRestart) throw new Error('HTTP evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/semantic-clarification-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const intermediate = ['semantic-clarification-http.log', 'semantic-clarification-http-bound.log', 'semantic-clarification-http-diagnostic.log',
  'semantic-clarification-http-verified.log', 'semantic-clarification-verified-http-results.json', 'semantic-clarification-workspace-typecheck.log',
  'semantic-clarification-tests.log', 'semantic-clarification-tests-second.log'];
const manifest = { runId: 'SDD-2026-10-20-semantic-clarification', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'correction-test-dispatch-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await read(log)) }))),
  intermediateEvidence: await Promise.all(intermediate.map(async log => ({ log, sha256: sha(await read(log)), scope: 'historical failure or earlier increment; not final acceptance' }))),
  httpEvidence: { path: httpPath, sha256: sha(await read(httpPath)), cases: http.results.map(row => row.id) },
  tests: { serverPassed: 2113, serverDevScriptsPassed: 7, postgresSkipped: 21, optionalDockerSkipped: 5, sharedPassed: 281, webPassed: 493, relatedPassed: 65, httpPassed: 8, countsOverlap: true },
  scope: { filePersistence: true, actualServiceRestart: true, deterministicClassifier: true, relationClarification: true,
    realPostgres: false, fullDualClient: false, modelAccuracyEvaluated: false },
  limitations: ['Only single-segment relation clarification, not correction-target or general field/multi-segment clarification',
    'No running-process-crash, multi-process, PostgreSQL, CLI/Bridge or dual-client matrix in this increment',
    'No independent human annotation, real model accuracy or release completion claim',
    'Full tests preceded two test-only non-null type assertions; final workspace typecheck and server build include them',
    'Other executors and broader original SDD scope remain incomplete'] };
await writeFile(resolve(directory, 'semantic-clarification-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
