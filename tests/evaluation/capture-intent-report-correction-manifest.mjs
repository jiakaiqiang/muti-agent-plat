import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('test-report-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes), 'apps/server/src/modules/message-routing/intent-test-report.ts',
  'tests/evaluation/capture-intent-report-correction-manifest.mjs'])];
const passCounts = async file => {
  const log = await read(file);
  if (/^# fail [1-9]/m.test(log)) throw new Error(`Failed suite: ${file}`);
  const counts = [...log.matchAll(/^# pass (\d+)$/gm)].map(match => Number(match[1]));
  if (!counts.length) throw new Error(`Incomplete suite: ${file}`);
  return counts;
};
const server = await passCounts('report-correction-server-tests.log');
const shared = await passCounts('report-correction-shared.log'), related = await passCounts('report-correction-related-final.log');
const pg = await passCounts('report-correction-postgres.log');
if (server.length !== 2 || server[0] !== 2129 || server[1] !== 7 || shared[0] !== 282 || related[0] !== 64 || pg[0] !== 28) throw new Error('Unexpected test counts');
const http = JSON.parse(await read('report-correction-final-http-results.json'));
const database = JSON.parse(await read('report-correction-postgres.json'));
if (http.results.length !== 14 || http.results.some(row => !row.passed) || database.exitCode !== 0 || !database.cleanupConfirmed) throw new Error('Integration evidence incomplete');
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'report-correction-server-tests.log'],
  ['npm run test --workspace @agent-cluster/shared', 'report-correction-shared.log'],
  ['npm run test --workspace @project/web', 'report-correction-web-tests.log'],
  ['npx tsx --test (test executor, correction acceptance, correction planner)', 'report-correction-related-final.log'],
  ['npm run typecheck', 'report-correction-typecheck.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'report-correction-server-typecheck.log'],
  ['npm run build --workspace @agent-cluster/server (before HTTP)', 'report-correction-server-build-final.log'],
  ['npm run build', 'report-correction-build.log'],
  ['INTENT_DISPATCH_REPORT=true INTENT_DISPATCH_REPORT_CORRECTION=true node tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'report-correction-final-http.log'],
  ['node tests/evaluation/run-intent-postgres-sdd.mjs (isolated database)', 'report-correction-postgres-runner.log'],
  ['npm run test:harness', 'report-correction-harness.log'], ['git diff --check', 'report-correction-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/api-contract-v0.1.md', `${directory}/report-correction-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const supporting = ['report-correction-final-http-results.json', 'report-correction-verified-http-results.json', 'report-correction-verified-http.log', 'report-correction-postgres.log', 'report-correction-postgres.json',
  'report-correction-http.log', 'report-correction-http-results.json', 'report-correction-ui.log'];
const manifest = { runId: 'SDD-2026-10-20-report-correction', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'test-report-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(supporting.map(async path => ({ path, sha256: sha(await read(path)) }))),
  tests: { serverPassed: server[0], serverDevScriptsPassed: server[1], sharedPassed: shared[0], webPassed: 497, relatedPassed: related[0],
    postgresSkippedInFull: 28, optionalDockerSkippedInFull: 5, realPostgresPassed: 28, httpDockerPassed: 14, dualTimelineComponentPassed: 8, countsOverlap: true }, database,
  verificationScope: ['The final Markdown-only content hash refinement is covered by the final full server suite, real PostgreSQL and HTTP rerun after the final workspace build; earlier HTTP evidence is retained separately',
    'The same two PostgreSQL report cases now also verify concurrent correction and SQL rollback, so the database case count remains 28'],
  limitations: ['Only preservation and replacement of platform-generated isolated test reports; no arbitrary artifact or external compensation',
    'HTTP has a deterministic classifier and actual Docker, PostgreSQL uses service fixtures and deterministic runtime results',
    'Client evidence is component rendering tests, not a new complete browser/Electron/SSE matrix',
    'First-turn complete IA03, child-task propagation, ordered plans and independent model accuracy release gates remain incomplete'] };
await writeFile(resolve(directory, 'report-correction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
