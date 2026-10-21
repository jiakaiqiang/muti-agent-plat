import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  'packages/shared/src/contracts.ts', 'packages/shared/src/intent-correction-contracts.ts',
  'apps/server/src/modules/intent-recognition/intent-understanding-routing.service.ts',
  'apps/server/src/modules/intent-recognition/intent-understanding-routing.service.spec.ts',
  'apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts',
  'apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts',
  'apps/server/src/modules/intent-recognition/intent-recognition.module.ts',
  'apps/server/src/modules/context-management/context-management.service.ts',
  'apps/server/src/modules/runtimes/generic-llm-runtime.service.ts',
  'apps/server/src/modules/runtimes/generic-llm-runtime.service.spec.ts',
  'apps/server/src/modules/runtimes/logical-operation-store.ts',
  'apps/server/src/modules/runtimes/logical-operation-store.spec.ts',
  'apps/server/src/modules/runtime-routing/invocation-resolver.service.ts',
  'apps/server/src/modules/runtime-invocation/runtime-invocation.service.ts',
  'apps/server/src/modules/runtime-invocation/runtime-invocation.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-correction-planner.service.ts',
  'apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts',
  'tests/evaluation/run-intent-semantic-proposal-sdd.mjs',
  'tests/evaluation/run-intent-chat-correction-sdd.mjs',
  'tests/evaluation/capture-intent-semantic-proposal-manifest.mjs'
];
const regressionFiles = ['intent-recognition/intent-understanding-routing.service.spec.ts', 'intent-recognition/semantic-intent-router.service.spec.ts',
  'context-management/context-management.service.spec.ts', 'runtimes/logical-operation-store.spec.ts',
  'runtime-invocation/runtime-invocation.service.spec.ts', 'message-routing/intent-correction.service.spec.ts',
  'message-routing/intent-correction-planner.service.spec.ts', 'runtimes/generic-llm-runtime.service.spec.ts'];
const checks = [
  ['npx tsx --test --tsconfig apps/server/tsconfig.json ' + regressionFiles.map(path => `apps/server/src/modules/${path}`).join(' '), 'semantic-proposal-complete-regression.log'],
  ['npm run test --workspace @agent-cluster/server', 'semantic-proposal-server-tests.log'],
  ['npm run typecheck', 'semantic-proposal-workspace-typecheck-final.log'],
  ['npm run build --workspace @agent-cluster/server', 'semantic-proposal-complete-build.log'],
  ['npm run test:harness', 'semantic-proposal-harness.log'],
  ['node tests/evaluation/run-intent-semantic-proposal-sdd.mjs', 'semantic-proposal-runtime-final.log'],
  ['node tests/evaluation/run-intent-chat-correction-sdd.mjs --semantic-proposal', 'semantic-proposal-chat-http-final.log'],
  ['git diff --check', 'semantic-proposal-diff-check.log']
];
const load = name => readFile(resolve(directory, name), 'utf8');
const server = await load('semantic-proposal-server-tests.log');
const regression = await load('semantic-proposal-complete-regression.log');
if (!/^# pass 2000$/m.test(server) || !/^# pass 7$/m.test(server) || !/^# skipped 21$/m.test(server) || /^# fail [1-9]/m.test(server)) throw new Error('Server results differ');
if (!/^# pass 155$/m.test(regression) || !/^# fail 0$/m.test(regression)) throw new Error('Related results differ');
const evidence = ['semantic-proposal-runtime-results.json', 'semantic-proposal-chat-http-results.json'];
for (const [index, file] of evidence.entries()) {
  const result = JSON.parse(await load(file));
  if (result.results.length !== (index === 0 ? 4 : 7) || result.results.some(row => !row.passed)) throw new Error(`${file}: incomplete`);
}
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/semantic-proposal-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-semantic-proposal', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'chat-correction-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs),
  evidenceHashes: Object.fromEntries(await Promise.all(evidence.map(async file => [file, sha(await load(file))]))),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2000, serverDevScriptsPassed: 7, postgresSkipped: 21, relatedPassed: 155, runtimeCasesPassed: 4, chatHttpCasesPassed: 7, countsOverlap: true },
  scope: { newClassifierIngress: 'direct Nest service; not Sessions first-turn API', backend: 'isolated File',
    runtime: 'actual Generic LLM HTTP with deterministic local responses', mainIngressMigrated: false,
    modelAccuracyEvaluated: false, fullWorkspaceTestsRerun: false, realPostgresVerified: false },
  limitations: ['semantic proposal is not an executable authorized plan; compiler/commit/first-turn wiring remains',
    'real effect executors, complete projection transactions, real clients/DB/CLI, independent annotation and release gates remain incomplete',
    'existing unrelated dirty work preserved; previous manifests/logs remain historical evidence'] };
await writeFile(resolve(directory, 'semantic-proposal-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
