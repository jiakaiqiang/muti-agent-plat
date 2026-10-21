import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('isolated-tests-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/runtimes/isolated-test-run-store.ts',
  'apps/server/src/modules/runtimes/isolated-test-run-store.spec.ts',
  'tests/evaluation/isolated-test-crash-worker.ts',
  'tests/evaluation/capture-intent-isolated-tests-recovery-manifest.mjs'])];
const image = 'sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const relatedFiles = ['isolated-test-run-store.spec.ts', 'isolated-test-runner.service.spec.ts',
  '../tools/builtin/test-runner.tool.spec.ts', 'test-runner-runtime-adapter.service.spec.ts', 'logical-operation-store.spec.ts', 'runtime.service.spec.ts']
  .map(path => `apps/server/src/modules/runtimes/${path}`).join(' ');
const checks = [
  ['INTENT_TEST_DOCKER_IMAGE unset; npm run test --workspace @agent-cluster/server', 'isolated-tests-recovery-server-unit-final.log', 0],
  [`INTENT_TEST_DOCKER_IMAGE=${image} npx tsx --test --test-concurrency=1 --tsconfig apps/server/tsconfig.json ${relatedFiles}`, 'isolated-tests-recovery-docker-final.log', 0],
  ['npm run typecheck', 'isolated-tests-recovery-typecheck-final.log', 0],
  ['npm run build --workspace @agent-cluster/shared', 'isolated-tests-recovery-shared-build.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'isolated-tests-recovery-server-build.log', 0],
  ['npm run test:harness', 'isolated-tests-recovery-harness.log', 0],
  ['git diff --check', 'isolated-tests-recovery-diff-check.log', 0],
  [`INTENT_TEST_DOCKER_IMAGE=${image} npm run test --workspace @agent-cluster/server`, 'isolated-tests-recovery-server-full.log', 1]
];
const full = await load(checks[0][1]), related = await load(checks[1][1]);
if (!/^# pass 2063$/m.test(full) || !/^# pass 7$/m.test(full) || !/^# skipped 24$/m.test(full) || /^# fail [1-9]/m.test(full) ||
  !/^# pass 130$/m.test(related) || !/^# skipped 0$/m.test(related) || /^# fail [1-9]/m.test(related)) throw new Error('Unexpected test counts');
for (const title of ['real Docker process crash recovers from disk without rerunning or publishing a lost result',
  'real Docker adapter result commits the invocation journal before returning success',
  'real Docker isolates source, network and credentials and terminates test descendants']) {
  if (!new RegExp(`ok \\d+ - ${title}\\r?\\n`).test(related)) throw new Error(`Real Docker evidence missing: ${title}`);
}
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const remaining = docker(['ps', '-a', '--filter', 'name=intent-test-', '--format', '{{.Names}} {{.Status}}']);
if (remaining) throw new Error('Test containers remain; inspect before capture');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-recovery-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-isolated-tests-recovery', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'isolated-tests-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2063, devScriptsPassed: 7, fullServerSkipped: 24, postgresSkipped: 21, dockerDeferredToSerial: 3,
    finalRelatedPassed: 130, realDockerSkipped: false, countsOverlap: true, firstFullDockerFailure: 'daemon probe exceeded finite 5-second limit under concurrent full suite' },
  environment: { docker: docker(['version', '--format', '{{.Server.Os}} {{.Server.Version}}']),
    imageId: docker(['image', 'inspect', image, '--format', '{{.Id}}']), testContainersRemaining: remaining, productionConfigurationChanged: false },
  scope: { actualProcessKill: true, recoveryClockAdvancedMs: 31000, persistence: 'File', realPostgresVerified: false,
    newIntentTestDispatchEnabled: false, fullWorkspaceTestsRerun: false },
  limitations: ['Crash uses a real Node worker and Docker, not complete HTTP/Nest restart; lease expiry uses controlled clock',
    'New run_tests grant/runner binding and versioned dispatch remain unavailable',
    'Hard-delete record retention, multi-service PostgreSQL reconciliation, CLI and dual-client matrices remain incomplete',
    'First failed full Docker run retained; final ordinary full suite defers its 3 real Docker cases to successful serial verification'] };
await writeFile(resolve(directory, 'isolated-tests-recovery-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
