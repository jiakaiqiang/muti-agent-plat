import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('brief-revision-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-brief-retry.ts', 'packages/shared/src/index.ts', 'packages/shared/src/contracts.ts',
  'apps/server/src/modules/message-routing/intent-brief-retry.service.ts', 'apps/server/src/modules/message-routing/intent-execution-guard.ts',
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
  'apps/web/src/stores/intentBriefRetry.ts', 'apps/web/src/components/IntentBriefRetryPanel.vue', 'apps/web/src/components/IntentBriefRetryPanel.spec.ts', 'apps/web/src/components/ChatTimeline.vue', 'apps/desktop/renderer/components/ChatTimeline.vue',
  'apps/web/src/stores/session.ts', 'apps/web/src/stores/session-intent-routing.spec.ts', 'apps/web/vitest.config.ts',
  'tests/evaluation/run-intent-brief-retry-sdd.mjs', 'tests/evaluation/capture-intent-brief-retry-manifest.mjs'])];
const server = await read('brief-retry-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2212, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-retry-final-focused.log', 35], ['brief-retry-postgres.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
assert.match(await read('brief-retry-web-tests.log'), /Tests\s+538 passed/);
assert.match(await read('brief-retry-client-tests.log'), /Tests\s+4 passed/);
const database = JSON.parse(await read('brief-retry-postgres.json')), http = JSON.parse(await read('brief-retry-http-results.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
assert.equal(http.results.length, 6); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-retry-server-tests.log'],
  ['npx tsx --test (Runtime/LogicalOperation/Brief)', 'brief-retry-regression.log'],
  ['npx tsx --test (final Brief)', 'brief-retry-final-focused.log'],
  ['npm run test --workspace @project/web', 'brief-retry-web-tests.log'],
  ['vitest run (Brief retry panel)', 'brief-retry-client-tests.log'],
  ['npm run typecheck', 'brief-retry-typecheck-final.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'brief-retry-typecheck-server-final.log'],
  ['npm run build --workspace @agent-cluster/shared', 'brief-retry-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-retry-server-build-final.log'],
  ['npm run build --workspace @project/web', 'brief-retry-web-build.log'],
  ['node tests/evaluation/run-intent-brief-retry-sdd.mjs', 'brief-retry-http-complete.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-retry-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-retry-postgres.log'],
  ['npm run test:harness', 'brief-retry-harness.log'], ['git diff --check', 'brief-retry-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/runtime-contract-v0.1.md',
  `${directory}/brief-retry-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-retry', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'brief-revision-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-retry-postgres.json', 'brief-retry-http-results.json',
    'brief-retry-http.log', 'brief-retry-http-diagnostic.log', 'brief-retry-focused.log',
    'brief-retry-focused-complete.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2212, serverDevScriptsPassed: 7, serverConditionalSkipped: 41, relatedPassed: 125,
    finalBriefPassed: 35, webPassed: 538, clientPassed: 4, separatelyPassedPostgres: 36, actualHttpChecks: 6, countsOverlap: true },
  verificationScope: ['Final Brief query test added after full Server enumeration; final 35 and Server typecheck cover it',
    'Final Server build/HTTP include all production changes; later additions are PostgreSQL and read-only query tests',
    'PostgreSQL 36 includes two-connection explicit Brief retry and immutable historical receipt assertions in an existing test',
    'No full workspace test, real browser or Electron interaction in this milestone'],
  limitations: ['Authentication immediate-retry fixture was blocked by existing provider circuit; final HTTP proves schema-budget recovery, not repaired-auth success',
    'Circuit remaining-time UI, directed Agent revision, complex clarification/correction and professional workflow remain incomplete',
    'Deterministic provider is not accuracy; independent evaluation, complete environment matrix and release gates remain incomplete'] };

await writeFile(resolve(directory, 'brief-retry-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
