import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESULT_REUSE_CONTRACT_VERSION,
  resultReuseEvidence,
  canReuseCompletedResult,
  isLateResultForSupersededRevision,
  type ResultReuseEvidence
} from './result-reuse-contracts.js';

function evidence(overrides: Partial<ResultReuseEvidence> = {}): ResultReuseEvidence {
  return {
    workItemId: 'wi-1',
    workItemRevision: 3,
    documentRevision: 2,
    contentHash: 'hash-doc-2',
    inputFingerprint: 'fp-input-1',
    fileHashes: { 'src/export.ts': 'hash-file-a' },
    ...overrides
  };
}

test('the contract version is pinned so stored evidence cannot be read under new rules', () => {
  assert.equal(RESULT_REUSE_CONTRACT_VERSION, 'result-reuse-v1');
});

test('evidence is derived deterministically from the versions a result was produced against', () => {
  const first = resultReuseEvidence({
    workItemId: 'wi-1', workItemRevision: 3, documentRevision: 2,
    contentHash: 'hash-doc-2', inputFingerprint: 'fp-input-1',
    fileHashes: { 'src/export.ts': 'hash-file-a' }
  });

  assert.deepEqual(first, evidence());
  assert.deepEqual(first, resultReuseEvidence(evidence()), 'the same inputs always produce the same evidence');
});

test('a result is reusable only when every version it was produced against still holds', () => {
  const current = evidence();

  assert.equal(canReuseCompletedResult(evidence(), current).reusable, true);

  // A revised requirement means the completed work answered an older question.
  const revisedRequirement = canReuseCompletedResult(evidence(), evidence({ workItemRevision: 4 }));
  assert.equal(revisedRequirement.reusable, false);
  assert.equal(revisedRequirement.reason, 'work_item_revision_changed');

  const revisedDocument = canReuseCompletedResult(evidence(), evidence({ documentRevision: 3, contentHash: 'hash-doc-3' }));
  assert.equal(revisedDocument.reusable, false);
  assert.equal(revisedDocument.reason, 'document_revision_changed');

  // Same revision, different content is still a different document.
  const rewritten = canReuseCompletedResult(evidence(), evidence({ contentHash: 'hash-other' }));
  assert.equal(rewritten.reusable, false);
  assert.equal(rewritten.reason, 'content_hash_changed');
});

test('a changed input fingerprint invalidates reuse even when the document is identical', () => {
  const outcome = canReuseCompletedResult(evidence(), evidence({ inputFingerprint: 'fp-input-2' }));

  assert.equal(outcome.reusable, false);
  assert.equal(outcome.reason, 'input_fingerprint_changed');
});

test('a file edited since the result was produced invalidates reuse and names the file', () => {
  const outcome = canReuseCompletedResult(
    evidence(),
    evidence({ fileHashes: { 'src/export.ts': 'hash-file-b' } })
  );

  assert.equal(outcome.reusable, false);
  assert.equal(outcome.reason, 'file_hash_changed');
  assert.deepEqual(outcome.changedFilePaths, ['src/export.ts']);
});

test('a file the result never touched does not block reuse', () => {
  const outcome = canReuseCompletedResult(
    evidence(),
    evidence({ fileHashes: { 'src/export.ts': 'hash-file-a', 'src/unrelated.ts': 'hash-new' } })
  );

  assert.equal(outcome.reusable, true, 'evidence covers the files the result claimed, not the whole tree');
});

test('a result with no evidence is never reusable: absence of proof is not proof', () => {
  const outcome = canReuseCompletedResult(undefined, evidence());

  assert.equal(outcome.reusable, false);
  assert.equal(outcome.reason, 'evidence_missing');
});

test('a late result bound to a superseded revision cannot count as the new requirement output', () => {
  // The invocation was dispatched before the user revised the requirement and
  // landed afterwards. Accepting it would credit the new requirement with work
  // done against the old one.
  assert.equal(
    isLateResultForSupersededRevision(evidence({ workItemRevision: 3, documentRevision: 2 }), {
      workItemRevision: 4,
      documentRevision: 3
    }),
    true
  );
  assert.equal(
    isLateResultForSupersededRevision(evidence(), { workItemRevision: 3, documentRevision: 2 }),
    false,
    'a result produced against the current revision is not late'
  );
  // A result from a *newer* revision than the caller knows about is not "late";
  // it is the caller that is stale, and the guard must not silently accept it.
  assert.equal(
    isLateResultForSupersededRevision(evidence({ workItemRevision: 5 }), {
      workItemRevision: 4,
      documentRevision: 3
    }),
    true
  );
});
