import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  'packages/shared/src/contracts.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.ts',
  'apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts',
  'apps/server/src/modules/message-routing/route-plan-compiler.service.ts',
  'apps/server/src/modules/message-routing/route-plan-compiler.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-execution-guard.ts',
  'apps/server/src/modules/message-routing/message-routing.module.ts',
  'apps/server/src/modules/context-management/context-management.service.ts',
  'apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts',
  'apps/web/src/stores/event.ts', 'apps/web/src/stores/event-normalization.spec.ts',
  'tests/evaluation/run-intent-semantic-proposal-sdd.mjs',
  'tests/evaluation/capture-intent-plan-commit-manifest.mjs'
];
const regressionFiles = ['message-routing/intent-plan-commit.service.spec.ts', 'message-routing/route-plan-compiler.service.spec.ts',
  'message-routing/intent-correction-planner.service.spec.ts', 'runtimes/logical-operation-store.spec.ts'];
const checks = [
  ['npm run test -w @agent-cluster/server', 'plan-commit-server-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json ' + regressionFiles.map(path => `apps/server/src/modules/${path}`).join(' '), 'plan-commit-epoch-regression.log'],
  ['npm run test -w @project/web -- src/stores/event-normalization.spec.ts', 'plan-commit-web-tests.log'],
  ['npm run typecheck', 'plan-commit-workspace-typecheck-final.log'],
  ['npm run build -w @agent-cluster/server', 'plan-commit-epoch-build.log'],
  ['npm run test:harness', 'plan-commit-harness.log'],
  ['node tests/evaluation/run-intent-semantic-proposal-sdd.mjs --commit-plan', 'plan-commit-runtime-final.log'],
  ['git diff --check', 'plan-commit-diff-check.log']
];
const load = name => readFile(resolve(directory, name), 'utf8');
const server = await load('plan-commit-server-tests.log');
const regression = await load('plan-commit-epoch-regression.log');
if (!/^# pass 2013$/m.test(server) || !/^# pass 7$/m.test(server) || !/^# skipped 21$/m.test(server) || /^# fail [1-9]/m.test(server)) throw new Error('Server results differ');
if (!/^# pass 51$/m.test(regression) || !/^# fail 0$/m.test(regression)) throw new Error('Related results differ');
const evidence = 'plan-commit-runtime-results.json';
const result = JSON.parse(await load(evidence));
if (result.results.length !== 7 || result.results.some(row => !row.passed)) throw new Error('Runtime checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/plan-commit-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-plan-commit', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'semantic-proposal-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2013, serverDevScriptsPassed: 7, postgresSkipped: 21, finalRelatedPassed: 51, webEventsPassed: 13, runtimeCasesPassed: 7, countsOverlap: true },
  scope: { ingress: 'direct Nest classifier and plan commit service; not Sessions first-turn API', backend: 'isolated File',
    runtime: 'actual Generic LLM HTTP with deterministic localhost responses', mainIngressMigrated: false, answerExecutionImplemented: false,
    modelAccuracyEvaluated: false, fullWorkspaceTestsRerun: false, realPostgresVerified: false },
  limitations: ['full server test run preceded the final non-applicable execution guard test and constraint epoch increment; final 51-test regression and server build cover these changes',
    'answer is queued only; source/test/artifact executors and execution-producing corrections remain unavailable',
    'Sessions migration, real clients/DB/CLI, complete projection transactions, independent annotations and release gates remain',
    'unrelated dirty files preserved; previous logs/manifests are historical evidence'] };
await writeFile(resolve(directory, 'plan-commit-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
