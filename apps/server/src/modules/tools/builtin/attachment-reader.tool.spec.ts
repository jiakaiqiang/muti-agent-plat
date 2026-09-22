import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalContentStore } from '../../persistence/local-content-store.js';
import { PersistenceService } from '../../persistence/persistence.service.js';
import { AttachmentReaderTool } from './attachment-reader.tool.js';

test('reads only a session-owned attachment ID and returns bounded base64 bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-attachment-tool-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(root, 'state.json') });
  await persistence.initialize();
  const store = new LocalContentStore({ rootDir: root });
  try {
    const stored = store.put(Buffer.from('hello attachment'), 'text/plain', 'notes.txt');
    await persistence.setCollection('groupChatAttachments', [{
      id: 'attachment-1', sessionId: 'session-1', kind: 'file', fileName: 'notes.txt', mimeType: 'text/plain',
      sizeBytes: 16, uploadStatus: 'ready', createdAt: new Date().toISOString(), contentRef: stored.contentRef
    }]);
    const tool = new AttachmentReaderTool(persistence, store);
    const result = await tool.execute({ attachmentId: 'attachment-1', maxBytes: 5 }, {
      workingDirectory: 'D:/workspace', sessionId: 'session-1'
    });
    assert.equal(result.success, true);
    assert.equal((result.output as { bytesBase64: string }).bytesBase64, Buffer.from('hello').toString('base64'));
    assert.equal((result.output as { truncated: boolean }).truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a cross-session or deleted attachment without reading arbitrary paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-attachment-tool-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(root, 'state.json') });
  await persistence.initialize();
  const store = new LocalContentStore({ rootDir: root });
  try {
    const stored = store.put(Buffer.from('secret'), 'text/plain', 'secret.txt');
    await persistence.setCollection('groupChatAttachments', [{
      id: 'attachment-2', sessionId: 'session-1', kind: 'file', fileName: 'secret.txt', mimeType: 'text/plain',
      sizeBytes: 6, uploadStatus: 'deleted', createdAt: new Date().toISOString(), contentRef: stored.contentRef
    }]);
    const tool = new AttachmentReaderTool(persistence, store);
    const outside = await tool.execute({ attachmentId: 'attachment-2' }, { workingDirectory: 'D:/workspace', sessionId: 'session-2' });
    assert.equal(outside.success, false);
    assert.equal(outside.error, 'ATTACHMENT_NOT_FOUND_OR_OUTSIDE_SESSION');
    const deleted = await tool.execute({ attachmentId: 'attachment-2' }, { workingDirectory: 'D:/workspace', sessionId: 'session-1' });
    assert.equal(deleted.success, false);
    assert.equal(deleted.error, 'ATTACHMENT_DELETED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
