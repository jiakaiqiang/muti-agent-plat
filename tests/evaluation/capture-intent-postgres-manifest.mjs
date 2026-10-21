import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('semantic-clarification-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/persistence/relational/intent-semantic-transactions.integration.spec.ts',
  'apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts',
  'tests/evaluation/run-intent-postgres-sdd.mjs', 'tests/evaluation/capture-intent-postgres-manifest.mjs'])];
const checks = [
  ['RELATIONAL_TEST_DATABASE_URL=isolated-fixture npx tsx --test --test-concurrency=1 --tsconfig apps/server/tsconfig.json (three PostgreSQL integration suites)', 'postgres-intent-complete.log', 0],
  ['node tests/evaluation/run-intent-postgres-sdd.mjs', 'postgres-intent-runner.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (LogicalOperation, correction acceptance/planner, clarification)', 'postgres-intent-file-regression.log', 0],
  ['npm run typecheck --workspace @agent-cluster/server', 'postgres-intent-typecheck.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'postgres-intent-build.log', 0],
  ['npm run test:harness', 'postgres-intent-harness.log', 0], ['git diff --check', 'postgres-intent-diff-check.log', 0]
];
for (const [file, count] of [['postgres-intent-complete.log', 25], ['postgres-intent-repro.log', 25], ['postgres-intent-file-regression.log', 65]]) {
  const log = await read(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || !/^# skipped 0$/m.test(log) || !/^# fail 0$/m.test(log)) throw new Error(`Unexpected results: ${file}`);
}
const environment = JSON.parse(await read('postgres-intent-repro.json'));
const cleanup = JSON.parse((await read('postgres-intent-cleanup.json')).replace(/^\uFEFF/, ''));
if (environment.exitCode !== 0 || !environment.cleanupConfirmed || environment.fixtureTriggersRemaining !== '0' || cleanup.remainingContainers !== 0) throw new Error('Cleanup evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/postgres-intent-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const evidence = ['postgres-intent-baseline.log', 'postgres-intent-transactions-first.log', 'postgres-intent-transactions-second.log',
  'postgres-intent-repro.log', 'postgres-intent-repro.json', 'postgres-intent-cleanup.json'];
const manifest = { runId: 'SDD-2026-10-20-postgres-intent', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'semantic-clarification-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(evidence.map(async path => ({ path, sha256: sha(await read(path)) }))),
  environment, cleanup,
  tests: { realPostgresPassed: 25, realPostgresSkipped: 0, newSemanticTransactionCases: 4, fileRelatedPassed: 65, repeatedDatabaseRunIsNotAdditionalCases: true },
  limitations: ['Deterministic service classifiers, not real model accuracy or HTTP/dual-client coverage',
    'Independent database connections and reconstructed services, not independent worker process crash coverage',
    'No full backend/runtime matrix, mixed-worker migration rollout, source/artifact executors or release completion',
    'Whole workspace tests were not rerun; focused File and SQL tests cover the reservation check-order change'] };
await writeFile(resolve(directory, 'postgres-intent-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests, cleanupConfirmed: environment.cleanupConfirmed }));
