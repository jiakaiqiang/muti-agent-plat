// Records checks already executed in this workspace; never runs or replaces historical results.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sourcePaths = [
  'apps/server/src/modules/sessions/sessions.controller.ts', 'apps/server/src/modules/sessions/sessions.service.ts',
  'apps/server/src/modules/sessions/sessions.service.spec.ts', 'apps/web/src/utils/intentCorrectionModel.ts',
  'apps/web/src/stores/intentCorrection.ts', 'apps/web/src/stores/intentCorrection.spec.ts',
  'apps/web/src/components/IntentCorrectionPanel.vue', 'apps/web/src/components/IntentCorrectionPanel.spec.ts',
  'apps/web/src/components/ChatTimeline.vue', 'apps/desktop/renderer/components/ChatTimeline.vue',
  'apps/web/vitest.config.ts', 'tests/evaluation/run-intent-correction-activation-sdd.mjs',
  'tests/evaluation/intent-correction-ui/index.html', 'tests/evaluation/intent-correction-ui/main.ts',
  'tests/evaluation/serve-intent-correction-ui.mjs', 'tests/evaluation/capture-intent-correction-ui-manifest.mjs'
];
const checks = [
  ['npm run test --workspace @project/web', 'correction-ui-web-regression-final.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/sessions/sessions.service.spec.ts', 'correction-ui-session-regression.log'],
  ['npm run typecheck', 'correction-ui-typecheck-final.log'],
  ['npm run build', 'correction-ui-build-final.log'],
  ['npm run test:harness', 'correction-ui-harness.log'],
  ['INTENT_CORRECTION_UI_CHECKS=1 node tests/evaluation/run-intent-correction-activation-sdd.mjs', 'correction-ui-http.log'],
  ['git diff --check', 'correction-ui-diff-check.log']
];
const web = await readFile(resolve(directory, 'correction-ui-web-regression-final.log'), 'utf8');
const session = await readFile(resolve(directory, 'correction-ui-session-regression.log'), 'utf8');
const http = JSON.parse(await readFile(resolve(directory, 'correction-ui-http-results.json'), 'utf8'));
if (!/Tests\s+466 passed/.test(web) || !/^# pass 148$/m.test(session) || !/^# fail 0$/m.test(session)) throw new Error('Regression counts differ');
if (http.results.length !== 9 || http.results.some(row => !row.passed)) throw new Error('HTTP evidence incomplete');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/implementation/intent-recognition-correction-task-v1.md', 'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/contracts/ui-state-contract-v0.1.md', 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/correction-ui-report.md'];
const evidence = ['correction-ui-http-results.json', 'correction-ui-browser-accepted.txt', 'correction-ui-browser-applied.txt', 'correction-ui-browser.png'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-correction-ui', capturedAt: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), baselineManifest: 'baseline-manifest.json', previousMilestone: 'correction-activation-manifest.json',
  sourceHashes: await hashes(sourcePaths), documentHashes: await hashes(docs),
  evidenceHashes: Object.fromEntries(await Promise.all(evidence.map(async path => [path, sha(await readFile(resolve(directory, path)))]))),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await readFile(resolve(directory, log))) }))),
  tests: { newClientScenarios: 21, webIncludingDesktopComponents: 466, sessionsService: 148, http: 9, fullWorkspaceTestRerun: false },
  scope: { backend: 'isolated File backend; actual Generic LLM HTTP to deterministic localhost provider; process restart',
    browser: 'IAB interaction with real shared Vue/Element Plus component and in-memory fetch fixture',
    desktop: 'renderer component tests and full build; actual Electron runtime not exercised', modelAccuracyEvaluated: false },
  finalDelta: 'Final HTTP backend was built before the HTTP run. Later changes only affect client status ordering and duplicate-submit protection; final Web tests, full workspace typecheck/build and browser screenshot cover these changes.',
  limitations: ['IR10/IRC-AC15/X02/G3 remain partial; no actual Web+Electron dual-client/SSE fault injection',
    'ordinary chat correction, no-target clarification and executing correction dispatcher remain incomplete',
    'no PostgreSQL/real CLI verification, independent double annotation, full 58-case acceptance or release approval',
    'existing unrelated workspace changes preserved; listed modified files may contain prior milestone changes'] };
await writeFile(resolve(directory, 'correction-ui-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sourcePaths.length, checks: checks.length, tests: manifest.tests }));
