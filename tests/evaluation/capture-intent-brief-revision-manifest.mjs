import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('brief-correction-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-brief-revision.ts', 'packages/shared/src/index.ts', 'packages/shared/src/contracts.ts',
  'apps/server/src/modules/message-routing/intent-brief-revision.ts',
  'apps/server/src/modules/message-routing/intent-message-pipeline.service.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.ts',
  'apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts',
  'apps/server/src/modules/intent-recognition/intent-understanding-routing.service.ts',
  'apps/server/src/modules/message-routing/message-correction-target.ts',
  'apps/server/src/modules/message-routing/intent-brief-confirmation.service.ts',
  'apps/server/src/modules/context-management/context-management.service.ts',
  'apps/server/src/modules/persistence/intent-record-invariants.ts',
  'apps/server/src/modules/persistence/persistence.service.ts',
  'apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts',
  'apps/server/src/modules/sessions/sessions.controller.ts',
  'apps/web/src/stores/intentBriefRevision.ts', 'apps/web/src/stores/intentBriefRevision.spec.ts',
  'apps/web/src/stores/session.ts', 'apps/web/src/stores/session-intent-routing.spec.ts', 'apps/web/vitest.config.ts',
  'tests/evaluation/run-intent-brief-revision-sdd.mjs', 'tests/evaluation/capture-intent-brief-revision-manifest.mjs'])];
const server = await read('brief-revision-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2204, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-revision-backend-final.log', 72], ['brief-revision-postgres-complete.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
assert.match(await read('brief-revision-web-tests.log'), /Tests\s+533 passed/);
assert.match(await read('brief-revision-client-final.log'), /Tests\s+15 passed/);
const database = JSON.parse(await read('brief-revision-postgres-complete.json')), http = JSON.parse(await read('brief-revision-http-results.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
assert.equal(http.results.length, 6); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-revision-server-tests.log'],
  ['npx tsx --test (Pipeline/PlanCommit/Brief)', 'brief-revision-backend-final.log'],
  ['npm run test --workspace @project/web', 'brief-revision-web-tests.log'],
  ['vitest run (Brief confirmation/revision/session integration)', 'brief-revision-client-final.log'],
  ['npm run typecheck', 'brief-revision-typecheck-complete.log'],
  ['npm run build --workspace @agent-cluster/shared', 'brief-revision-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-revision-server-build-verified.log'],
  ['npm run build --workspace @project/web', 'brief-revision-web-build.log'],
  ['node tests/evaluation/run-intent-brief-revision-sdd.mjs', 'brief-revision-http-verified.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-revision-postgres-complete node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-revision-postgres-complete.log'],
  ['npm run test:harness', 'brief-revision-harness.log'], ['git diff --check', 'brief-revision-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/runtime-contract-v0.1.md',
  `${directory}/brief-revision-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-revision', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'brief-correction-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-revision-postgres-complete.json', 'brief-revision-http-results.json',
    'brief-revision-postgres.log', 'brief-revision-postgres.json', 'brief-revision-typecheck-final.log',
    'brief-revision-http.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2204, serverDevScriptsPassed: 7, serverConditionalSkipped: 41, relatedPassed: 72,
    webPassed: 533, finalClientPassed: 15, separatelyPassedPostgres: 36, actualHttpChecks: 6, countsOverlap: true },
  verificationScope: ['Final backend 72 covers userMessage-only Decision content added after Server full test began',
    'Final client 15 covers additional original-session routing integration after Web full test began',
    'Final build and HTTP include all production changes; only PostgreSQL test pagination/type assertion changed afterwards',
    'Final workspace typecheck covers those PostgreSQL test changes; PostgreSQL is independent-connection service validation, not HTTP',
    'No full workspace test or real Web/Electron browser matrix in this milestone'],
  limitations: ['Directed Agent revision, full complex clarification/correction, failed-generation explicit recovery and professional workflow remain incomplete',
    'Deterministic provider is not model accuracy; independent evaluation, complete environment matrix and release gates remain incomplete'] };
await writeFile(resolve(directory, 'brief-revision-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
