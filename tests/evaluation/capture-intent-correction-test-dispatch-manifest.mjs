import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('correction-reconciliation-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes), 'tests/evaluation/capture-intent-correction-test-dispatch-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'correction-test-dispatch-server-tests.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (five message-routing service suites)', 'correction-test-dispatch-related.log', 0],
  ['npm run typecheck', 'correction-test-dispatch-workspace-typecheck.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'correction-test-dispatch-chat-build-final.log', 0],
  ['INTENT_TEST_DOCKER_IMAGE=pinned INTENT_DISPATCH_CORRECTION_EXECUTION=true INTENT_DISPATCH_EVIDENCE_PREFIX=correction-test-dispatch-chat node tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'correction-test-dispatch-http-chat.log', 0],
  ['npm run test:harness', 'correction-test-dispatch-harness.log', 0], ['git diff --check', 'correction-test-dispatch-diff-check.log', 0],
];
const full = await read(checks[0][1]), related = await read(checks[1][1]);
if (!/^# pass 2098$/m.test(full) || !/^# pass 7$/m.test(full) || !/^# skipped 26$/m.test(full) || /^# fail [1-9]/m.test(full) ||
  !/^# pass 83$/m.test(related) || /^# fail [1-9]/m.test(related)) throw new Error('Unexpected test evidence');
const httpPath = 'correction-test-dispatch-chat-http-results.json', http = JSON.parse(await read(httpPath));
if (http.results.length !== 11 || http.results.some(row => !row.passed) || !http.results.find(row => row.id === 'TC01')?.actual.confirmedRunning ||
  !http.results.find(row => row.id === 'TX01')?.actual.separateSnapshots || !http.results.find(row => row.id === 'TX02')?.actual.classificationBudgetShared ||
  !http.results.find(row => row.id === 'TC02')?.actual.sameKeyReplayAndActualRestart) throw new Error('HTTP evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/correction-test-dispatch-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const intermediate = ['correction-test-dispatch-http.log', 'correction-test-dispatch-http-results.json', 'correction-test-dispatch-tests.log',
  'correction-test-dispatch-executor-tests.log', 'correction-test-dispatch-typecheck.log', 'correction-test-dispatch-build.log', 'correction-test-dispatch-chat-build.log'];
const manifest = { runId: 'SDD-2026-10-20-correction-test-dispatch', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'correction-reconciliation-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await read(log)) }))),
  intermediateEvidence: await Promise.all(intermediate.map(async log => ({ log, sha256: sha(await read(log)), scope: 'earlier increment, not final acceptance' }))),
  httpEvidence: { path: httpPath, sha256: sha(await read(httpPath)), cases: http.results.map(row => row.id) },
  tests: { serverPassed: 2098, serverDevScriptsPassed: 7, postgresSkipped: 21, optionalDockerSkippedInFull: 5, relatedPassed: 83, httpPassed: 11, countsOverlap: true },
  scope: { filePersistence: true, realDocker: true, actualServiceRestart: true, deterministicClassifier: true,
    versionedTestCorrectionApi: true, versionedTestCorrectionChat: true, originalInputAndClassificationBudgetPreserved: true,
    realPostgres: false, fullDualClient: false, modelAccuracyEvaluated: false },
  limitations: ['Only single isolated test effects; source/artifact/external effects and ordered plans remain incomplete',
    'No full running-process-crash HTTP matrix, multi-process immediate stop, PostgreSQL, CLI/Bridge or dual-client verification',
    'No independent human annotation, real model accuracy or release completion claim', 'Web/Desktop full builds not rerun for this backend increment'] };
await writeFile(resolve(directory, 'correction-test-dispatch-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests, http: manifest.httpEvidence }));
