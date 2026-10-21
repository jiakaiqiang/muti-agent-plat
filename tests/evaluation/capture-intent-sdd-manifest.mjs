import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const baseline = JSON.parse(await readFile(resolve(directory, 'baseline-manifest.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const hash = data => createHash('sha256').update(data).digest('hex');
const changed = git('diff', '--name-only').split(/\r?\n/);
const added = git('ls-files', '--others', '--exclude-standard').split(/\r?\n/)
  .filter(path => /^(apps\/(server|web)\/src|packages\/shared\/src|tests\/evaluation)\//.test(path) && /\.(ts|mjs)$/.test(path));
const paths = [...new Set([...Object.keys(baseline.hashes), ...changed, ...added, 'package-lock.json'])]
  .filter(path => /\.(ts|vue|mjs|json)$/.test(path)).sort();
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(path))])));
const checks = [
  ['npm run typecheck', 'typecheck-scope.log', 0],
  ['npm run build', 'build-scope.log', 0],
  ['npm run test', 'workspace-tests-final.log', 0],
  ['npm run test:harness', 'harness.log', 0],
  ['node tests/evaluation/run-intent-correction-sdd.mjs', 'correction-http.log', 0],
  ['node tests/evaluation/run-intent-restricted-routing-sdd.mjs', 'restricted-routing-http.log', 0]
];
const manifest = {
  runId: 'SDD-2026-10-19-runtime-boundary', capturedAt: new Date().toISOString(), node: process.version,
  baselineManifest: 'baseline-manifest.json', head: git('rev-parse', 'HEAD'),
  trackedDiffSha256: hash(execFileSync('git', ['diff', '--binary'], { stdio: ['ignore', 'pipe', 'ignore'] })),
  sourceHashes, checks: await Promise.all(checks.map(async ([command, log, exitCode]) => ({ command, log, exitCode,
    logSha256: hash(await readFile(resolve(directory, log))) }))),
  configurationSources: ['isolated smoke-server test environment', 'existing workspace dependency lockfile'],
  runtimeEvidence: { classifier: 'mock in HTTP tests; no live semantic model accuracy claim',
    adapters: 'unit fixtures and temporary filesystem; no live CLI sandbox certification', backend: 'File',
    clients: 'Web/Desktop build and unit tests; no real Electron interaction in this run' },
  limitations: ['20 backend tests skipped by the repository runner', 'new semantic contract not enabled for business execution',
    'new scopes support only answer/workspace-read through Generic LLM or mock; unsupported execution is blocked',
    'no PostgreSQL, production migration, deployment, independent human annotation or release performed']
};
await writeFile(resolve(directory, 'runtime-boundary-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ runId: manifest.runId, sourceFileCount: paths.length, checks: checks.length }));
