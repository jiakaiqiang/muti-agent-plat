import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('test-runner-binding-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/contracts.ts', 'packages/shared/src/intent-runtime-policy.ts', 'packages/shared/src/default-agent-presets.ts',
  ...['message-routing/intent-test-executor.service.ts', 'message-routing/intent-test-executor.service.spec.ts',
    'message-routing/intent-plan-commit.service.ts', 'message-routing/intent-test-authority.service.ts', 'message-routing/intent-test-authority.service.spec.ts',
    'message-routing/message-routing.module.ts', 'runtime-routing/invocation-resolver.service.ts', 'tools/tool-authority-resolver.service.ts',
    'tools/tool-authority-resolver.service.spec.ts', 'tools/tool.interface.ts', 'tools/capability-tool-mapping.ts', 'tools/builtin/test-runner.tool.ts',
    'tools/builtin/test-runner.tool.spec.ts', 'runtimes/isolated-test-run-store.ts', 'runtimes/isolated-test-runner.service.ts',
    'runtimes/test-runner-runtime-adapter.service.ts', 'runtimes/test-runner-runtime-adapter.service.spec.ts',
    'capabilities/capabilities.service.ts', 'capabilities/default-capabilities.ts'].map(path => `apps/server/src/modules/${path}`),
  'apps/web/src/components/IntentTestAuthorityPanel.vue', 'apps/web/src/components/IntentTestAuthorityPanel.spec.ts',
  'tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'tests/evaluation/capture-intent-test-dispatch-manifest.mjs'])];
const checks = [
  ['npm run test', 'test-dispatch-workspace-tests.log', 1],
  ['npm run test --workspace @project/web', 'test-dispatch-web-final.log', 0],
  ['npm run test:dev-supervisor', 'test-dispatch-dev-supervisor.log', 0], ['npm run test:desktop', 'test-dispatch-desktop-tests.log', 0],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json (seven related test files, see sourceHashes)', 'test-dispatch-related-complete.log', 0],
  ['npm run typecheck', 'test-dispatch-workspace-typecheck-final.log', 0],
  ['npm run typecheck --workspace @agent-cluster/server', 'test-dispatch-server-typecheck-final.log', 0],
  ['npm run build', 'test-dispatch-workspace-build.log', 0],
  ['npm run build --workspace @agent-cluster/server', 'test-dispatch-server-last-build.log', 0],
  ['INTENT_TEST_DOCKER_IMAGE=pinned INTENT_DISPATCH_EVIDENCE_PREFIX=test-dispatch-verified node tests/evaluation/run-intent-test-dispatch-sdd.mjs', 'test-dispatch-http-verified.log', 0],
  ['npm run test:harness', 'test-dispatch-harness-final.log', 0], ['git diff --check', 'test-dispatch-diff-check.log', 0]
];
const full = await load('test-dispatch-workspace-tests.log'), related = await load('test-dispatch-related-complete.log'), web = await load('test-dispatch-web-final.log');
if (![102,281,2087,7].every(count => new RegExp(`^# pass ${count}$`, 'm').test(full)) || !/^# skipped 26$/m.test(full) ||
  !/^# pass 104$/m.test(related) || /^# fail [1-9]/m.test(related) || !/493 passed/.test(web) || /Tests\s+\d+ failed/.test(web)) throw new Error('Unexpected test counts');
const httpPath = 'test-dispatch-verified-http-results.json', http = JSON.parse(await load(httpPath));
if (http.results.length !== 7 || http.results.some(row => !row.passed) || !http.results.find(row => row.id === 'TD05').actual.actuallyRunningBeforeRevoke) throw new Error('HTTP evidence incomplete');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/harness-engineering/architecture-constraints/capability-binding/tool-governance-binding.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-dispatch-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const intermediate = ['test-dispatch-typecheck.log', 'test-dispatch-executor-tests.log', 'test-dispatch-executor-tests-final.log',
  'test-dispatch-http.log', 'test-dispatch-http-second.log', 'test-dispatch-http-third.log', 'test-dispatch-third-http-results.json',
  'test-dispatch-server-build-final.log', 'test-dispatch-server-build-verified.log', 'test-dispatch-server-build-success.log',
  'test-dispatch-workspace-typecheck.log', 'test-dispatch-harness.log', 'test-dispatch-final-http-results.json'];
const manifest = { runId: 'SDD-2026-10-20-test-dispatch', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'test-runner-binding-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode, logSha256: sha(await load(log)) }))),
  intermediateEvidence: await Promise.all(intermediate.map(async log => ({ log, logSha256: sha(await load(log)), scope: 'earlier failure/incomplete increment, not final acceptance' }))),
  httpEvidence: { path: httpPath, sha256: sha(await load(httpPath)), cases: http.results.map(row => row.id), revokeStopElapsedMs: http.results.find(row => row.id === 'TD05').actual.elapsedMs },
  tests: { cliPassed: 102, sharedPassed: 281, serverPassedAtFullRun: 2087, serverDevScriptsPassed: 7, postgresSkipped: 21, optionalDockerSkippedInFull: 5,
    webFinalPassed: 493, devSupervisorPassed: 37, desktopUnitPassed: 14, relatedFinalPassed: 104, httpPassed: 7, countsOverlap: true },
  scope: { persistence: 'File', realDockerVerified: true, actualServerRestart: true, deterministicClassifier: true,
    newIntentSingleTestDispatchEnabled: true, httpRevocationVerified: true, realPostgresVerified: false, runtimeCliOrElectronVerified: false },
  limitations: ['First root test command failed in Web; fixed Web plus remaining dev/desktop commands were run separately',
    'Three late backend tests and notification replay delta verified by final 104 related checks and Server typecheck/build',
    'No execution-correction, multi-step, source/artifact writer, full crash HTTP matrix, PostgreSQL, multi-process, CLI/Bridge or dual-client acceptance',
    'No real model accuracy, independent human annotation or release completion claim'] };
await writeFile(resolve(directory, 'test-dispatch-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests, http: manifest.httpEvidence }));
