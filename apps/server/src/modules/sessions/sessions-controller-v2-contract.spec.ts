import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertDecideFileRevisionInput,
  assertResolveFileRevisionFailureInput,
  assertRetryInterruptedFileRevisionInput,
  assertSessionCreateContract
} from './sessions.controller.js';

test('Session create accepts only the v2 request surface', () => {
  assert.doesNotThrow(() =>
    assertSessionCreateContract({
      input: 'analyze the architecture',
      runtimePreference: { preferredRuntimeType: 'codex' }
    })
  );
});

test('Session create rejects legacy routing, context, and client snapshot fields instead of ignoring them', () => {
  for (const field of ['workspaceSnapshot', 'runtimeType', 'modelId', 'executionTarget', 'contextAssembly', 'pipelineVersion']) {
    assert.throws(
      () => assertSessionCreateContract({ input: 'analyze', [field]: 'legacy-value' }),
      /Unsupported Session create fields/
    );
  }
});

test('Session API exposes the complete file-revision lifecycle under the owning Session', () => {
  const source = readFileSync(new URL('./sessions.controller.ts', import.meta.url), 'utf8');

  assert.match(source, /@Get\('sessions\/:sessionId\/file-revisions'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions\/baselines'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions'\)/);
  assert.match(source, /@Get\('sessions\/:sessionId\/file-revisions\/:revisionId\/candidate'\)/);
  assert.match(source, /@Get\('sessions\/:sessionId\/file-revisions\/:revisionId\/draft'\)/);
  assert.match(source, /@Put\('sessions\/:sessionId\/file-revisions\/:revisionId\/draft'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions\/:revisionId\/reprocess'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions\/:revisionId\/failure-decision'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions\/:revisionId\/retry'\)/);
  assert.match(source, /@Post\('sessions\/:sessionId\/file-revisions\/:revisionId\/decision'\)/);
});

test('interrupted file revision retry requires a state version and idempotency key', () => {
  assert.doesNotThrow(() => assertRetryInterruptedFileRevisionInput({
    expectedStateVersion: 2,
    retryKey: 'retry-1'
  }));
  assert.throws(
    () => assertRetryInterruptedFileRevisionInput({ expectedStateVersion: 2, retryKey: '' }),
    /INVALID_FILE_REVISION_REQUEST/
  );
});

test('partial Agent failure decisions require a precise state version and an allowed action', () => {
  assert.doesNotThrow(() => assertResolveFileRevisionFailureInput({
    expectedStateVersion: 3,
    decision: 'continue_with_successful',
    instruction: 'Use completed results.'
  }));
  assert.throws(
    () => assertResolveFileRevisionFailureInput({ expectedStateVersion: 3, decision: 'continue_silently' }),
    /INVALID_FILE_REVISION_DECISION/
  );
  assert.throws(
    () => assertResolveFileRevisionFailureInput({ decision: 'retry_agents' }),
    /INVALID_FILE_REVISION_REQUEST/
  );
});

test('file revision decision uses a runtime whitelist and precise candidate identity', () => {
  const valid = {
    confirmationId: 'confirmation-1',
    candidateHash: { algorithm: 'sha256', value: 'a'.repeat(64) },
    expectedStateVersion: 2,
    decision: 'apply_candidate'
  };
  assert.doesNotThrow(() => assertDecideFileRevisionInput(valid));
  assert.throws(
    () => assertDecideFileRevisionInput({ ...valid, decision: 'keep_user_revision' }),
    /INVALID_FILE_REVISION_DECISION/
  );
  assert.throws(
    () => assertDecideFileRevisionInput({ ...valid, candidateHash: undefined }),
    /INVALID_FILE_REVISION_REQUEST/
  );
});
