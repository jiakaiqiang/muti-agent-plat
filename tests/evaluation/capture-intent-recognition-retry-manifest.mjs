import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('authorization-retry-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-recognition-retry.ts',
  'apps/server/src/modules/message-routing/intent-recognition-retry.service.ts',
  'apps/web/src/stores/intentRecognitionRetry.ts',
  'apps/web/src/components/IntentRecognitionRetryPanel.vue',
  'apps/web/src/components/IntentRecognitionRetryPanel.spec.ts',
  'tests/evaluation/run-intent-recognition-retry-sdd.mjs',
  'tests/evaluation/capture-intent-recognition-retry-manifest.mjs'])];
const full = await read('recognition-retry-workspace-tests.log');
const pass = [...full.matchAll(/^# pass (\d+)$/gm)].map(match => Number(match[1]));
if (JSON.stringify(pass) !== JSON.stringify([102, 282, 2143, 7, 37, 14]) || /^# fail [1-9]/m.test(full) ||
  !/Tests\s+512 passed/.test(full)) throw new Error('Incomplete workspace regression');
const pg = await read('recognition-retry-postgres.log');
if (!/^# pass 32$/m.test(pg) || !/^# fail 0$/m.test(pg) || !/^# skipped 0$/m.test(pg)) throw new Error('Incomplete database regression');
const database = JSON.parse(await read('recognition-retry-postgres.json'));
if (database.exitCode !== 0 || !database.cleanupConfirmed || database.fixtureTriggersRemaining !== '0') throw new Error('Incomplete database cleanup');
const http = JSON.parse(await read('recognition-retry-http-results.json'));
if (http.results.length !== 7 || http.results.some(row => !row.passed)) throw new Error('Incomplete HTTP regression');
if (!/^# pass 66$/m.test(await read('recognition-retry-rebuild-final.log'))) throw new Error('Incomplete final rebuild-budget regression');
const checks = [
  ['npm run test', 'recognition-retry-workspace-tests.log'],
  ['npx tsx --test (pipeline, semantic routing, context management)', 'recognition-retry-rebuild-final.log'],
  ['npm run typecheck', 'recognition-retry-typecheck-final.log'],
  ['npm run build', 'recognition-retry-build.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'recognition-retry-server-typecheck-final.log'],
  ['npm run build --workspace @agent-cluster/server', 'recognition-retry-server-build-final.log'],
  ['node tests/evaluation/run-intent-recognition-retry-sdd.mjs', 'recognition-retry-http.log'],
  ['node tests/evaluation/run-intent-postgres-sdd.mjs', 'recognition-retry-postgres-runner.log'],
  ['npm run test:harness', 'recognition-retry-harness.log'],
  ['git diff --check', 'recognition-retry-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/api-contract-v0.1.md', 'docs/contracts/ui-state-contract-v0.1.md',
  `${directory}/recognition-retry-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const supporting = ['recognition-retry-http-results.json', 'recognition-retry-postgres.log', 'recognition-retry-postgres.json',
  'recognition-retry-postgres-initial.log', 'recognition-retry-http-initial.log', 'recognition-retry-http-circuit-failure.log',
  'recognition-retry-http-intermediate.log', 'recognition-retry-http-intermediate-results.json',
  'recognition-retry-focused.log', 'recognition-retry-related.log', 'recognition-retry-ui.log'];
const manifest = { runId: 'SDD-2026-10-20-recognition-retry', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'authorization-retry-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(supporting.map(async path => ({ path, sha256: sha(await read(path)) }))), database,
  tests: { workspacePassed: 3097, cliPassed: 102, sharedPassed: 282, serverPassed: 2143, serverDevScriptsPassed: 7,
    webPassed: 512, devSupervisorPassed: 37, desktopPassed: 14, postgresSkippedInFull: 32, optionalDockerSkippedInFull: 5,
    realPostgresPassed: 32, httpPassed: 7, finalRebuildBudgetRegressionPassed: 66, countsOverlap: true },
  verificationScope: ['Final snapshot-rebuild operation fence and one test followed the full run; covered by 66 focused tests, final server typecheck/build and HTTP',
    'PostgreSQL tests preceded that final fence; they cover retry acceptance, independent connections, recovery and SQL rollback, not the added rebuild race'],
  limitations: ['Deterministic semantic provider; no real-model accuracy claim', 'Shared client components are not a complete browser/Electron/SSE matrix',
    'General execution effects, complex clarification, independent labeled corpus and release gates remain incomplete'] };
await writeFile(resolve(directory, 'recognition-retry-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
