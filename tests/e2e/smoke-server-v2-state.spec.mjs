import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSmokeV2State } from './smoke-server.mjs';

const source = readFileSync(resolve(import.meta.dirname, 'smoke-server.mjs'), 'utf8');

test('smoke infrastructure defines one v2 state factory', () => {
  assert.match(source, /export function createSmokeV2State/);
});

test('smoke v2 state declares data schema version 3 and pipeline v2', () => {
  const state = createSmokeV2State();
  assert.equal(state.systemDataMetadata.dataSchemaVersion, 3);
  assert.equal(state.systemDataMetadata.pipelineVersion, 'v2');
});

test('smoke v2 state creates a fresh data epoch and audit id', () => {
  const first = createSmokeV2State();
  const second = createSmokeV2State();
  assert.notEqual(first.systemDataMetadata.dataEpoch, second.systemDataMetadata.dataEpoch);
  assert.notEqual(first.systemDataMetadata.cutoverAuditId, second.systemDataMetadata.cutoverAuditId);
  assert.equal(first.cutoverAudits[0].dataEpoch, first.systemDataMetadata.dataEpoch);
  assert.equal(first.cutoverAudits[0].id, first.systemDataMetadata.cutoverAuditId);
});

test('smoke v2 state records a cutover timestamp', () => {
  assert.equal(Number.isNaN(Date.parse(createSmokeV2State().systemDataMetadata.cutoverAt)), false);
});

test('smoke v2 state includes empty Session-owned collections', () => {
  const state = createSmokeV2State();
  for (const key of ['sessions', 'eventsBySession', 'tasksBySession', 'briefsBySession', 'runtimeInvocationsBySession']) {
    assert.equal(Object.hasOwn(state, key), true);
  }
});

test('smoke v2 state uses production Artifact and Knowledge collection shapes', () => {
  const state = createSmokeV2State();
  assert.deepEqual(state.artifacts, { artifactsById: {}, artifactIdsBySession: {} });
  assert.deepEqual(state.knowledge, { knowledgeBases: {}, documentsByBase: {}, chunksByBase: {} });
});

test('startSmokeServer persists v2 state before spawning the server', () => {
  const start = source.slice(source.indexOf('export async function startSmokeServer'), source.indexOf('export async function stopSmokeServer'));
  assert.match(start, /writeFileSync\(dataFile, JSON\.stringify\(createSmokeV2State\(\)/);
  assert.ok(start.indexOf('writeFileSync(') < start.indexOf('spawn('));
});

test('smoke bootstrap contains no v1 flag or historical state fallback', () => {
  assert.doesNotMatch(source, /CONTEXT_PIPELINE_V2_ENABLED|contextPipelineVersion:\s*['"]v1['"]|legacy/i);
});
