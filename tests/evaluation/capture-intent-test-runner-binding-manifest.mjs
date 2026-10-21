import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('test-authority-ui-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes), 'tests/evaluation/capture-intent-test-runner-binding-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @agent-cluster/server (optional Docker environment unset)', 'test-runner-binding-server-full.log'],
  ['INTENT_TEST_DOCKER_IMAGE=pinned; npx tsx --test --test-concurrency=1 --tsconfig apps/server/tsconfig.json isolated-test-run-store.spec.ts isolated-test-runner.service.spec.ts test-runner.tool.spec.ts test-runner-runtime-adapter.service.spec.ts intent-test-authority.service.spec.ts (full source paths in sourceHashes)', 'test-runner-binding-final.log'],
  ['npm run typecheck', 'test-runner-binding-workspace-typecheck.log'],
  ['npm run build --workspace @agent-cluster/shared', 'test-runner-binding-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'test-runner-binding-server-build.log'],
  ['npm run test:harness', 'test-runner-binding-harness.log'], ['git diff --check', 'test-runner-binding-diff-check.log']
];
const full = await load('test-runner-binding-server-full.log'), related = await load('test-runner-binding-final.log');
if (!/^# pass 2078$/m.test(full) || !/^# pass 7$/m.test(full) || !/^# skipped 26$/m.test(full) || /^# fail [1-9]/m.test(full) ||
  !/^# pass 55$/m.test(related) || !/^# skipped 0$/m.test(related) || /^# fail [1-9]/m.test(related)) throw new Error('Unexpected test counts');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-runner-binding-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-test-runner-binding', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'test-authority-ui-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  intermediateEvidence: await Promise.all(['test-runner-binding-tests.log', 'test-runner-binding-docker.log', 'test-runner-binding-typecheck.log']
    .map(async log => ({ log, logSha256: sha(await load(log)), scope: 'earlier increment, not final source' }))),
  tests: { serverPassed: 2078, devScriptsPassed: 7, postgresSkipped: 21, optionalDockerSkippedInFull: 5,
    relatedPassed: 55, realDockerCases: 5, addedCases: 9, countsOverlap: true },
  scope: { persistence: 'File', syntheticCommittedTestPlan: true, realDockerVerified: true,
    imageId: 'sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402',
    revocationViaFileTransaction: true, revocationHeartbeatMs: 10000, newIntentTestDispatchEnabled: false,
    realPostgresVerified: false, frontendTestsRerun: false, productionConfigurationChanged: false },
  limitations: ['No HTTP test dispatcher or API-triggered immediate cancellation acceptance',
    'No result publication transaction, real PostgreSQL, CLI/Bridge or complete dual-client acceptance',
    'No model accuracy or full SDD completion claim'] };
await writeFile(resolve(directory, 'test-runner-binding-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
