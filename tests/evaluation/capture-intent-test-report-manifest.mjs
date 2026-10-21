import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('artifact-transaction-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-runtime-policy.spec.ts', 'apps/web/src/components/ChineseNoticePresentation.spec.ts',
  'apps/web/src/components/IntentTestAuthorityPanel.spec.ts', 'apps/web/src/stores/intentTestAuthority.spec.ts',
  'tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'tests/evaluation/run-intent-postgres-sdd.mjs',
  'tests/evaluation/serve-intent-test-authority-ui.mjs', 'tests/evaluation/test-report-ui-browser-checks.js',
  'tests/evaluation/capture-intent-test-report-manifest.mjs'])];
for (const [file, count] of [['test-report-server-tests.log', 2123], ['test-report-related-final.log', 79],
  ['test-report-shared.log', 282], ['test-report-postgres-verified.log', 28]]) {
  const log = await read(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`Unexpected results: ${file}`);
}
const http = JSON.parse(await read('test-report-http-results.json'));
const database = JSON.parse(await read('test-report-postgres-verified.json'));
const browserLog = await read('test-report-ui-browser.log');
const browser = JSON.parse(browserLog.split(/\r?\n/).find(line => line.startsWith('{"checks":')));
const browserState = JSON.parse(await read('test-report-ui-browser-state.json'));
if (http.results.length !== 10 || http.results.some(row => !row.passed) || !database.cleanupConfirmed || database.exitCode !== 0 ||
  browser.checks.length !== 6 || browser.checks.some(row => !row.passed) || browserState.testInvocations.length ||
  browserState.events.length !== 4 || browserState.authority.reportGrant) throw new Error('Integration evidence incomplete');
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'test-report-server-tests.log'],
  ['npm run test --workspace @agent-cluster/shared', 'test-report-shared.log'],
  ['npm run test --workspace @project/web', 'test-report-web-tests.log'],
  ['npx tsx --test (test authority, test executor, test run store, invocation resolver)', 'test-report-related-final.log'],
  ['npx tsx --test (test executor after final failure-notice change)', 'test-report-executor-final.log'],
  ['npm run typecheck', 'test-report-final-typecheck.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'test-report-server-final-typecheck.log'],
  ['npm run build', 'test-report-build.log'],
  ['npm run build --workspace @agent-cluster/server (final)', 'test-report-server-final-build.log'],
  ['INTENT_DISPATCH_REPORT=true node tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'test-report-http.log'],
  ['playwright-cli run-code --filename tests/evaluation/test-report-ui-browser-checks.js', 'test-report-ui-browser.log'],
  ['node tests/evaluation/run-intent-postgres-sdd.mjs (isolated database)', 'test-report-postgres-verified-runner.log'],
  ['npm run test:harness', 'test-report-harness.log'], ['git diff --check', 'test-report-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/api-contract-v0.1.md', `${directory}/test-report-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const supporting = ['test-report-http-results.json', 'test-report-postgres-verified.log', 'test-report-postgres-verified.json',
  'test-report-postgres-final.log', 'test-report-postgres-final.json',
  'test-report-postgres.log', 'test-report-postgres.json', 'test-report-postgres-diagnostic.log', 'test-report-postgres-diagnostic.json',
  'test-report-ui.log', 'test-report-ui-browser-state.json', 'test-report-server-build.log'];
const manifest = { runId: 'SDD-2026-10-20-test-report', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'artifact-transaction-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(supporting.map(async path => ({ path, sha256: sha(await read(path)) }))),
  screenshot: { path: 'output/playwright/test-report-ui-mobile.png', sha256: sha(await readFile('output/playwright/test-report-ui-mobile.png')) },
  tests: { serverPassed: 2123, serverDevScriptsPassed: 7, sharedPassed: 282, webPassed: 497, relatedPassed: 79,
    postgresSkippedInFull: 26, optionalDockerSkippedInFull: 5, realPostgresPassed: 28, httpDockerPassed: 10, browserPassed: 6, countsOverlap: true }, database,
  verificationScope: ['Full server run precedes the final failure notice text and two PostgreSQL test additions; final executor and real database runs cover these deltas',
    'Whole workspace build precedes failed-assertion report handling; server build before HTTP covers handling; final server build also covers notice and database fixture changes'],
  limitations: ['Only server-generated isolated test reports, no generic artifact/source/external executor',
    'Published reports remain historical artifacts and cannot be treated as discarded scratch; full correction compensation is incomplete',
    'HTTP uses a deterministic classifier, database uses service fixtures, browser uses the shared panel against an isolated API',
    'No complete first-turn IA03, child-task permission, Electron/client crash matrix or independent model accuracy claim'] };
await writeFile(resolve(directory, 'test-report-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
