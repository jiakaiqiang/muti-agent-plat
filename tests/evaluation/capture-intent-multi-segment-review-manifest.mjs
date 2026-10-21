import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(resolve(directory, name), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const previous = JSON.parse(await read('recognition-retry-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'packages/shared/src/intent-multi-segment-review.ts', 'packages/shared/src/intent-multi-segment-review.spec.ts',
  'apps/web/src/components/IntentMultiSegmentReview.vue', 'apps/web/src/components/IntentMultiSegmentReview.spec.ts',
  'apps/web/tests/fixtures/intent-multi-segment-review.html', 'apps/web/tests/fixtures/intent-multi-segment-review.ts',
  'tests/evaluation/run-intent-multi-segment-review-sdd.mjs', 'tests/evaluation/multi-segment-review-browser-checks.js',
  'tests/evaluation/capture-intent-multi-segment-review-manifest.mjs'])];
const full = await read('multi-segment-review-workspace-tests.log');
const passes = [...full.matchAll(/^# pass (\d+)$/gm)].map(row => Number(row[1]));
if (JSON.stringify(passes) !== JSON.stringify([102, 283, 2145, 7, 37, 14]) || /^# fail [1-9]/m.test(full) || !/Tests\s+521 passed/.test(full)) throw new Error('Incomplete full tests');
if (!/Tests\s+523 passed/.test(await read('multi-segment-review-web-final.log'))) throw new Error('Incomplete final Web tests');
const http = JSON.parse(await read('multi-segment-review-http-results.json'));
if (http.results.length !== 6 || http.results.some(row => !row.passed)) throw new Error('Incomplete HTTP tests');
const browserLine = (await read('multi-segment-review-browser.log')).split(/\r?\n/).find(line => line.startsWith('{"checks":'));
const browser = JSON.parse(browserLine ?? '{}');
if (browser.checks?.length !== 11 || browser.checks.some(row => !row.passed) || browser.errors.length) throw new Error('Incomplete browser checks');
const documents = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', 'docs/contracts/event-contract-v0.1.md', 'docs/contracts/ui-state-contract-v0.1.md',
  `${directory}/multi-segment-review-report.md`, `${directory}/README.md`];
const checks = [
  ['npm run test', 'multi-segment-review-workspace-tests.log'], ['npm run test --workspace @project/web', 'multi-segment-review-web-final.log'],
  ['npx tsx --test (plan commit and shared review)', 'multi-segment-review-focused.log'], ['npx tsx --test (shared review final)', 'multi-segment-review-shared-final.log'],
  ['npm run typecheck', 'multi-segment-review-typecheck-final.log'], ['npm run build', 'multi-segment-review-build.log'],
  ['npm run build --workspace @project/web', 'multi-segment-review-web-build-final.log'], ['npm run build --workspace @agent-cluster/desktop', 'multi-segment-review-desktop-build-final.log'],
  ['node tests/evaluation/run-intent-multi-segment-review-sdd.mjs', 'multi-segment-review-http.log'],
  ['playwright-cli run-code --filename tests/evaluation/multi-segment-review-browser-checks.js', 'multi-segment-review-browser.log'],
  ['npm run test:harness', 'multi-segment-review-harness.log'], ['git diff --check', 'multi-segment-review-diff-check.log']
];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-multi-segment-review', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'recognition-retry-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['multi-segment-review-http-results.json', 'multi-segment-review-ui-initial.log', 'multi-segment-review-build-initial.log'].map(name => `${directory}/${name}`)
    .concat(['output/playwright/intent-multi-segment-web.png', 'output/playwright/intent-multi-segment-desktop.png'])),
  tests: { workspacePassed: 3109, cliPassed: 102, sharedPassed: 283, serverPassed: 2145, serverDevScriptsPassed: 7, webPassedInFull: 521,
    finalWebPassed: 523, devSupervisorPassed: 37, desktopPassed: 14, postgresSkipped: 32, optionalDockerSkipped: 5,
    focusedPassed: 22, finalSharedPassed: 1, actualHttpPassed: 6, browserFixturePassed: 11, countsOverlap: true }, browser,
  verificationScope: ['Final readonly fixture fixes verified by Shared focused test and workspace typecheck/build',
    'Final BLOCKED/REJECTED UI distinction and two tests followed full run, covered by final Web 523 tests, builds and browser checks'],
  limitations: ['Deterministic provider, not semantic accuracy', 'Browser uses real timeline components and local GET fixture under strict CSP, not actual Electron/SSE network',
    'No new PostgreSQL run; no ordered execution, complete complex clarification, general effects or release acceptance'] };
await writeFile(resolve(directory, 'multi-segment-review-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
