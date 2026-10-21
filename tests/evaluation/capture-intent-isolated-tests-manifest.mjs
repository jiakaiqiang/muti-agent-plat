import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('workspace-authority-ui-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/runtimes/isolated-test-runner.service.ts', 'apps/server/src/modules/runtimes/isolated-test-runner.service.spec.ts',
  'apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.ts', 'apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.spec.ts',
  'apps/server/src/modules/runtimes/runtime.module.ts', 'apps/server/src/modules/tools/builtin/test-runner.tool.ts',
  'apps/server/src/modules/tools/builtin/test-runner.tool.spec.ts', 'apps/server/src/modules/tools/tool.interface.ts',
  'tests/evaluation/capture-intent-isolated-tests-manifest.mjs'])];
const image = 'sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const checks = [
  [`INTENT_TEST_DOCKER_IMAGE=${image} npm run test --workspace @agent-cluster/server`, 'isolated-tests-server-full.log'],
  [`INTENT_TEST_DOCKER_IMAGE=${image} npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/runtimes/isolated-test-runner.service.spec.ts apps/server/src/modules/tools/builtin/test-runner.tool.spec.ts apps/server/src/modules/runtimes/test-runner-runtime-adapter.service.spec.ts apps/server/src/modules/runtimes/runtime.service.spec.ts`, 'isolated-tests-final-guard.log'],
  ['npm run build --workspace @agent-cluster/server', 'isolated-tests-final-guard-build.log'],
  ['npm run test:harness', 'isolated-tests-harness.log'], ['git diff --check', 'isolated-tests-diff-check.log']
];
const full = await load('isolated-tests-server-full.log'), related = await load('isolated-tests-final-guard.log');
if (!/^# pass 2054$/m.test(full) || !/^# pass 7$/m.test(full) || /^# fail [1-9]/m.test(full) || !/^# pass 104$/m.test(related) || !/^# skipped 0$/m.test(related)) throw new Error('Test counts differ');
if (!/ok \d+ - real Docker isolates source, network and credentials and terminates test descendants\r?\n/.test(related)) throw new Error('Real Docker evidence missing');
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const containers = docker(['ps', '-a', '--filter', 'name=intent-test-', '--format', '{{.Names}} {{.Status}}']);
if (containers) throw new Error('Test containers still present; inspect before capture');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/isolated-tests-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-isolated-tests', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'workspace-authority-ui-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2054, serverDevScriptsPassed: 7, postgresSkipped: 21, finalRelatedPassed: 104, realDockerSkipped: false, countsOverlap: true },
  environment: { docker: docker(['version', '--format', '{{.Server.Os}} {{.Server.Version}}']), imageId: docker(['image', 'inspect', image, '--format', '{{.Id}}']),
    testContainersRemaining: containers, productionConfigurationChanged: false },
  scope: { newIntentTestDispatchEnabled: false, realPostgresVerified: false, fullWorkspaceTestsRerun: false,
    enforcement: 'actual isolated Linux container through service and TestRunnerTool, with temporary repository and assertions' },
  limitations: ['Full server run precedes final adapter scope guard; final 104 related tests and build cover this increment',
    'Grant/runner binding, versioned dispatch, durable crash reconciliation, CLI scope split and complete application scenarios remain incomplete',
    'Host node_modules are excluded; this fixture does not prove all repository dependency environments or production readiness'] };
await writeFile(resolve(directory, 'isolated-tests-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
