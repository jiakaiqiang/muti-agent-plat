import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('test-dispatch-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-correction-effects.ts',
  'tests/evaluation/capture-intent-correction-reconciliation-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'correction-reconciliation-server-tests-final.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (four message-routing service suites)', 'correction-reconciliation-related-current.log', 0],
  ['npm run typecheck', 'correction-reconciliation-workspace-typecheck-final.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'correction-reconciliation-server-build-verified.log', 0],
  ['INTENT_TEST_DOCKER_IMAGE=pinned INTENT_DISPATCH_CORRECTION=true INTENT_DISPATCH_EVIDENCE_PREFIX=correction-reconciliation-current node tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'correction-reconciliation-http-current.log', 0],
  ['npm run test:harness', 'correction-reconciliation-harness-final.log', 0],
  ['git diff --check', 'correction-reconciliation-diff-check-final.log', 0],
];
const full = await read(checks[0][1]), related = await read(checks[1][1]);
if (!/^# pass 2093$/m.test(full) || !/^# pass 7$/m.test(full) || !/^# skipped 26$/m.test(full) || /^# fail [1-9]/m.test(full) ||
  !/^# pass 62$/m.test(related) || /^# fail [1-9]/m.test(related)) throw new Error('Unexpected test evidence');
const httpPath = 'correction-reconciliation-current-http-results.json', http = JSON.parse(await read(httpPath));
if (http.results.length !== 9 || http.results.some(row => !row.passed) || !http.results.find(row => row.id === 'TC01')?.actual.confirmedRunning ||
  !http.results.find(row => row.id === 'TC02')?.actual.sameKeyReplayAndActualRestart) throw new Error('HTTP evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/correction-reconciliation-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const intermediate = ['correction-reconciliation-http.log', 'correction-reconciliation-http-results.json',
  'correction-reconciliation-http-final.log', 'correction-reconciliation-final-http-results.json',
  'correction-reconciliation-http-verified.log', 'correction-reconciliation-verified-http-results.json',
  'correction-reconciliation-server-tests.log', 'correction-reconciliation-worktree-recheck.log',
  'correction-reconciliation-workspace-typecheck.log', 'correction-reconciliation-tests.log', 'correction-reconciliation-tests-final.log'];
const manifest = { runId: 'SDD-2026-10-20-correction-reconciliation', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'test-dispatch-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await read(log)) }))),
  intermediateEvidence: await Promise.all(intermediate.map(async log => ({ log, sha256: sha(await read(log)), scope: 'earlier failure or earlier increment; not final acceptance' }))),
  httpEvidence: { path: httpPath, sha256: sha(await read(httpPath)), cases: http.results.map(row => row.id) },
  tests: { serverPassed: 2093, serverDevScriptsPassed: 7, postgresSkipped: 21, optionalDockerSkippedInFull: 5, relatedPassed: 62, httpPassed: 9, countsOverlap: true },
  scope: { filePersistence: true, realDocker: true, actualServiceRestart: true, deterministicClassifier: true, transactionalCorrectionAfterTestDisposal: true,
    newCorrectionExecutionDispatch: false, realPostgres: false, fullDualClient: false, modelAccuracyEvaluated: false },
  limitations: ['Only isolated scratch disposal is automatically reconciled; no source/artifact/external effect rollback claim',
    'Full shared/Web/Desktop tests/build not rerun in this backend increment',
    'Last server build covers receipt invalidation after workspace typecheck',
    'No complete running-process-crash HTTP matrix, multi-process immediate stop, PostgreSQL, CLI/Bridge or independent annotation/release acceptance'] };
await writeFile(resolve(directory, 'correction-reconciliation-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests, http: manifest.httpEvidence }));
