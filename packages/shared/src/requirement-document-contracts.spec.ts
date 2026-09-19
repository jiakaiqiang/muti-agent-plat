import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIREMENT_DOCUMENT_CONTRACT_VERSION,
  canonicalRequirementDocumentContent,
  canTransitionRequirementDocument,
  isRequirementDocumentSections,
  requirementDocumentLogicalKey,
  supersedeOlderDocuments,
  type RequirementDocument,
  type RequirementDocumentSections
} from './requirement-document-contracts.js';

const sections: RequirementDocumentSections = {
  goal: '实现导出功能。',
  scope: ['导出 Excel'],
  outOfScope: ['导出 PDF'],
  acceptanceCriteria: ['导出文件可被 Excel 打开'],
  risks: ['大文件超时'],
  pendingItems: ['保留期未定']
};

function document(overrides: Partial<RequirementDocument> = {}): RequirementDocument {
  return {
    id: 'doc-1',
    sessionId: 'session-1',
    workItemId: 'wi-1',
    workItemRevision: 3,
    documentRevision: 1,
    contentHash: 'hash-1',
    status: 'formal',
    publishedByAgentId: 'coordinator',
    sourceBriefId: 'brief-1',
    sourceDecisionIds: ['d-1'],
    sourceDelegationIds: ['del-1'],
    sections,
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

test('contract version is pinned', () => {
  assert.equal(REQUIREMENT_DOCUMENT_CONTRACT_VERSION, '1.0');
});

test('canonical content is deterministic and independent of key order or whitespace noise', () => {
  const a = canonicalRequirementDocumentContent(sections);
  const b = canonicalRequirementDocumentContent({
    pendingItems: ['保留期未定'],
    risks: ['大文件超时'],
    acceptanceCriteria: ['导出文件可被 Excel 打开'],
    outOfScope: ['导出 PDF'],
    scope: ['导出 Excel'],
    goal: '  实现导出功能。  '
  });
  assert.equal(a, b, 'the same document content must hash the same however it was assembled');
  assert.notEqual(a, canonicalRequirementDocumentContent({ ...sections, goal: '实现导入功能。' }));
  // List order is meaning: reordering acceptance criteria is a different document.
  assert.notEqual(
    canonicalRequirementDocumentContent({ ...sections, acceptanceCriteria: ['b', 'a'] }),
    canonicalRequirementDocumentContent({ ...sections, acceptanceCriteria: ['a', 'b'] })
  );
});

test('sections are validated as a closed shape so prose fields cannot smuggle extra keys', () => {
  assert.equal(isRequirementDocumentSections(sections), true);
  assert.equal(isRequirementDocumentSections({ ...sections, goal: '' }), false, 'a document needs a goal');
  assert.equal(isRequirementDocumentSections({ ...sections, approvedBy: 'model' }), false, 'approval is not content');
  assert.equal(isRequirementDocumentSections({ ...sections, scope: 'not a list' }), false);
});

test('a document is keyed by requirement and document revision', () => {
  assert.equal(requirementDocumentLogicalKey(document()), 'wi-1|3|1');
  assert.notEqual(requirementDocumentLogicalKey(document({ documentRevision: 2 })), requirementDocumentLogicalKey(document()));
  assert.notEqual(requirementDocumentLogicalKey(document({ workItemRevision: 4 })), requirementDocumentLogicalKey(document()));
});

test('status only moves forward: draft → formal → confirmed, and any of them → superseded', () => {
  assert.equal(canTransitionRequirementDocument('draft', 'formal'), true);
  assert.equal(canTransitionRequirementDocument('formal', 'confirmed'), true);
  assert.equal(canTransitionRequirementDocument('draft', 'superseded'), true);
  assert.equal(canTransitionRequirementDocument('formal', 'superseded'), true);
  assert.equal(canTransitionRequirementDocument('confirmed', 'superseded'), true);

  assert.equal(canTransitionRequirementDocument('draft', 'confirmed'), false, 'a draft is not confirmable; publish it first');
  assert.equal(canTransitionRequirementDocument('confirmed', 'formal'), false, 'confirmation is not undone by editing; a new revision is');
  assert.equal(canTransitionRequirementDocument('superseded', 'formal'), false);
  assert.equal(canTransitionRequirementDocument('superseded', 'confirmed'), false);
});

test('publishing a newer revision supersedes older ones but keeps them as history', () => {
  const before: RequirementDocument[] = [
    document({ id: 'v1', documentRevision: 1, status: 'confirmed' }),
    document({ id: 'v2', documentRevision: 2, status: 'formal' }),
    document({ id: 'v3', documentRevision: 3, status: 'formal' })
  ];
  const after = supersedeOlderDocuments(before, { latestDocumentRevision: 3, now: '2026-09-19T01:00:00.000Z' });
  const byId = Object.fromEntries(after.map((item) => [item.id, item]));
  assert.equal(byId.v1?.status, 'superseded', 'a confirmed old version is superseded, not deleted');
  assert.equal(byId.v1?.supersededAt, '2026-09-19T01:00:00.000Z');
  assert.equal(byId.v2?.status, 'superseded');
  assert.equal(byId.v3?.status, 'formal', 'the latest keeps its own status');
  assert.equal(after.length, 3, 'history is kept');
});

test('a document references its sources; it does not carry a copy of the brief', () => {
  const doc = document();
  assert.equal('brief' in doc, false);
  assert.equal(typeof doc.sourceBriefId, 'string');
  assert.ok(Array.isArray(doc.sourceDecisionIds));
  assert.ok(Array.isArray(doc.sourceDelegationIds));
});
