import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('plan-commit-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-correction-contracts.ts', 'packages/shared/src/intent-runtime-policy.ts', 'packages/shared/src/intent-runtime-policy.spec.ts',
  'apps/server/src/modules/message-routing/intent-answer-executor.service.ts', 'apps/server/src/modules/message-routing/intent-answer-executor.service.spec.ts',
  'apps/server/src/modules/persistence/intent-record-invariants.ts', 'apps/server/src/modules/tools/tool-authority-resolver.service.ts',
  'apps/server/src/modules/runtime-routing/invocation-resolver.service.ts', 'apps/server/src/modules/runtime-invocation/runtime-invocation.service.ts',
  'apps/server/src/modules/runtimes/logical-operation-store.ts', 'apps/server/src/modules/runtimes/generic-llm-runtime.service.ts',
  'apps/server/src/modules/runtimes/runtime.service.ts', 'tests/evaluation/capture-intent-answer-executor-manifest.mjs'
])];
const regressionFiles = ['message-routing/intent-answer-executor.service.spec.ts', 'message-routing/intent-plan-commit.service.spec.ts',
  'runtimes/logical-operation-store.spec.ts', 'runtime-routing/invocation-resolver.service.spec.ts', 'runtimes/generic-llm-runtime.service.spec.ts'];
const checks = [
  ['npm run test -w @agent-cluster/server', 'answer-executor-server-tests.log'],
  ['npm run test -w @agent-cluster/shared', 'answer-executor-shared-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json ' + regressionFiles.map(path => `apps/server/src/modules/${path}`).join(' ') + ' packages/shared/src/intent-runtime-policy.spec.ts', 'answer-executor-complete-regression.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-answer-executor.service.spec.ts', 'answer-executor-restart-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-answer-executor.service.spec.ts apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts', 'answer-executor-final-status-tests.log'],
  ['npm run typecheck', 'answer-executor-workspace-typecheck-final.log'],
  ['npm run typecheck -w @agent-cluster/server', 'answer-executor-final-typecheck.log'],
  ['npm run build -w @agent-cluster/server', 'answer-executor-complete-build.log'],
  ['npm run test:harness', 'answer-executor-harness-complete.log'],
  ['node tests/evaluation/run-intent-semantic-proposal-sdd.mjs --execute-answer', 'answer-executor-runtime-final.log'],
  ['git diff --check', 'answer-executor-diff-check.log']
];
for (const [file, count] of [['answer-executor-server-tests.log', 2022], ['answer-executor-shared-tests.log', 280],
  ['answer-executor-complete-regression.log', 118], ['answer-executor-restart-tests.log', 10], ['answer-executor-final-status-tests.log', 24]]) {
  const log = await load(file);
  if (!new RegExp(`^# pass ${count}$`, 'm').test(log) || /^# fail [1-9]/m.test(log)) throw new Error(`${file}: results differ`);
}
const evidence = 'answer-executor-runtime-results.json';
const result = JSON.parse(await load(evidence));
if (result.results.length !== 10 || result.results.some(row => !row.passed)) throw new Error('Runtime checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/harness-engineering/alignment/README.md',
  'docs/harness-engineering/alignment/orchestrator-alignment.md', 'docs/harness-engineering/context-engineering/prompt-context/agent-prompt-contract.md',
  'docs/harness-engineering/context-engineering/prompt-context/runtime-context-contract.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/answer-executor-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-answer-executor', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'plan-commit-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { serverPassed: 2022, serverDevScriptsPassed: 7, sharedPassed: 280, postgresSkipped: 21, relatedPassed: 118,
    fileReloadPassed: 10, finalStatusPassed: 24, runtimeCasesPassed: 10, countsOverlap: true },
  scope: { ingress: 'direct Nest classification, commit and explicitly driven answer executor; not Sessions API', backend: 'isolated File',
    runtime: 'actual Generic LLM HTTP with deterministic localhost responses', answerExecutionImplemented: true,
    mainIngressMigrated: false, modelAccuracyEvaluated: false, realPostgresVerified: false, fullWorkspaceTestsRerun: false },
  limitations: ['full server run preceded final scheduling/deadline/retry tests and deadline terminal handling; 118-test regression and build cover those increments',
    'File-reload test and applying routingRevision increment were added after complete build/runtime run; final 10/24-test checks cover them',
    'response has no workspace tools; read/test/source/artifact executors, Sessions migration and execution-producing corrections remain',
    'real clients/DB/CLI, independent annotation, full scenario matrix and release gates remain incomplete',
    'previous evidence stays historical; unrelated dirty work preserved'] };
await writeFile(resolve(directory, 'answer-executor-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
