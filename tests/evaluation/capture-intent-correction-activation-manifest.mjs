// Capture already observed checks for this milestone; does not run or replace them.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const baseline = JSON.parse(await readFile(resolve(directory, 'baseline-manifest.json'), 'utf8'));
const sourcePaths = [...new Set([...Object.keys(baseline.hashes), ...git('diff', '--name-only').split(/\r?\n/),
  ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(path =>
    /^(apps\/(server|web|desktop)|packages\/(shared|local-runtime-cli)|tests\/evaluation)\//.test(path)), 'package-lock.json'])]
  .filter(path => /\.(ts|vue|mjs|json)$/.test(path) && !path.includes('/dist/')).sort();
const checks = [
  ['npm run typecheck', 'correction-activation-workspace-typecheck.log'],
  ['npm run typecheck --workspace @agent-cluster/server', 'correction-activation-server-typecheck-final.log'],
  ['npm run build', 'correction-activation-workspace-build.log'],
  ['npm run test', 'correction-activation-workspace-tests.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts apps/server/src/modules/message-routing/intent-correction.service.spec.ts apps/server/src/modules/message-routing/route-plan-compiler.service.spec.ts apps/server/src/modules/context-management/context-management.service.spec.ts apps/server/src/modules/intent-recognition/semantic-intent-router.service.spec.ts', 'correction-activation-regression.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/runtimes/runtime.service.spec.ts apps/server/src/modules/runtimes/logical-operation-store.spec.ts apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts apps/server/src/modules/message-routing/intent-correction.service.spec.ts apps/server/src/modules/execution/execution.service.spec.ts', 'intent-result-admission-regression-final.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/orchestrator/orchestrator.service.spec.ts apps/server/src/modules/execution/execution.service.spec.ts', 'intent-result-orchestrator-regression-final.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/workspaces/workspace-writeback.service.spec.ts apps/server/src/modules/workspaces/workspace-writeback-intent.spec.ts', 'intent-writeback-file-regression-final.log'],
  ['npm run test:harness', 'correction-activation-harness.log'],
  ['node tests/evaluation/run-intent-correction-activation-sdd.mjs', 'correction-activation-http-final-build.log']
];
const http = JSON.parse(await readFile(resolve(directory, 'correction-activation-http-results.json'), 'utf8'));
if (http.results.length !== 6 || http.results.some(item => !item.passed)) throw new Error('HTTP activation not verified');
const suite = await readFile(resolve(directory, 'correction-activation-workspace-tests.log'), 'utf8');
const sum = pattern => [...suite.matchAll(pattern)].reduce((total, item) => total + Number(item[1]), 0);
const fullSuite = { passed: sum(/^# pass (\d+)/gm) + sum(/Tests\s+(\d+) passed/g), failed: sum(/^# fail (\d+)/gm),
  skipped: sum(/^# skipped (\d+)/gm) };
if (fullSuite.passed !== 2853 || fullSuite.failed !== 0 || fullSuite.skipped !== 21) throw new Error(`Unexpected suite counts ${JSON.stringify(fullSuite)}`);
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-activation-report.md'];
const manifest = {
  runId: 'SDD-2026-10-19-correction-activation', capturedAt: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), baselineManifest: 'baseline-manifest.json',
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { stdio: ['ignore', 'pipe', 'ignore'] })),
  sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(path))]))),
  documentHashes: Object.fromEntries(await Promise.all(docs.map(async path => [path, hash(await readFile(path))]))),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: hash(await readFile(resolve(directory, log))) }))),
  fullSuite,
  finalDelta: 'After the full suite started: one additional Orchestrator boundary test and a writeback deletion guard/test. Final source passed focused 96-test and 20-test runs, final server typecheck, whole-workspace build, Harness and the six-case HTTP restart suite. Do not count the added tests in the full-suite count.',
  environment: { backend: 'isolated File; PostgreSQL integration skipped without RELATIONAL_TEST_DATABASE_URL',
    runtime: 'actual Generic LLM HTTP transport to a deterministic localhost provider; mock adapters in service tests; real ServerLocalWorkspaceProvider files',
    clients: 'no new Web/Electron interactive acceptance in this milestone', modelAccuracyEvaluated: false },
  limitations: ['only non-executing single-segment correction activation is connected',
    'ordinary-chat correction, first-turn unified ingress and executable correction dispatcher incomplete',
    'full projection transaction coverage, external-effect reconciliation, GitHub/file-revision paths and mixed-worker validation incomplete',
    'no actual CLI sandbox certification, independent human double annotation, 500-case evaluation or release approval',
    'sourceHashes also include preserved unrelated dirty workspace changes; baseline records pre-existing work']
};
await writeFile(resolve(directory, 'correction-activation-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sourcePaths.length, checks: checks.length, fullSuite }));
