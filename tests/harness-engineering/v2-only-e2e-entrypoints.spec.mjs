import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const mainChain = read('tests/e2e/run-main-chain.mjs');
const contextInsufficient = read('tests/e2e/context-insufficient-smoke.mjs');
const multiRetry = read('tests/e2e/context-insufficient-multi-retry-smoke.mjs');
const browserRetry = read('tests/e2e/browser-context-insufficient-retry-smoke.mjs');
const packageJson = read('package.json');

test('main-chain imports the authoritative v2 smoke-state factory', () => {
  assert.match(mainChain, /createSmokeV2State/);
});

test('main-chain persists v2 state before starting the server', () => {
  const writeIndex = mainChain.indexOf('writeFileSync');
  const spawnIndex = mainChain.indexOf("spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js']");
  assert.ok(writeIndex >= 0 && spawnIndex > writeIndex);
});

test('main-chain enables the file persistence backend explicitly', () => {
  assert.match(mainChain, /AGENT_CLUSTER_PERSISTENCE:\s*'true'/);
  assert.match(mainChain, /AGENT_CLUSTER_PERSISTENCE_BACKEND:\s*'file'/);
});

test('single context-insufficient smoke creates an isolated workspace', () => {
  assert.match(contextInsufficient, /mkdtempSync/);
  assert.match(contextInsufficient, /workingDirectory:\s*\{/);
});

test('single context-insufficient smoke binds the server-local provider', () => {
  assert.match(contextInsufficient, /kind:\s*'server_local'/);
  assert.match(contextInsufficient, /path:\s*workspaceRoot/);
});

test('multi-retry smoke creates an isolated workspace', () => {
  assert.match(multiRetry, /mkdtempSync/);
  assert.match(multiRetry, /workingDirectory:\s*\{/);
});

test('multi-retry smoke binds the server-local provider', () => {
  assert.match(multiRetry, /kind:\s*'server_local'/);
  assert.match(multiRetry, /path:\s*workspaceRoot/);
});

test('browser retry smoke creates an isolated workspace', () => {
  assert.match(browserRetry, /mkdtempSync/);
  assert.match(browserRetry, /workingDirectory:\s*\{/);
});

test('browser retry smoke binds the server-local provider', () => {
  assert.match(browserRetry, /kind:\s*'server_local'/);
  assert.match(browserRetry, /path:\s*workspaceRoot/);
});

test('active package scripts do not reference deleted compatibility smokes', () => {
  for (const obsolete of [
    'session-resumption-smoke',
    'actor-ref-postgres-backfill-smoke',
    'engineering-runtime-selection-smoke',
    'task-claim-decision-smoke',
    'unified-task-context-smoke',
    'skill-management-browser-smoke'
  ]) {
    assert.doesNotMatch(packageJson, new RegExp(obsolete));
  }
});

test('single file-context smoke requires requestedPaths', () => {
  assert.match(contextInsufficient, /requestedContext\.requestedPaths\?\.length/);
});

test('single file-context smoke does not require requestedRefs', () => {
  assert.doesNotMatch(contextInsufficient, /requestedContext\.requestedRefs\?\.length/);
});

test('single file-context smoke validates the Debug path count', () => {
  assert.match(contextInsufficient, /requestedContextPathCount\s*>\s*0/);
});

test('single file-context smoke does not use Debug ref count as file evidence', () => {
  assert.doesNotMatch(contextInsufficient, /requestedContextRefCount\s*>\s*0/);
});

test('multi-retry file smoke reads requestedPaths from failures', () => {
  assert.match(multiRetry, /requestedContext\?\.requestedPaths/);
});

test('multi-retry file smoke compares distinct paths', () => {
  assert.match(multiRetry, /uniquePaths/);
});

test('multi-retry file smoke does not extract ref objects as file paths', () => {
  assert.doesNotMatch(multiRetry, /refs\[0\]\?\.ref/);
});

test('multi-retry diagnostics name requested paths', () => {
  assert.match(multiRetry, /requestedPaths:/);
});
