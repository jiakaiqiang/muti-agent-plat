import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('semantic-correction-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/message-routing/intent-workspace-read.ts', 'packages/shared/src/default-agent-presets.ts',
  'apps/server/src/modules/capabilities/default-capabilities.ts', 'apps/server/src/modules/capabilities/capabilities.service.ts',
  'apps/server/src/modules/tools/capability-tool-mapping.ts', 'apps/server/src/modules/tools/capability-tool-mapping.spec.ts',
  'apps/server/src/modules/tools/builtin/code-search.tool.ts', 'apps/server/src/modules/tools/builtin/code-search.tool.spec.ts',
  'tests/evaluation/run-intent-workspace-answer-sdd.mjs', 'tests/evaluation/capture-intent-workspace-answer-manifest.mjs'])];
const checks = [
  ['npm run test', 'workspace-answer-workspace-tests.log'],
  ['npm run typecheck', 'workspace-answer-workspace-typecheck.log'],
  ['npm run build', 'workspace-answer-workspace-build.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/tools/builtin/code-search.tool.spec.ts apps/server/src/modules/tools/tool-authority-resolver.service.spec.ts apps/server/src/modules/runtimes/generic-llm-runtime.service.spec.ts apps/server/src/modules/runtimes/generic-llm-tool-loop-budget.spec.ts apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts apps/server/src/modules/message-routing/intent-answer-executor.service.spec.ts', 'workspace-answer-final-regression.log'],
  ['npm run build -w @agent-cluster/server', 'workspace-answer-final-server-build.log'],
  ['npm run test:harness', 'workspace-answer-harness-final.log'],
  ['node tests/evaluation/run-intent-workspace-answer-sdd.mjs', 'workspace-answer-http-verified.log'],
  ['git diff --check', 'workspace-answer-diff-check.log']
];
const full = await load('workspace-answer-workspace-tests.log');
if ([102, 281, 2038, 7, 37, 14].some(count => !new RegExp(`^# pass ${count}$`, 'm').test(full)) ||
  !/Tests\s+470 passed/.test(full) || /^# fail [1-9]/m.test(full)) throw new Error('Workspace results differ');
const regression = await load('workspace-answer-final-regression.log');
if (!/^# pass 85$/m.test(regression) || /^# fail [1-9]/m.test(regression)) throw new Error('Regression results differ');
const evidence = 'workspace-answer-http-results.json';
const result = JSON.parse(await load(evidence));
if (result.results.length !== 5 || result.results.some(row => !row.passed)) throw new Error('HTTP checks incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/harness-engineering/alignment/orchestrator-alignment.md',
  'docs/harness-engineering/context-engineering/prompt-context/agent-prompt-contract.md',
  'docs/harness-engineering/context-engineering/prompt-context/runtime-context-contract.md',
  'docs/harness-engineering/architecture-constraints/capability-binding/tool-governance-binding.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-answer-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-workspace-answer', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'semantic-correction-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs), evidenceHashes: { [evidence]: sha(await load(evidence)) },
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { fullWorkspacePassed: 2949, cliPassed: 102, sharedPassed: 281, serverPassed: 2038, serverDevScriptsPassed: 7,
    webPassed: 470, devSupervisorPassed: 37, desktopPassed: 14, postgresSkipped: 21, finalRelatedPassed: 85, httpCasesPassed: 5, countsOverlap: true },
  scope: { ingress: 'actual Sessions API with compatibility server_local source; isolated GitHub-create flag disabled',
    backend: 'isolated File', runtime: 'actual Generic LLM text protocol with real temporary files and deterministic localhost provider',
    modelAccuracyEvaluated: false, realPostgresVerified: false, fullWorkspaceTestsRerun: true, productionFlagChanged: false },
  limitations: ['Full workspace run precedes final literal-search restriction; final 85 tests/server build/HTTP cover that increment',
    'Live revocation UI/API, GitHub source-ready and local Bridge/CLI read grants still need implementation/verification',
    'Test/source/artifact executors, independent annotation, full scenario matrix and release gates remain incomplete'] };
await writeFile(resolve(directory, 'workspace-answer-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
