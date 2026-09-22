import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistenceService } from '../persistence/persistence.service.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import {
  AttachmentsService,
  GROUP_CHAT_IMAGE_MAX_BYTES,
  assertHumanAttachmentUpload,
  type AttachmentUploadFile
} from './attachments.service.js';
import { FakeImageContentUnderstandingProvider, type ImageContentUnderstandingProvider } from './image-recognition.provider.js';

function file(name: string, mimetype: string, content = 'bytes'): AttachmentUploadFile {
  const buffer = Buffer.from(content);
  return { originalname: name, mimetype, size: buffer.byteLength, buffer };
}

function createFixture(provider: ImageContentUnderstandingProvider = new FakeImageContentUnderstandingProvider()) {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-attachments-'));
  const persistence = new PersistenceService({ enabled: false });
  const contentStore = new LocalContentStore({ rootDir: root });
  const service = new AttachmentsService(persistence, contentStore, undefined, provider);
  return { service, contentStore, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepts supported image/file bytes and returns stable references', async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.service.upload('session-1', [
      file('diagram.png', 'image/png', 'image-bytes'),
      file('notes.txt', 'text/plain', 'file-bytes')
    ], { batchId: 'draft-1' });

    assert.equal(result.accepted, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.items.length, 2);
    assert.notEqual(fixture.service.getForSession('session-1', result.items[0]!.id).contentRef, undefined);
    assert.equal(fixture.service.list('session-1').length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('rejects unsupported types and per-kind size limits without affecting other files', async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.service.upload('session-1', [
      file('archive.zip', 'application/zip'),
      file('large.png', 'image/png', 'x'.repeat(GROUP_CHAT_IMAGE_MAX_BYTES + 1)),
      file('valid.txt', 'text/plain')
    ]);

    assert.equal(result.accepted, 1);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.items.map((item) => item.uploadStatus), ['failed', 'failed', 'ready']);
  } finally {
    fixture.cleanup();
  }
});

test('enforces four images and four files per draft scope', async () => {
  const fixture = createFixture();
  try {
    const images = await fixture.service.upload('session-1', Array.from({ length: 5 }, (_, index) => file(`${index}.png`, 'image/png')), { batchId: 'draft-1' });
    assert.equal(images.accepted, 4);
    assert.equal(images.failed, 1);

    const files = await fixture.service.upload('session-1', Array.from({ length: 5 }, (_, index) => file(`${index}.txt`, 'text/plain')), { batchId: 'draft-2' });
    assert.equal(files.accepted, 4);
    assert.equal(files.failed, 1);
  } finally {
    fixture.cleanup();
  }
});

test('retries a failed attachment and removes unsent content idempotently', async () => {
  const fixture = createFixture();
  try {
    const failed = await fixture.service.upload('session-1', [file('bad.zip', 'application/zip')], { batchId: 'draft-1' });
    const retried = await fixture.service.retry('session-1', failed.items[0]!.id, file('fixed.pdf', 'application/pdf'));
    assert.equal(retried.uploadStatus, 'ready');
    const stored = fixture.service.getForSession('session-1', retried.id);
    assert.ok(stored.contentRef);
    assert.equal(fixture.contentStore.exists(stored.contentRef!), true);

    await fixture.service.remove('session-1', retried.id);
    assert.equal(fixture.service.list('session-1').length, 0);
    assert.equal(fixture.contentStore.exists(stored.contentRef!), false);
    await fixture.service.remove('session-1', retried.id);
  } finally {
    fixture.cleanup();
  }
});

test('cleans message/group associations and rejects cross-session access', async () => {
  const fixture = createFixture();
  try {
    const message = await fixture.service.upload('session-1', [file('sent.txt', 'text/plain')], { messageId: 'message-1' });
    const draft = await fixture.service.upload('session-1', [file('draft.txt', 'text/plain')], { batchId: 'draft-1' });
    assert.throws(() => fixture.service.getForSession('session-2', message.items[0]!.id), /Attachment not found/);
    await assert.rejects(() => fixture.service.remove('session-1', message.items[0]!.id), /Sent attachments/);
    assert.deepEqual(await fixture.service.removeForMessage('session-1', 'message-1'), [message.items[0]!.id]);
    assert.deepEqual(await fixture.service.removeForMessage('session-1', 'message-1'), []);
    assert.deepEqual(await fixture.service.removeForSession('session-1'), [draft.items[0]!.id]);
    assert.deepEqual(await fixture.service.removeForSession('session-1'), []);
    assert.equal(fixture.service.list('session-1').length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('upload identity guard rejects Agent-originated requests', () => {
  assert.doesNotThrow(() => assertHumanAttachmentUpload('user'));
  assert.throws(() => assertHumanAttachmentUpload('agent', 'agent-1'), /Only a human user/);
});

test('starts image understanding and stores a read-only summary without replacing image bytes', async () => {
  const fixture = createFixture(new FakeImageContentUnderstandingProvider({ summary: 'A simple diagram with two labeled boxes.' }));
  try {
    const result = await fixture.service.upload('session-1', [file('diagram.png', 'image/png', 'image-bytes')], { batchId: 'draft-1' });
    const id = result.items[0]!.id;
    assert.equal(result.items[0]!.recognitionStatus, 'processing');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = fixture.service.getForSession('session-1', id);
    assert.equal(current.recognitionStatus, 'ready');
    assert.equal(current.recognitionSummary, 'A simple diagram with two labeled boxes.');
    assert.equal(fixture.contentStore.read(current.contentRef!).toString(), 'image-bytes');
  } finally {
    fixture.cleanup();
  }
});

test('recognition failure keeps the original image and retry reuses the same attachment ID', async () => {
  const provider = {
    calls: 0,
    async describe() {
      this.calls += 1;
      if (this.calls === 1) throw new Error('provider down');
      return { summary: 'Recovered image description.' };
    }
  };
  const fixture = createFixture(provider);
  try {
    const result = await fixture.service.upload('session-1', [file('diagram.png', 'image/png', 'image-bytes')], { batchId: 'draft-1' });
    const id = result.items[0]!.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = fixture.service.getForSession('session-1', id);
    assert.equal(failed.recognitionStatus, 'failed');
    assert.equal(failed.recognitionErrorCode, 'image_recognition_failed');
    assert.equal(fixture.contentStore.exists(failed.contentRef!), true);

    const retried = await fixture.service.retryRecognition('session-1', id);
    assert.equal(retried.id, id);
    assert.equal(retried.recognitionStatus, 'ready');
    assert.equal(retried.recognitionSummary, 'Recovered image description.');
    assert.equal(provider.calls, 2);
    assert.equal(fixture.service.list('session-1').map((item) => item.id).join(','), id);
  } finally {
    fixture.cleanup();
  }
});

test('resolves file metadata without reading bytes and reads a bounded slice by ID', async () => {
  const fixture = createFixture();
  try {
    const uploaded = await fixture.service.upload('session-1', [file('notes.txt', 'text/plain', '0123456789')], { batchId: 'draft-1' });
    const id = uploaded.items[0]!.id;
    const refs = fixture.service.contextRefsForMessage('session-1', [id]);
    assert.deepEqual(refs[0], uploaded.items[0]);
    const read = fixture.service.readFileById('session-1', id, { offset: 3, maxBytes: 4 });
    assert.equal(read.bytes.toString(), '3456');
    assert.equal(read.offset, 3);
    assert.equal(read.totalBytes, 10);
    assert.equal(read.truncated, true);
    assert.deepEqual(fixture.service.getForSession('session-1', id).sizeBytes, 10);
  } finally {
    fixture.cleanup();
  }
});

test('rejects cross-session and deleted attachment reads without exposing content', async () => {
  const fixture = createFixture();
  try {
    const uploaded = await fixture.service.upload('session-1', [file('notes.txt', 'text/plain', 'private')], { batchId: 'draft-1' });
    const id = uploaded.items[0]!.id;
    assert.throws(() => fixture.service.contextRefsForMessage('session-2', [id]), /Attachment not found/);
    assert.throws(() => fixture.service.readFileById('session-2', id), /Attachment not found/);
    await fixture.service.remove('session-1', id);
    assert.throws(() => fixture.service.readFileById('session-1', id), /Attachment is deleted/);
  } finally {
    fixture.cleanup();
  }
});
