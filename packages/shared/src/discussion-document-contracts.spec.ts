import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCUSSION_DOCUMENT_ROLE,
  isDiscussionDocumentPublishedPayload,
  type DiscussionDocumentPublishedPayload
} from './discussion-document-contracts.js';

const payload: DiscussionDocumentPublishedPayload = {
  documentId: 'document-1',
  artifactId: 'artifact-1',
  documentRole: DISCUSSION_DOCUMENT_ROLE,
  revision: 1,
  title: 'Implementation plan',
  relativePath: '.agent-cluster/discussion-documents/session-1/plan-revision-001.md',
  contentUrl: '/api/sessions/session-1/discussion-documents/document-1/content',
  uiUrl: '/sessions/session-1?document=document-1',
  contentHash: 'a'.repeat(64),
  sizeBytes: 42,
  readStatus: 'reading'
};

test('discussion document event payload accepts references without the markdown body', () => {
  assert.equal(isDiscussionDocumentPublishedPayload(payload), true);
});

test('discussion document event payload rejects content leakage and malformed hashes', () => {
  assert.equal(isDiscussionDocumentPublishedPayload({ ...payload, content: '# secret' }), false);
  assert.equal(isDiscussionDocumentPublishedPayload({ ...payload, markdown: '# secret' }), false);
  assert.equal(isDiscussionDocumentPublishedPayload({ ...payload, contentHash: 'not-a-hash' }), false);
});

