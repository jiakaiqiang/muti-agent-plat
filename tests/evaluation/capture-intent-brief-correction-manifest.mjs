import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('brief-confirmation-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/context-management/effective-decisions.ts', 'apps/server/src/modules/context-management/effective-decisions.spec.ts',
  'apps/server/src/modules/message-routing/intent-brief-store.service.ts', 'apps/server/src/modules/message-routing/intent-brief-executor.service.ts',
  'apps/server/src/modules/message-routing/intent-brief-executor.service.spec.ts', 'apps/server/src/modules/message-routing/intent-correction-planner.service.ts',
  'apps/server/src/modules/message-routing/intent-correction-state.ts', 'apps/server/src/modules/message-routing/message-routing.module.ts',
  'apps/server/src/modules/sessions/sessions.service.ts', 'packages/shared/src/contracts.ts', 'packages/shared/src/intent-plan-contracts.ts',
  'apps/server/src/modules/persistence/relational/intent-semantic-transactions.integration.spec.ts',
  'tests/evaluation/run-intent-brief-correction-sdd.mjs', 'tests/evaluation/capture-intent-brief-correction-manifest.mjs'])];
const server = await read('brief-correction-server-tests-complete.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2198, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-correction-final-focused.log', 74], ['brief-correction-constraint-tests.log', 2], ['brief-correction-postgres.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
const database = JSON.parse(await read('brief-correction-postgres.json')), http = JSON.parse(await read('brief-correction-http-results.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
assert.equal(http.results.length, 6); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-correction-server-tests-complete.log'],
  ['npx tsx --test (Pipeline/Correction/Brief)', 'brief-correction-final-focused.log'],
  ['npx tsx --test (constraint projection)', 'brief-correction-constraint-tests.log'],
  ['npm run typecheck', 'brief-correction-typecheck-all.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'brief-correction-typecheck-final.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-correction-server-build-complete.log'],
  ['npm run build --workspace @agent-cluster/shared', 'brief-correction-shared-build.log'],
  ['node tests/evaluation/run-intent-brief-correction-sdd.mjs', 'brief-correction-http-complete.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-correction-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-correction-postgres.log'],
  ['npm run test:harness', 'brief-correction-harness.log'], ['git diff --check', 'brief-correction-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/runtime-contract-v0.1.md',
  `${directory}/brief-correction-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-correction', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'brief-confirmation-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-correction-postgres.json', 'brief-correction-http-results.json', 'brief-correction-focused.log',
    'brief-correction-focused-complete.log', 'brief-correction-server-build.log', 'brief-correction-server-build-final.log',
    'brief-correction-http.log', 'brief-correction-server-tests.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2198, serverDevScriptsPassed: 7, serverConditionalSkipped: 41, relatedPassed: 74,
    additionalConstraintPassed: 2, separatelyPassedPostgres: 36, actualHttpChecks: 6, countsOverlap: true },
  verificationScope: ['Two added constraint projection tests ran after Server test file enumeration; independently passed and covered by final Server typecheck',
    'Final Server build/HTTP precede only those two pure test additions; production source unchanged',
    'PostgreSQL 36 includes correction-derived Brief and independent concurrent publication assertions within existing Brief test; not PostgreSQL HTTP',
    'No frontend product change, browser run or complete workspace test in this milestone'],
  limitations: ['Structured revision form, explicit failed-generation recovery and professional workflow execution remain incomplete',
    'Deterministic provider is not model accuracy; full UI/CLI/environment matrix, independent evaluation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'brief-correction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
