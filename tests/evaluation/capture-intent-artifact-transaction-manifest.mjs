import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('postgres-intent-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes), '.gitignore',
  ...['artifact-store.ts', 'artifacts.service.ts', 'artifacts.service.spec.ts', 'artifacts.controller.ts', 'artifacts.module.ts'].map(file => `apps/server/src/modules/artifacts/${file}`),
  'apps/server/src/modules/discussion-documents/discussion-documents.service.ts',
  'tests/evaluation/run-intent-artifact-storage-sdd.mjs', 'tests/evaluation/capture-intent-artifact-transaction-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server', 'artifact-transaction-server-tests.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (artifacts, orchestrator, discussion documents, sessions)', 'artifact-transaction-related-verified.log', 0],
  ['INTENT_POSTGRES_EVIDENCE_PREFIX=artifact-transaction-postgres node tests/evaluation/run-intent-postgres-sdd.mjs', 'artifact-transaction-postgres-runner.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'artifact-transaction-build.log', 0],
  ['node tests/evaluation/run-intent-artifact-storage-sdd.mjs', 'artifact-transaction-http.log', 0],
  ['npm run test:harness', 'artifact-transaction-harness.log', 0], ['git diff --check', 'artifact-transaction-diff-check.log', 0]
];
for (const [file, count] of [['artifact-transaction-server-tests.log', 2117], ['artifact-transaction-related-verified.log', 262], ['artifact-transaction-postgres.log', 26]]) {
  const log = await read(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`Unexpected results: ${file}`);
}
const database = JSON.parse(await read('artifact-transaction-postgres.json'));
const http = JSON.parse(await read('artifact-transaction-http-results.json'));
if (!database.cleanupConfirmed || database.exitCode !== 0 || http.results.length !== 4 || http.results.some(row => !row.passed)) throw new Error('Integration evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/artifact-transaction-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const supporting = ['artifact-transaction-typecheck-first.log', 'artifact-transaction-typecheck-second.log', 'artifact-transaction-related-final.log',
  'artifact-transaction-postgres.log', 'artifact-transaction-postgres.json', 'artifact-transaction-http-results.json'];
const manifest = { runId: 'SDD-2026-10-20-artifact-transaction', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'postgres-intent-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await read(log)) }))),
  supportingEvidence: await Promise.all(supporting.map(async path => ({ path, sha256: sha(await read(path)) }))),
  database,
  tests: { serverPassed: 2117, serverDevScriptsPassed: 7, postgresSkippedInFull: 26, optionalDockerSkippedInFull: 5, realPostgresPassed: 26,
    relatedPassed: 262, httpPassed: 4, countsOverlap: true },
  limitations: ['Artifact transaction foundation only; no new write_artifact grant or executor',
    'HTTP covers existing mock-runtime Brief/document compatibility and actual restart',
    'No real model accuracy, complete client matrix, source/external effect or release completion claim',
    'Artifact reads use the current Persistence projection; cross-process live read synchronization is not newly implemented'] };
await writeFile(resolve(directory, 'artifact-transaction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
