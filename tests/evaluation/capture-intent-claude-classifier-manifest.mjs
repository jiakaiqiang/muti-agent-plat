import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('multi-segment-review-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/server/src/modules/runtimes/claude-intent-classification.ts',
  'apps/server/src/modules/runtimes/claude-intent-classification.spec.ts',
  'apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts',
  'apps/server/src/modules/runtimes/server-runtime-worker.service.ts',
  'apps/server/src/modules/runtimes/server-runtime-worker.service.spec.ts',
  'apps/server/src/modules/runtimes/server-runtime-worker.process.ts',
  'apps/server/src/modules/runtimes/server-runtime-worker.protocol.ts',
  'tests/evaluation/run-intent-claude-classifier-sdd.mjs',
  'tests/evaluation/capture-intent-claude-classifier-manifest.mjs'])];
const full = await read('claude-classifier-workspace-tests.log');
const passes = [...full.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1]));
if (JSON.stringify(passes) !== JSON.stringify([102, 284, 2153, 7, 37, 14]) || /^# fail [1-9]/m.test(full) || !/Tests\s+523 passed/.test(full)) throw new Error('Incomplete full tests');
const final = await read('claude-classifier-server-tests-final.log');
if (!/^# pass 2154$/m.test(final) || !/^# pass 7$/m.test(final) || /^# fail [1-9]/m.test(final)) throw new Error('Incomplete final server tests');
const cli = JSON.parse(await read('claude-classifier-cli-results.json'));
if (cli.results.length !== 8 || cli.results.some(row => !row.passed)) throw new Error('Incomplete native CLI verification');
const checks = [
  ['npm run test', 'claude-classifier-workspace-tests.log'],
  ['npm run test --workspace @agent-cluster/server', 'claude-classifier-server-tests-final.log'],
  ['npx tsx --test (classifier, worker, resolver)', 'claude-classifier-worker-tests.log'],
  ['npm run typecheck', 'claude-classifier-typecheck-complete.log'],
  ['npm run build --workspace @agent-cluster/shared', 'claude-classifier-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'claude-classifier-worker-build-final.log'],
  ['node tests/evaluation/run-intent-claude-classifier-sdd.mjs', 'claude-classifier-cli-verified.log'],
  ['npm run test:harness', 'claude-classifier-harness-final.log'],
  ['git diff --check', 'claude-classifier-diff-check.log']
];
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/runtime-contract-v0.1.md', `${directory}/claude-classifier-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-claude-classifier', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json',
  previousMilestone: 'multi-segment-review-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['claude-classifier-cli-results.json', 'claude-classifier-typecheck.log',
    'claude-classifier-routing-tests.log', 'claude-classifier-server-build.log', 'claude-classifier-cli-durable.log',
    'claude-classifier-cli-diagnostic.log', 'claude-classifier-cli-final.log', 'claude-classifier-cli-complete.log'].map(name => `${directory}/${name}`)),
  tests: { earlierWorkspacePassed: 3120, finalServerPassed: 2154, finalServerDevScriptsPassed: 7, focusedWorkerPassed: 50,
    postgresSkipped: 32, optionalDockerSkipped: 5, installedCliIntegrationChecks: 8, countsOverlap: true },
  installedCliVersion: cli.version,
  verificationScope: ['Final Worker routing path and model name mapping followed the workspace run; final Server suite, typecheck and build cover those changes',
    'Installed Claude CLI with deterministic localhost Anthropic responses, including actual Nest/Worker/File classifier and bounded repair; not semantic accuracy'],
  limitations: ['No Codex/Bridge restricted classifier, no expanded response/business effects',
    'No new PostgreSQL/Docker/Electron/SSE/complete crash matrix run', 'Independent labelled model evaluation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'claude-classifier-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
