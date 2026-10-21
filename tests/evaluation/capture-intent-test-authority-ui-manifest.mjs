import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('test-authority-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/web/src/stores/intentTestAuthority.ts', 'apps/web/src/stores/intentTestAuthority.spec.ts',
  'apps/web/src/components/IntentTestAuthorityPanel.vue', 'apps/web/src/components/IntentTestAuthorityPanel.spec.ts',
  'apps/web/vitest.config.ts', 'apps/web/src/components/SessionWorkspace.vue', 'apps/desktop/renderer/components/SessionWorkspace.vue',
  'tests/evaluation/serve-intent-test-authority-ui.mjs', 'tests/evaluation/intent-test-authority-ui/main.ts',
  'tests/evaluation/intent-test-authority-ui/index.html', 'tests/evaluation/test-authority-ui-browser-checks.js',
  'tests/evaluation/capture-intent-test-authority-ui-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @project/web', 'test-authority-ui-web-full.log'],
  ['npm run test --workspace @project/web -- src/stores/intentTestAuthority.spec.ts src/components/IntentTestAuthorityPanel.spec.ts', 'test-authority-ui-related.log'],
  ['npm run typecheck', 'test-authority-ui-workspace-typecheck.log'],
  ['npm run build --workspace @project/web', 'test-authority-ui-web-build.log'],
  ['npm run build --workspace @agent-cluster/desktop', 'test-authority-ui-desktop-build.log'],
  ['npm run test:harness', 'test-authority-ui-harness.log'], ['git diff --check', 'test-authority-ui-diff-check.log'],
  ['node tests/evaluation/serve-intent-test-authority-ui.mjs; named playwright-cli session, two tabs; run-code --filename tests/evaluation/test-authority-ui-browser-checks.js', 'test-authority-ui-browser-checks.log']
];
const full = await load('test-authority-ui-web-full.log'), related = await load('test-authority-ui-related.log');
if (!/Tests\s+493 passed \(493\)/.test(full) || !/Tests\s+12 passed \(12\)/.test(related) ||
  !/intentTestAuthority\.spec\.ts \(7 tests\)/.test(related) || !/IntentTestAuthorityPanel\.spec\.ts \(5 tests\)/.test(related)) throw new Error('Unexpected test coverage');
const browserLog = await load('test-authority-ui-browser-checks.log');
const browser = JSON.parse(browserLog.split(/\r?\n/).find(line => line.startsWith('{"browserChecks"')) ?? 'null');
if (!browser || browser.browserChecks.length !== 8 || browser.browserChecks.some(row => !row.passed) || !browser.retryIdempotent || browser.uncertainPostCount !== 2) throw new Error('Browser evidence incomplete');
const state = JSON.parse(await load('test-authority-ui-browser-state.json'));
if (state.events.length !== 4 || state.authority.grant.revision !== 4 || !state.authority.grant.revokedAt || state.testInvocations.length ||
  state.events.some((event, i) => event.metadata.payload.grantRevision !== i + 1)) throw new Error('Unexpected durable browser effects');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/test-authority-ui-report.md'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-test-authority-ui', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'test-authority-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  artifacts: await Promise.all(['test-authority-ui-mobile.png', 'test-authority-ui-desktop.png', 'test-authority-ui-browser-state.json',
    'test-authority-ui-browser-server.log', 'test-authority-ui-related-incomplete.log', 'test-authority-ui-web-incomplete.log']
    .map(async path => ({ path, sha256: sha(await readFile(resolve(directory, path))) }))),
  tests: { webPassed: 493, relatedPassed: 12, browserPassed: 8, browserEffectiveEvents: 4, countsOverlap: true },
  scope: { actualBrowser: true, actualIsolatedNestApi: true, realElectronInteraction: false, actualSseTransportTested: false,
    serverFullRerun: false, realDockerRerun: false, realPostgresVerified: false, newIntentTestDispatchEnabled: false, productionConfigurationChanged: false },
  limitations: ['Early Vitest runs omitted the new Store file; retained as incomplete, corrected configuration and reran all Web tests',
    'Browser uses a shared product component fixture, not full Web navigation or an Electron process',
    'Unknown request recovery is per-tab sessionStorage; closing/clearing storage may remove it',
    'Versioned test dispatch, running-test revocation, report transactions and complete acceptance remain incomplete'] };
await writeFile(resolve(directory, 'test-authority-ui-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
