import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('targeted-answer-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-brief-store.service.ts',
  'apps/server/src/modules/message-routing/intent-brief-store.service.spec.ts',
  'packages/shared/src/intent-plan-contracts.ts', 'packages/shared/src/intent-correction-contracts.ts',
  'packages/shared/src/intent-runtime-policy.ts', 'packages/shared/src/intent-runtime-policy.spec.ts',
  'packages/shared/src/contracts.ts', 'apps/server/src/modules/persistence/intent-record-invariants.ts',
  'apps/server/src/modules/message-routing/intent-execution-guard.ts',
  'apps/server/src/modules/persistence/relational/intent-semantic-transactions.integration.spec.ts',
  'tests/evaluation/run-intent-postgres-sdd.mjs', 'tests/evaluation/capture-intent-brief-store-manifest.mjs'])];
const server = await read('brief-store-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2174, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 41$/m);
for (const [log, count] of [['brief-store-shared-tests.log', 285], ['brief-store-focused-final.log', 58], ['brief-store-postgres-complete.log', 36]]) {
  const content = await read(log); assert.match(content, new RegExp(`^# pass ${count}$`, 'm')); assert.match(content, /^# fail 0$/m);
}
const database = JSON.parse(await read('brief-store-postgres-complete.json'));
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'brief-store-server-tests.log'],
  ['npm run test --workspace @agent-cluster/shared', 'brief-store-shared-tests.log'],
  ['npx tsx --test (Brief store, plan commit, answer executor, runtime policy)', 'brief-store-focused-final.log'],
  ['npm run typecheck', 'brief-store-typecheck-complete.log'],
  ['npm run build --workspace @agent-cluster/shared', 'brief-store-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'brief-store-server-build.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=brief-store-postgres-complete node tests/evaluation/run-intent-postgres-sdd.mjs', 'brief-store-postgres-complete.log'],
  ['npm run test:harness', 'brief-store-harness.log'], ['git diff --check', 'brief-store-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/runtime-contract-v0.1.md', `${directory}/brief-store-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-brief-store', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'targeted-answer-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['brief-store-postgres.json', 'brief-store-postgres-final.json', 'brief-store-postgres-complete.json',
    'brief-store-typecheck-initial.log', 'brief-store-focused.log', 'brief-store-postgres-run-final.log', 'brief-store-postgres-run-complete.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2174, serverDevScriptsPassed: 7, sharedPassed: 285, focusedPassed: 58,
    serverPostgresSkipped: 36, optionalDockerSkipped: 5, separatelyPassedPostgres: 36, countsOverlap: true },
  verificationScope: ['All production changes covered by Server/Shared suites, whole workspace typecheck and Shared/Server builds',
    'Final nonempty PostgreSQL suggested-task fixture added after Server suite, verified by final isolated PostgreSQL run',
    'Real plan transaction with test-injected derived step and stored model fixture; not production dispatch or HTTP/model generation'],
  limitations: ['Brief store/derivation/runtime guards only; automatic executor and production registration not implemented',
    'Legacy Brief cache migration, confirmation/business dispatch, model evaluation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'brief-store-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
