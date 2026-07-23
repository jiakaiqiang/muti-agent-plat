import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const command = join(repositoryRoot, 'scripts', 'cutover-context-v2.mjs');

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-cutover-e2e-'));
  const archiveDirectory = `${directory}-archive`;
  const filePath = join(directory, 'state.json');
  const originalState = {
    sessions: [{ id: 'old-session', title: 'private title' }],
    eventsBySession: { 'old-session': [{ content: 'private event' }] }
  };
  writeFileSync(filePath, `${JSON.stringify(originalState, null, 2)}\n`, 'utf8');
  const env = {
    ...process.env,
    AGENT_CLUSTER_PERSISTENCE: 'true',
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_DATA_DIR: directory,
    AGENT_CLUSTER_DATA_FILE: filePath,
    AGENT_CLUSTER_CUTOVER_ENVIRONMENT: 'isolated-e2e',
    AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: 'isolated-e2e-secret-with-entropy',
    AGENT_CLUSTER_CUTOVER_OPERATOR: 'e2e-operator',
    AGENT_CLUSTER_CUTOVER_QUIESCED: 'true',
    AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: archiveDirectory,
    AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'isolated-e2e-archive-key-with-entropy',
    AGENT_CLUSTER_COMMIT: 'e2e-commit'
  };
  function run(args: string[], overrides: Record<string, string | undefined> = {}) {
    const childEnv = { ...env, ...overrides };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    return spawnSync(process.execPath, [command, ...args], {
      cwd: repositoryRoot,
      env: childEnv as NodeJS.ProcessEnv,
      encoding: 'utf8'
    });
  }
  function dryRun(args = ['--dry-run']) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as { confirmToken: string; mode: string; collections: unknown[] };
  }
  return {
    directory,
    filePath,
    originalText: readFileSync(filePath, 'utf8'),
    run,
    dryRun,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
      rmSync(archiveDirectory, { recursive: true, force: true });
    }
  };
}

test('file CLI defaults to dry-run without a mode flag', () => {
  const fixture = setup();
  try { assert.equal(fixture.dryRun([]).mode, 'dry-run'); } finally { fixture.cleanup(); }
});

test('file CLI accepts explicit dry-run', () => {
  const fixture = setup();
  try { assert.equal(fixture.dryRun(['--dry-run']).mode, 'dry-run'); } finally { fixture.cleanup(); }
});

test('file CLI dry-run performs zero writes', () => {
  const fixture = setup();
  try {
    fixture.dryRun();
    assert.equal(readFileSync(fixture.filePath, 'utf8'), fixture.originalText);
  } finally { fixture.cleanup(); }
});

test('file CLI dry-run output omits business content and token secret', () => {
  const fixture = setup();
  try {
    const result = fixture.run(['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /private title|private event|isolated-e2e-secret/);
  } finally { fixture.cleanup(); }
});

test('file CLI apply refuses to run outside maintenance mode', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    const result = fixture.run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'false' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CUTOVER_MAINTENANCE_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('file CLI apply requires an explicit operator identity', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    const result = fixture.run(['--apply', '--confirm', token], {
      AGENT_CLUSTER_MAINTENANCE_MODE: 'true',
      AGENT_CLUSTER_CUTOVER_OPERATOR: undefined
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CUTOVER_OPERATOR_REQUIRED/);
  } finally { fixture.cleanup(); }
});

test('file CLI apply succeeds with maintenance, token, environment, and operator binding', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    const result = fixture.run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'applied');
  } finally { fixture.cleanup(); }
});

test('file CLI apply preserves historical sessions and related events while stamping v2 metadata', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    const result = fixture.run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(fixture.filePath, 'utf8')) as Record<string, unknown>;
    assert.equal((state.systemDataMetadata as { pipelineVersion: string }).pipelineVersion, 'v2');
    assert.deepEqual((state.sessions as Array<{ id: string }>).map((session) => session.id), ['old-session']);
    assert.equal((state.sessions as Array<{ dataEpoch: string }>)[0].dataEpoch.length > 0, true);
    assert.deepEqual((state.eventsBySession as Record<string, unknown[]> )['old-session'], [{ content: 'private event' }]);
    assert.equal(Array.isArray(state.cutoverAudits), true);
  } finally { fixture.cleanup(); }
});

test('file CLI rejects a token after persistence revision changes', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    writeFileSync(fixture.filePath, `${JSON.stringify({ sessions: [{ id: 'newer' }] })}\n`, 'utf8');
    const result = fixture.run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CUTOVER_STALE_DRY_RUN/);
  } finally { fixture.cleanup(); }
});

test('file CLI apply does not leave backup or temporary state files', () => {
  const fixture = setup();
  try {
    const token = fixture.dryRun().confirmToken;
    const result = fixture.run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(fixture.directory).sort(), ['state.json']);
    assert.equal(existsSync(`${fixture.filePath}.bak`), false);
  } finally { fixture.cleanup(); }
});
