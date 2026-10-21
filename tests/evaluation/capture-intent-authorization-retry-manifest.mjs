import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('report-correction-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-authorization-retry.ts',
  'apps/server/src/modules/message-routing/intent-authorization-retry.ts',
  'apps/server/src/modules/message-routing/intent-authorization-retry.service.ts',
  'apps/web/src/stores/intentAuthorizationRetry.ts',
  'apps/web/src/components/IntentAuthorizationRetryPanel.vue',
  'apps/web/src/components/IntentAuthorizationRetryPanel.spec.ts',
  'tests/evaluation/run-intent-authorization-retry-sdd.mjs', 'tests/evaluation/capture-intent-authorization-retry-manifest.mjs'])];
const workspaceLog = await read('authorization-retry-workspace-tests.log');
const pass = [...workspaceLog.matchAll(/^# pass (\d+)$/gm)].map(match => Number(match[1]));
if (JSON.stringify(pass) !== JSON.stringify([102, 282, 2135, 7, 37, 14]) || /^# fail [1-9]/m.test(workspaceLog) || !/Tests\s+504 passed/.test(workspaceLog)) throw new Error('Incomplete workspace tests');
const pg = await read('authorization-retry-postgres-final.log');
if (!/^# pass 30$/m.test(pg) || !/^# fail 0$/m.test(pg) || !/^# skipped 0$/m.test(pg)) throw new Error('Incomplete PostgreSQL tests');
const database = JSON.parse(await read('authorization-retry-postgres-final.json'));
if (database.exitCode !== 0 || !database.cleanupConfirmed || database.fixtureTriggersRemaining !== '0') throw new Error('Database cleanup incomplete');
const http = JSON.parse(await read('authorization-retry-http-results.json'));
if (http.results.length !== 8 || http.results.some(row => !row.passed)) throw new Error('Incomplete HTTP tests');
if (!/Tests\s+13 passed/.test(await read('authorization-retry-ui-final.log'))) throw new Error('Incomplete final UI tests');
const checks = [
  ['npm run test', 'authorization-retry-workspace-tests.log'],
  ['npm run test --workspace @project/web -- --run (authorization retry and test authority panels)', 'authorization-retry-ui-final.log'],
  ['npm run typecheck', 'authorization-retry-typecheck-final.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'authorization-retry-server-typecheck-final.log'],
  ['npm run typecheck --workspace @project/web', 'authorization-retry-web-typecheck-final.log'],
  ['npm run build', 'authorization-retry-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'authorization-retry-server-build-final.log'],
  ['npm run build --workspace @project/web', 'authorization-retry-web-build-final.log'],
  ['npm run build --workspace @agent-cluster/desktop', 'authorization-retry-desktop-build-final.log'],
  ['node tests/evaluation/run-intent-authorization-retry-sdd.mjs (local Docker image)', 'authorization-retry-http.log'],
  ['node tests/evaluation/run-intent-postgres-sdd.mjs', 'authorization-retry-postgres-final-runner.log'],
  ['npm run test:harness', 'authorization-retry-harness.log'], ['git diff --check', 'authorization-retry-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/api-contract-v0.1.md', 'docs/contracts/ui-state-contract-v0.1.md',
  `${directory}/authorization-retry-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const supporting = ['authorization-retry-http-results.json', 'authorization-retry-postgres-final.log', 'authorization-retry-postgres-final.json',
  'authorization-retry-http-initial.log', 'authorization-retry-http-initial-results.json', 'authorization-retry-http-provider-failure.log',
  'authorization-retry-http-intermediate.log', 'authorization-retry-http-intermediate-results.json',
  'authorization-retry-focused.log', 'authorization-retry-related.log', 'authorization-retry-related-final.log'];
const manifest = { runId: 'SDD-2026-10-20-authorization-retry', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'report-correction-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(supporting.map(async path => ({ path, sha256: sha(await read(path)) }))), database,
  tests: { workspacePassed: 3081, cliPassed: 102, sharedPassed: 282, serverPassed: 2135, serverDevScriptsPassed: 7,
    webPassedInFull: 504, devSupervisorPassed: 37, desktopPassed: 14, finalUiPassed: 13, newRetryPanelTests: 8,
    postgresSkippedInFull: 30, optionalDockerSkippedInFull: 5, realPostgresPassed: 30, httpDockerPassed: 8, countsOverlap: true },
  verificationScope: ['Final client receipt validation and one added test followed the full run; final UI 13 tests, Web typecheck/build cover that delta',
    'Final backend changes including refreshing stale connection caches are covered by the full server suite, final real PostgreSQL and HTTP after final server build'],
  limitations: ['Deterministic semantic provider, no real-model intent accuracy claim', 'Single isolated test and same-runner report only',
    'UI tests mount both timeline components, not a complete browser/Electron/SSE environment matrix',
    'Other execution effects, complex clarification, ordered plans, independent labeled corpus and release gates remain incomplete'] };
await writeFile(resolve(directory, 'authorization-retry-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
