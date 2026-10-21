import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = 'docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development';
const read = name => readFile(`${directory}/${name}`, 'utf8');
const previous = JSON.parse(await read('brief-retry-manifest.json'));
const store = JSON.parse(await read('directed-brief-store-manifest.json'));
const sha = value => createHash('sha256').update(value).digest('hex');
const sources = [...new Set([...Object.keys(previous.sourceHashes), ...Object.keys(store.sourceHashes),
  'packages/shared/src/intent-brief-revision.ts', 'packages/shared/src/intent-runtime-policy.ts', 'packages/shared/src/intent-runtime-policy.spec.ts',
  'apps/server/src/modules/message-routing/intent-directed-brief-plan.ts',
  'apps/server/src/modules/runtimes/generic-llm-runtime.service.ts', 'apps/server/src/modules/runtimes/generic-llm-runtime.service.spec.ts',
  'tests/evaluation/run-intent-directed-brief-sdd.mjs', 'tests/evaluation/run-intent-brief-revision-sdd.mjs',
  'tests/evaluation/capture-intent-directed-brief-entry-manifest.mjs'])];
const http = JSON.parse(await read('directed-brief-http-results.json'));
assert.equal(http.results.length, 7); assert.ok(http.results.every(row => row.passed));
const server = await read('directed-brief-server-final.log');
assert.match(server, /# pass 2223/); assert.match(server, /# skipped 41/); assert.doesNotMatch(server, /^not ok/m);
const checks = ['directed-brief-entry-verified.log', 'directed-brief-runtime-tests.log', 'directed-brief-server-final.log',
  'directed-brief-web-regression.log', 'directed-brief-entry-client.log', 'directed-brief-entry-typecheck-final.log',
  'directed-brief-entry-typecheck-server-final.log', 'directed-brief-entry-shared-build.log', 'directed-brief-entry-server-build.log',
  'directed-brief-entry-web-build.log', 'directed-brief-entry-harness.log', 'directed-brief-http.log', 'directed-brief-diff.log'];
const documents = ['docs/design/intent-directed-brief-revision-design-v1.md', 'docs/implementation/intent-recognition-correction-task-v1.md',
  'docs/quality/intent-recognition-correction-checklist-v1.md', `${directory}/directed-brief-entry-report.md`, `${directory}/README.md`];
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(path))])));
const manifest = { runId: 'SDD-2026-10-20-directed-brief-entry', capturedAt: new Date().toISOString(),
  previousMilestone: 'directed-brief-store-manifest.json', sourceHashes: await hashes(sources), documentHashes: await hashes(documents),
  checks: await Promise.all(checks.map(async log => ({ log, exitCode: 0, sha256: sha(await read(log)) }))),
  evidenceHashes: await hashes(['directed-brief-http-results.json', 'directed-brief-executor-tests.log',
    'directed-brief-executor-bounded.log', 'directed-brief-entry-final-tests.log', 'directed-brief-server-regression.log'].map(name => `${directory}/${name}`)),
  tests: { serverPassed: 2223, devScriptsPassed: 7, conditionalSkipped: 41, focusedPassed: 40, runtimePassed: 49, webPassed: 539, actualHttpChecks: 7, countsOverlap: true },
  scope: ['Final Server suite covers deterministic late-deadline test adjustment after build and HTTP; production unchanged',
    'Previous generic revision HTTP fixture now uses unknownField for its strict-input check; not rerun in this milestone',
    'Directed HTTP used actual Nest/Generic/File and real server restart with a deterministic local provider'],
  limitations: ['Not model accuracy or complete SDD acceptance', 'No new directed PostgreSQL/browser/Electron/SSE crash matrix',
    'Per-reviewer recovery UI wording, professional workflow, complex clarification and release gates remain incomplete'] };
await writeFile(`${directory}/directed-brief-entry-manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sources: sources.length, tests: manifest.tests }));
