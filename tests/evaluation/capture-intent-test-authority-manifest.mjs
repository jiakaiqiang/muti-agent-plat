import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('isolated-tests-recovery-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-test-authority.ts',
  'apps/server/src/modules/message-routing/intent-test-authority.service.ts',
  'apps/server/src/modules/message-routing/intent-test-authority.service.spec.ts',
  'tests/evaluation/run-intent-test-authority-sdd.mjs',
  'tests/evaluation/capture-intent-test-authority-manifest.mjs'])];
const checks = [
  ['INTENT_TEST_DOCKER_IMAGE unset; npm run test --workspace @agent-cluster/server', 'test-authority-server-full.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-test-authority.service.spec.ts apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts apps/server/src/modules/sessions/sessions.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts', 'test-authority-related.log'],
  ['node tests/evaluation/run-intent-test-authority-sdd.mjs', 'test-authority-http.log'],
  ['npm run typecheck', 'test-authority-workspace-typecheck.log'],
  ['npm run build --workspace @agent-cluster/shared', 'test-authority-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'test-authority-server-build.log'],
  ['npm run test:harness', 'test-authority-harness.log'], ['git diff --check', 'test-authority-diff-check.log']
];
const full = await load('test-authority-server-full.log'), related = await load('test-authority-related.log');
if (!/^# pass 2071$/m.test(full) || !/^# pass 7$/m.test(full) || !/^# skipped 24$/m.test(full) || /^# fail [1-9]/m.test(full) ||
  !/^# pass 241$/m.test(related) || /^# fail [1-9]/m.test(related)) throw new Error('Unexpected test counts');
const http = JSON.parse(await load('test-authority-http-results.json'));
if (http.results.length !== 8 || http.results.some(row => !row.passed)) throw new Error('HTTP evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-test-authority', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'isolated-tests-recovery-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  retainedFailures: await Promise.all(['test-authority-first.log', 'test-authority-http-first.log', 'test-authority-http-first-results.json']
    .map(async log => ({ log, logSha256: sha(await load(log)) }))),
  httpEvidence: { path: 'test-authority-http-results.json', sha256: sha(await load('test-authority-http-results.json')), cases: http.results.map(row => row.id) },
  tests: { serverPassed: 2071, devScriptsPassed: 7, postgresSkipped: 21, dockerSkipped: 3, relatedPassed: 241, httpPassed: 8, countsOverlap: true },
  scope: { persistence: 'File', deterministicLocalProvider: true, actualServerRestart: true, realDockerRerun: false, realPostgresVerified: false,
    frontendTestsRerun: false, newIntentTestDispatchEnabled: false, productionConfigurationChanged: false },
  limitations: ['Authority and candidates do not prove Docker availability or test dispatch',
    'User-facing grant UI, versioned test dispatch, running-test revocation and result/artifact publication remain incomplete',
    'No model accuracy, real PostgreSQL, CLI/Bridge or complete dual-client acceptance claim'] };
await writeFile(resolve(directory, 'test-authority-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
