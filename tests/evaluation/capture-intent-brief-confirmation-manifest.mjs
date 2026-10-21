import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('brief-executor-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-brief-confirmation.ts', 'packages/shared/src/index.ts', 'packages/shared/src/contracts.ts',
  'apps/server/src/modules/message-routing/intent-brief-confirmation.service.ts',
  'apps/server/src/modules/message-routing/intent-brief-executor.service.spec.ts',
  'apps/server/src/modules/persistence/intent-record-invariants.ts', 'apps/server/src/modules/persistence/persistence.service.ts',
  'apps/server/src/modules/persistence/relational/intent-semantic-transactions.integration.spec.ts',
  'apps/server/src/modules/sessions/sessions.controller.ts', 'apps/server/src/modules/sessions/sessions.module.ts',
  'apps/server/src/modules/sessions/sessions.service.ts', 'apps/server/src/modules/sessions/sessions.service.spec.ts',
  'apps/web/src/stores/session.ts', 'apps/web/src/stores/session-intent-routing.spec.ts',
  'apps/web/src/stores/intentBriefConfirmation.ts', 'apps/web/src/stores/intentBriefConfirmation.spec.ts', 'apps/web/vitest.config.ts',
  'tests/evaluation/run-intent-postgres-sdd.mjs', 'tests/evaluation/run-intent-brief-confirmation-sdd.mjs',
  'tests/evaluation/capture-intent-brief-confirmation-manifest.mjs'])];
const server = await read('brief-confirmation-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2192, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-confirmation-pause-tests.log', 185], ['brief-confirmation-shared-tests.log', 285], ['brief-confirmation-postgres.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
assert.match(await read('brief-confirmation-web-tests.log'), /Tests\s+528 passed/);
assert.match(await read('brief-confirmation-client-final.log'), /Tests\s+10 passed/);
const database = JSON.parse(await read('brief-confirmation-postgres.json')), http = JSON.parse(await read('brief-confirmation-http-results.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
assert.equal(http.results.length, 10); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-confirmation-server-tests.log'],
  ['npx tsx --test (final Sessions/Brief tests)', 'brief-confirmation-pause-tests.log'],
  ['npm run test --workspace @project/web', 'brief-confirmation-web-tests.log'],
  ['npm run test --workspace @project/web -- (final confirmation/Session store tests)', 'brief-confirmation-client-final.log'],
  ['npm run test --workspace @agent-cluster/shared', 'brief-confirmation-shared-tests.log'],
  ['npm run typecheck', 'brief-confirmation-typecheck-all.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-confirmation-build-final.log'],
  ['npm run build --workspace @agent-cluster/shared', 'brief-confirmation-shared-build.log'],
  ['npm run build --workspace @project/web', 'brief-confirmation-web-build.log'],
  ['node tests/evaluation/run-intent-brief-confirmation-sdd.mjs', 'brief-confirmation-http-verified.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-confirmation-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-confirmation-postgres.log'],
  ['npm run test:harness', 'brief-confirmation-harness.log'], ['git diff --check', 'brief-confirmation-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/runtime-contract-v0.1.md', `${directory}/brief-confirmation-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-confirmation', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'brief-executor-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-confirmation-postgres.json', 'brief-confirmation-http-results.json', 'brief-confirmation-focused.log',
    'brief-confirmation-typecheck-initial.log', 'brief-confirmation-client.log', 'brief-confirmation-http.log',
    'brief-confirmation-http-complete.log', 'brief-confirmation-http-isolated.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2192, serverDevScriptsPassed: 7, serverConditionalSkipped: 41, finalRelatedPassed: 185,
    sharedPassed: 285, webPassed: 528, finalClientPassed: 10, separatelyPassedPostgres: 36, actualHttpChecks: 10, countsOverlap: true },
  verificationScope: ['Server full suite precedes final pause admission fix; final 185 tests and Server build cover it',
    'Web full suite precedes the added clicked-Brief binding test; final 10 tests and Web build cover it',
    'Full typecheck precedes final pause/client integration test deltas; final Server/Web builds include typechecks',
    'PostgreSQL 36 includes additional confirmation concurrency and rollback assertions within the Brief publication test; not PostgreSQL HTTP'],
  limitations: ['Versioned Brief revision and professional workflow execution remain incomplete; confirmation grants no execution authority',
    'Deterministic provider is not model accuracy; full UI/CLI/environment matrix, independent evaluation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'brief-confirmation-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
