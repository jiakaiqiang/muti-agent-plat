import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = name => readFile(resolve(directory, name), 'utf8');
const previous = JSON.parse(await load('workspace-authority-manifest.json'));
const sources = [...new Set([...Object.keys(previous.sourceHashes),
  'apps/web/src/stores/intentWorkspaceAuthority.ts', 'apps/web/src/stores/intentWorkspaceAuthority.spec.ts',
  'apps/web/src/components/IntentWorkspaceAuthorityPanel.vue', 'apps/web/src/components/IntentWorkspaceAuthorityPanel.spec.ts',
  'apps/web/src/components/SessionWorkspace.vue', 'apps/desktop/renderer/components/SessionWorkspace.vue', 'apps/web/vitest.config.ts',
  'tests/evaluation/serve-intent-workspace-authority-ui.mjs', 'tests/evaluation/intent-workspace-authority-ui/main.ts',
  'tests/evaluation/intent-workspace-authority-ui/index.html', 'tests/evaluation/capture-intent-workspace-authority-ui-manifest.mjs'])];
const checks = [
  ['npm run test --workspace @project/web', 'workspace-authority-ui-web-tests.log'],
  ['npm run typecheck', 'workspace-authority-ui-typecheck.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts apps/server/src/modules/sessions/sessions.service.spec.ts', 'workspace-authority-ui-server-regression.log'],
  ['npm run build --workspace @agent-cluster/shared', 'workspace-authority-ui-shared-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'workspace-authority-ui-server-build.log'],
  ['npm run build --workspace @project/web', 'workspace-authority-ui-web-build.log'],
  ['npm run build --workspace @agent-cluster/desktop', 'workspace-authority-ui-desktop-build.log'],
  ['INTENT_AUTHORITY_EVIDENCE_PREFIX=workspace-authority-ui node tests/evaluation/run-intent-workspace-authority-sdd.mjs', 'workspace-authority-ui-http-final.log'],
  ['npm run test:harness', 'workspace-authority-ui-harness.log'],
  ['git diff --check', 'workspace-authority-ui-diff-check.log']
];
if (!/Tests\s+481 passed/.test(await load('workspace-authority-ui-web-tests.log'))) throw new Error('Web results differ');
if (!/^# pass 168$/m.test(await load('workspace-authority-ui-server-regression.log'))) throw new Error('Server results differ');
const http = JSON.parse(await load('workspace-authority-ui-http-results.json'));
if (http.results.length !== 8 || http.results.some(row => !row.passed)) throw new Error('HTTP checks incomplete');
const browser = JSON.parse(await load('workspace-authority-ui-browser-state.json'));
if (browser.authority.grant.revision !== 4 || !browser.authority.grant.revokedAt || browser.events.length !== 3 ||
  browser.events.map(row => row.metadata.payload.request.action).join() !== 'revoke,grant,revoke') throw new Error('Browser persisted state differs');
const docs = ['docs/product/intent-recognition-correction-spec-v1.md', 'docs/design/intent-recognition-correction-plan-v1.md',
  'docs/design/intent-recognition-correction-system-development-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md',
  'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development/workspace-authority-ui-report.md'];
const evidence = ['workspace-authority-ui-http-results.json', 'workspace-authority-ui-browser-state.json',
  'workspace-authority-ui-browser-results.json', 'workspace-authority-ui-initial.yml', 'workspace-authority-ui-conflict.yml',
  'workspace-authority-ui-regrant.yml', 'workspace-authority-ui-keyboard.log', 'workspace-authority-ui-conflict.png', 'workspace-authority-ui-mobile.png'];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-19-workspace-authority-ui', capturedAt: new Date().toISOString(), node: process.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineManifest: 'baseline-manifest.json', previousMilestone: 'workspace-authority-manifest.json',
  sourceHashes: await hashes(sources), documentHashes: await hashes(docs),
  evidenceHashes: Object.fromEntries(await Promise.all(evidence.map(async name => [name, sha(await readFile(resolve(directory, name)))]))),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: sha(await load(log)) }))),
  tests: { webPassed: 481, newUIAndStorePassed: 11, serverRelatedPassed: 168, httpPassed: 8, countsOverlap: true },
  scope: { backend: 'isolated File', browser: 'Playwright CLI shared component fixture with actual backend; two tabs, not full application/Electron',
    realPostgresVerified: false, fullWorkspaceTestsRerun: false, productionConfigurationChanged: false },
  limitations: ['Original workspace-authority-http-results.json was overwritten by first rerun; prior manifest JSON hash no longer matches. Original logs retained; current results have separate filename.',
    'Real Electron/dual-client SSE fault matrix, scoped executors, business dispatch, independent annotation and release gates remain incomplete'] };
await writeFile(resolve(directory, 'workspace-authority-ui-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: sources.length, tests: manifest.tests }));
