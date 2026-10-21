// Captures already completed checks; it does not run tests or alter historical milestones.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sourcePaths = [
  'packages/shared/src/contracts.ts', 'packages/shared/src/intent-correction-contracts.ts',
  'apps/server/src/modules/context-management/context-management.service.ts',
  'apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts',
  'apps/server/src/modules/message-routing/message-correction-target.ts',
  'apps/server/src/modules/message-routing/intent-correction.service.ts',
  'apps/server/src/modules/message-routing/intent-correction.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-correction-planner.service.ts',
  'apps/server/src/modules/message-routing/intent-correction-planner.service.spec.ts',
  'apps/server/src/modules/message-routing/intent-correction-state.ts',
  'apps/server/src/modules/persistence/intent-record-invariants.ts',
  'apps/server/src/modules/runtime-invocation/runtime-invocation.service.ts',
  'apps/server/src/modules/runtime-invocation/runtime-invocation.service.spec.ts',
  'apps/server/src/modules/runtime-routing/invocation-resolver.service.ts',
  'apps/server/src/modules/sessions/sessions.service.ts', 'apps/server/src/modules/sessions/sessions.service.spec.ts',
  'apps/web/src/utils/intentCorrectionModel.ts', 'apps/web/src/components/IntentCorrectionPanel.vue',
  'apps/web/src/components/IntentCorrectionPanel.spec.ts', 'apps/web/src/stores/event.ts',
  'apps/web/src/stores/event-normalization.spec.ts', 'apps/web/src/components/ChatTimelineDiscussionDocument.spec.ts',
  'tests/evaluation/run-intent-chat-correction-sdd.mjs', 'tests/evaluation/capture-intent-chat-correction-manifest.mjs'
];
const regressionFiles = ['message-routing/intent-correction.service.spec.ts', 'message-routing/intent-correction-planner.service.spec.ts',
  'context-management/context-management.service.spec.ts', 'intent-recognition/semantic-intent-router.service.spec.ts',
  'sessions/sessions.service.spec.ts', 'runtime-invocation/runtime-invocation.service.spec.ts', 'runtimes/logical-operation-store.spec.ts'];
const regressionCommand = 'npx tsx --test --tsconfig apps/server/tsconfig.json ' + regressionFiles.map(path => `apps/server/src/modules/${path}`).join(' ');
const checks = [
  ['npm run test', 'chat-correction-workspace-tests-final.log', 'before final canonical routing and Session ledger cache changes'],
  [regressionCommand, 'chat-correction-final-regression.log', 'final source'],
  ['npm run typecheck', 'chat-correction-final-typecheck.log', 'before single-read optimization; server build covers final source'],
  ['npm run build', 'chat-correction-workspace-build.log', 'before final backend changes'],
  ['npm run build --workspace @agent-cluster/server', 'chat-correction-server-final-build.log', 'final source'],
  ['npm run test:harness', 'chat-correction-harness-final.log', 'final runtime source'],
  ['node tests/evaluation/run-intent-chat-correction-sdd.mjs', 'chat-correction-http-current-build.log', 'final server build'],
  ['git diff --check', 'chat-correction-diff-check.log', 'tracked changes']
];
const whole = await readFile(resolve(directory, 'chat-correction-workspace-tests-final.log'), 'utf8');
const regression = await readFile(resolve(directory, 'chat-correction-final-regression.log'), 'utf8');
const http = JSON.parse(await readFile(resolve(directory, 'chat-correction-http-results.json'), 'utf8'));
const tapPass = [...whole.matchAll(/^# pass (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
const tapSkip = [...whole.matchAll(/^# skipped (\d+)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
if (tapPass + 469 !== 2890 || tapSkip !== 21 || !/Tests\s+469 passed/.test(whole) || /^# fail [1-9]/m.test(whole)) throw new Error('Full regression evidence differs');
if (!/^# pass 250$/m.test(regression) || !/^# fail 0$/m.test(regression)) throw new Error('Final regression evidence differs');
if (http.results.length !== 7 || http.results.some(row => !row.passed)) throw new Error('HTTP evidence incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/chat-correction-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-chat-correction', capturedAt: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), baselineManifest: 'baseline-manifest.json', previousMilestone: 'correction-ui-manifest.json',
  sourceHashes: await hashes(sourcePaths), documentHashes: await hashes(docs),
  checks: await Promise.all(checks.map(async ([command, log, scope]) => ({ command, log, scope, exitCode: 0, logSha256: sha(await readFile(resolve(directory, log))) }))),
  evidenceHashes: { 'chat-correction-http-results.json': sha(await readFile(resolve(directory, 'chat-correction-http-results.json'))) },
  tests: { workspacePassed: 2890, postgresSkipped: 21, finalRelatedPassed: 250, httpPassed: 7, additiveCounts: false },
  scope: { ingress: 'enforce V2 ordinary chat correction only; initial classification remains legacy contract',
    backend: 'isolated File; actual messages/corrections HTTP; deterministic localhost Generic LLM provider; real server restart',
    modelAccuracyEvaluated: false, postgresVerified: false, realElectronVerified: false },
  limitations: ['first-turn/unified semantic main path and special message branches remain incomplete',
    'executing correction dispatch, scoped test/source/artifact executors and all projection transactions remain incomplete',
    'no full 58-case acceptance, independent human double annotation, real database/CLI/dual-client matrix or release approval',
    'unrelated dirty workspace preserved; source hashes cover current files including prior milestone changes'] };
await writeFile(resolve(directory, 'chat-correction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sourcePaths.length, checks: checks.length, tests: manifest.tests }));
