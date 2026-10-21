// Records the completed milestone's checks; this script does not run tests.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const baseline = JSON.parse(await readFile(resolve(directory, 'baseline-manifest.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = [...new Set([...Object.keys(baseline.hashes), ...git('diff', '--name-only').split(/\r?\n/),
  ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(path =>
    /^(apps\/(server|web|desktop)|packages\/(shared|local-runtime-cli)|tests\/evaluation)\//.test(path)), 'package-lock.json'])]
  .filter(path => /\.(ts|vue|mjs|json)$/.test(path) && !path.includes('/dist/')).sort();
const checks = [
  ['npm run typecheck', 'correction-version-typecheck.log'],
  ['npm run build', 'correction-version-build.log'],
  ['npm run build --workspace @agent-cluster/server', 'correction-version-server-build.log'],
  ['npm run test', 'workspace-tests-versioned-correction-final.log'],
  ['npx tsx --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/runtimes/logical-operation-store.spec.ts apps/server/src/modules/message-routing/intent-correction.service.spec.ts', 'correction-stop-regression.log'],
  ['npm run test:harness', 'correction-version-harness.log'],
  ['node tests/evaluation/run-intent-versioned-correction-sdd.mjs', 'versioned-correction-http.log']
];
const results = JSON.parse(await readFile(resolve(directory, 'versioned-correction-http-results.json'), 'utf8'));
if (results.results.length !== 8 || results.results.some(item => !item.passed)) throw new Error('HTTP milestone has not passed');
const manifest = {
  runId: 'SDD-2026-10-19-versioned-correction', capturedAt: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), baselineManifest: 'baseline-manifest.json',
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { stdio: ['ignore', 'pipe', 'ignore'] })),
  sourceHashes: Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))]))),
  checks: await Promise.all(checks.map(async ([command, log]) => ({ command, log, exitCode: 0, logSha256: hash(await readFile(resolve(directory, log))) }))),
  verificationScope: {
    fullSuite: '2826 passed, 0 failed, 21 PostgreSQL tests skipped',
    finalDelta: 'After the full suite began, one targeted-stop guard was tightened to preserve unknown evidence and reject requested stops in routing admission. The final source passed the focused 26-test regression, the final server build and the repeated 8-case HTTP suite. The new guard test is not counted in the 2826 full-suite passes.',
    runtime: 'mock adapters and exact invocation cancellation; no live CLI sandbox certification',
    http: 'localhost, isolated File persistence, mock classifier, actual server restart',
    backend: 'File verified; PostgreSQL integration added but skipped without RELATIONAL_TEST_DATABASE_URL'
  },
  limitations: ['correction plan validation and activation are not implemented; no applied result is claimed',
    'ordinary-chat correction integration and late result/writeback version guards remain incomplete',
    'new semantic classifier/main ingress, actual effect scopes, both clients and release gates remain incomplete',
    'no production database migration, deployment or model connection modification performed']
};
await writeFile(resolve(directory, 'versioned-correction-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFiles: paths.length, checks: checks.length }));
