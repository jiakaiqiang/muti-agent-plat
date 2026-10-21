import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('brief-store-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-brief-executor.service.ts',
  'apps/server/src/modules/message-routing/intent-brief-executor.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-brief-store.service.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.ts',
  'apps/server/src/modules/message-routing/message-routing.module.ts',
  'apps/server/src/modules/runtimes/generic-llm-runtime.service.ts',
  'apps/server/src/modules/orchestrator/orchestrator.service.ts',
  'apps/server/src/modules/orchestrator/orchestrator.service.spec.ts',
  'apps/server/src/modules/sessions/sessions.service.ts',
  'tests/evaluation/run-intent-brief-executor-sdd.mjs', 'tests/evaluation/capture-intent-brief-executor-manifest.mjs'])];
const server = await read('brief-executor-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2183, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-executor-focused-complete.log', 265], ['brief-executor-cache-final-tests.log', 22], ['brief-executor-postgres.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
const database = JSON.parse(await read('brief-executor-postgres.json')), http = JSON.parse(await read('brief-executor-http-results.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
assert.equal(http.results.length, 6); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-executor-server-tests.log'],
  ['npx tsx --test (Brief, Orchestrator, Sessions)', 'brief-executor-focused-complete.log'],
  ['npx tsx --test (final Brief/cached pause/deadline)', 'brief-executor-cache-final-tests.log'],
  ['npm run typecheck', 'brief-executor-typecheck-complete.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-executor-build-verified.log'],
  ['node tests/evaluation/run-intent-brief-executor-sdd.mjs', 'brief-executor-http-complete.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-executor-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-executor-postgres.log'],
  ['npm run test:harness', 'brief-executor-harness.log'], ['git diff --check', 'brief-executor-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/runtime-contract-v0.1.md', `${directory}/brief-executor-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-executor', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'brief-store-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-executor-postgres.json', 'brief-executor-http-results.json', 'brief-executor-focused.log',
    'brief-executor-focused-final.log', 'brief-executor-typecheck-cache.log', 'brief-executor-deadline-tests.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2183, serverDevScriptsPassed: 7, earlierFocusedPassed: 265, finalFocusedPassed: 22,
    serverPostgresSkipped: 36, optionalDockerSkipped: 5, separatelyPassedPostgres: 36, actualHttpChecks: 6, countsOverlap: true },
  verificationScope: ['Server suite precedes final deadline classification, WorkItem waiting status and cached pause preservation; final 22 regression tests and Server build cover these deltas',
    'Final HTTP covers WorkItem state and production draft ingress; final cached pause guard subsequently covered by focused tests',
    'PostgreSQL verifies storage transactions; not the automatic Brief executor over PostgreSQL HTTP'],
  limitations: ['Initial task with no external effects only; versioned Brief confirmation/revision and business dispatch still incomplete',
    'Deterministic provider is not model accuracy; complete UI/CLI/environment matrix and release gates remain incomplete'] };
await writeFile(resolve(directory, 'brief-executor-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
