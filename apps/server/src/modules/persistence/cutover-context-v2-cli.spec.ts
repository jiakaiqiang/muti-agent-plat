import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCutoverCliArgs, runCutoverCommand } from './cutover-context-v2.cli.js';
import { initializeV2Persistence } from './persistence.module.js';
import { PersistenceService } from './persistence.service.js';

test('CLI defaults to dry-run when no mode flag is provided', () => {
  assert.deepEqual(parseCutoverCliArgs([], { APP_ENV: 'local' }), {
    mode: 'dry-run',
    environment: 'local'
  });
});

test('CLI accepts an explicit dry-run mode and environment', () => {
  assert.deepEqual(parseCutoverCliArgs(['--dry-run', '--environment', 'staging'], {}), {
    mode: 'dry-run',
    environment: 'staging'
  });
});

test('CLI rejects simultaneous dry-run and apply flags', () => {
  assert.throws(
    () => parseCutoverCliArgs(['--dry-run', '--apply', '--confirm', 'token', '--environment', 'test'], {}),
    /CUTOVER_MODE_CONFLICT/
  );
});

test('CLI requires a confirm token for apply', () => {
  assert.throws(() => parseCutoverCliArgs(['--apply', '--environment', 'test'], {}), /CUTOVER_CONFIRM_TOKEN_REQUIRED/);
});

test('CLI requires an explicit environment binding', () => {
  assert.throws(() => parseCutoverCliArgs(['--dry-run'], {}), /CUTOVER_ENVIRONMENT_REQUIRED/);
});

test('CLI rejects unknown arguments instead of ignoring them', () => {
  assert.throws(
    () => parseCutoverCliArgs(['--dry-run', '--environment', 'test', '--force'], {}),
    /CUTOVER_ARGUMENT_UNKNOWN/
  );
});

test('command refuses to mint a token without a token secret', async () => {
  const persistence = new PersistenceService({ enabled: false });
  await assert.rejects(
    () =>
      runCutoverCommand({
        argv: ['--dry-run', '--environment', 'test'],
        env: {},
        persistence,
        writeOutput: () => undefined
      }),
    /CUTOVER_TOKEN_SECRET_REQUIRED/
  );
});

test('dry-run command is zero-write and omits secret and business content from output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-cutover-cli-'));
  const filePath = join(directory, 'state.json');
  const original = `${JSON.stringify({ sessions: [{ id: 'sensitive-session-id', title: 'sensitive title' }] })}\n`;
  writeFileSync(filePath, original, 'utf8');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
  const output: string[] = [];
  try {
    await runCutoverCommand({
      argv: ['--dry-run', '--environment', 'isolated'],
      env: {
        AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: 'cli-test-secret-with-entropy',
        AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: `${directory}-archive`,
        AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'cli-archive-key-with-sufficient-entropy'
      },
      persistence,
      writeOutput: (line) => output.push(line)
    });
    assert.equal(readFileSync(filePath, 'utf8'), original);
    assert.doesNotMatch(output.join('\n'), /cli-test-secret|sensitive-session-id|sensitive title/);
    assert.match(output.join('\n'), /"mode":"dry-run"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(`${directory}-archive`, { recursive: true, force: true });
  }
});

test('programmatic command binds PersistenceService to the supplied env instead of ambient process.env', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-cutover-env-binding-'));
  const filePath = join(directory, 'explicit-state.json');
  writeFileSync(filePath, `${JSON.stringify({ sessions: [{ id: 'explicit-session' }] })}\n`, 'utf8');
  try {
    const result = await runCutoverCommand({
      argv: ['--dry-run', '--environment', 'env-binding'],
      env: {
        AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
        AGENT_CLUSTER_DATA_FILE: filePath,
        AGENT_CLUSTER_DATA_DIR: directory,
        AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: 'env-binding-token-secret-with-entropy',
        AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: `${directory}-archive`,
        AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'env-binding-archive-key-with-entropy'
      },
      writeOutput: () => undefined
    });
    assert.ok('persistenceLocation' in result);
    assert.equal(result.persistenceLocation, filePath);
    assert.deepEqual(result.collections, [{ key: 'sessions', itemCount: 1 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(`${directory}-archive`, { recursive: true, force: true });
  }
});

test('application persistence initialization enforces the v2 startup gate', async () => {
  const calls: string[] = [];
  const service = {
    async initialize() {
      calls.push('initialize');
    },
    assertCurrentDataReady() {
      calls.push('assertCurrentDataReady');
      throw new Error('CUTOVER_REQUIRED');
    }
  };
  await assert.rejects(() => initializeV2Persistence(service), /CUTOVER_REQUIRED/);
  assert.deepEqual(calls, ['initialize', 'assertCurrentDataReady']);
});
