import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalContentStore } from './local-content-store.js';

test('LocalContentStore writes content-addressed immutable bytes and verifies the hash on read', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-content-'));
  const store = new LocalContentStore({ rootDir: root });
  const stored = store.put('会话中的大型文件正文', 'text/plain', 'example.txt');

  assert.match(stored.contentRef, /^content:[a-f0-9]{64}$/);
  assert.equal(store.read(stored.contentRef).toString('utf8'), '会话中的大型文件正文');
  assert.deepEqual(store.verify(stored.contentRef), {
    sha256: stored.sha256,
    sizeBytes: Buffer.byteLength('会话中的大型文件正文')
  });
  assert.equal(readFileSync(join(root, stored.storagePath.split('#')[0]), 'utf8'), '会话中的大型文件正文');
});
test('LocalContentStore rejects missing and invalid references explicitly', () => {
  const store = new LocalContentStore({ rootDir: mkdtempSync(join(tmpdir(), 'agent-cluster-content-')) });
  assert.throws(() => store.read('content:not-a-hash'), /CONTENT_REF_INVALID/);
  assert.throws(() => store.read(`content:${'a'.repeat(64)}`), /CONTENT_UNAVAILABLE/);
});

test('LocalContentStore removes a content object idempotently', () => {
  const store = new LocalContentStore({ rootDir: mkdtempSync(join(tmpdir(), 'agent-cluster-content-')) });
  const stored = store.put('retained until its last reference is removed');

  assert.equal(store.remove(stored.contentRef), true);
  assert.equal(store.exists(stored.contentRef), false);
  assert.equal(store.remove(stored.contentRef), false);
  assert.throws(() => store.remove('content:not-a-hash'), /CONTENT_REF_INVALID/);
});
