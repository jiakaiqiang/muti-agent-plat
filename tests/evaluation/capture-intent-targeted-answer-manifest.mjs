import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('claude-classifier-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/route-plan-compiler.service.ts',
  'apps/server/src/modules/message-routing/route-plan-compiler.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-answer-executor.service.ts',
  'apps/server/src/modules/message-routing/intent-answer-executor.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-execution-guard.ts',
  'apps/server/src/modules/persistence/relational/intent-semantic-transactions.integration.spec.ts',
  'tests/evaluation/run-intent-postgres-sdd.mjs',
  'tests/evaluation/run-intent-targeted-answer-sdd.mjs',
  'tests/evaluation/capture-intent-targeted-answer-manifest.mjs'])];
const server = await read('targeted-answer-server-tests.log');
assert.deepEqual([...server.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1])), [2162, 7]);
assert.doesNotMatch(server, /^# fail [1-9]/m); assert.match(server, /^# skipped 37$/m);
const postgres = await read('targeted-answer-postgres.log'), database = JSON.parse(await read('targeted-answer-postgres.json'));
assert.match(postgres, /^# pass 34$/m); assert.match(postgres, /^# fail 0$/m); assert.match(postgres, /^# skipped 0$/m);
assert.equal(database.exitCode, 0); assert.equal(database.cleanupConfirmed, true); assert.equal(database.fixtureTriggersRemaining, '0');
const http = JSON.parse(await read('targeted-answer-http-results.json'));
assert.equal(http.results.length, 5); assert.ok(http.results.every(row => row.passed));
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'targeted-answer-server-tests.log'],
  ['npm run typecheck', 'targeted-answer-typecheck-final.log'],
  ['npm run build --workspace @agent-cluster/server', 'targeted-answer-build-complete.log'],
  ['node tests/evaluation/run-intent-targeted-answer-sdd.mjs', 'targeted-answer-http-final.log'],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=targeted-answer-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'targeted-answer-postgres.log'],
  ['npm run test:harness', 'targeted-answer-harness.log'],
  ['git diff --check', 'targeted-answer-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/runtime-contract-v0.1.md', 'docs/contracts/event-contract-v0.1.md', `${directory}/targeted-answer-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-targeted-answer', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'claude-classifier-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['targeted-answer-http-results.json', 'targeted-answer-postgres.json',
    'targeted-answer-focused.log', 'targeted-answer-focused-final.log', 'targeted-answer-typecheck.log',
    'targeted-answer-typecheck-complete.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2162, serverDevScriptsPassed: 7, serverPostgresSkipped: 32, optionalDockerSkipped: 5,
    separatelyPassedPostgres: 34, actualHttpChecks: 5, countsOverlap: true },
  verificationScope: ['Server suite includes all production changes and eight local regression additions; two PostgreSQL tests were added later and run separately against an isolated PostgreSQL 16.13 container',
    'HTTP uses actual Nest/Generic LLM/File with deterministic provider and actual process restart; PostgreSQL uses independent connections and service fixtures',
    'Whole workspace typecheck passed; no new whole workspace test or full Web/Desktop build claim'],
  limitations: ['No model accuracy claim, no full Electron/SSE/PostgreSQL HTTP crash matrix',
    'No multi-process File writer guarantee, no ordered multi-intent execution',
    'Independent labelled evaluation, general business effects and release gates remain incomplete'] };
await writeFile(resolve(directory, 'targeted-answer-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
