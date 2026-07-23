import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContentReferenceCodec } from './content-reference-codec.js';
import { LocalContentStore } from './local-content-store.js';

function fixture() {
  const store = new LocalContentStore({ rootDir: mkdtempSync(join(tmpdir(), 'agent-cluster-codec-')) });
  return { store, codec: new ContentReferenceCodec(store) };
}

test('keeps chat messages inline while externalizing workspace and proposal file bodies', () => {
  const { codec } = fixture();
  const input = {
    event: { eventType: 'agent_message', content: '聊天内容必须完整写入数据库' },
    workspaceSnapshot: {
      files: [{ path: 'src/main.ts', content: 'export const value = 1;', size: 23 }]
    },
    runtimeProposals: [{ metadata: { fileChanges: [{ path: 'src/new.ts', content: 'export const added = true;' }] } }]
  };

  const externalized = codec.externalize(input);
  assert.equal(externalized.value.event.content, input.event.content);
  assert.equal(typeof externalized.value.workspaceSnapshot.files[0].content, 'object');
  assert.equal(typeof externalized.value.runtimeProposals[0].metadata.fileChanges[0].content, 'object');
  assert.equal(externalized.contents.length, 2);
  assert.deepEqual(codec.hydrate(externalized.value), input);
});
test('externalizes test stdout and stderr irrespective of size', () => {
  const { codec } = fixture();
  const input = { verifiedTestResults: [{ stdout: 'passed', stderr: '', command: 'npm test' }] };
  const externalized = codec.externalize(input);
  assert.equal(externalized.contents.length, 2);
  assert.deepEqual(codec.hydrate(externalized.value), input);
});

test('externalizes only large generic raw outputs', () => {
  const previous = process.env.AGENT_CLUSTER_INLINE_OUTPUT_MAX_BYTES;
  process.env.AGENT_CLUSTER_INLINE_OUTPUT_MAX_BYTES = '8';
  try {
    const { codec } = fixture();
    const input = { first: { rawOutput: 'short' }, second: { rawOutput: 'large-output' } };
    const externalized = codec.externalize(input);
    assert.equal(externalized.value.first.rawOutput, 'short');
    assert.equal(typeof externalized.value.second.rawOutput, 'object');
    assert.deepEqual(codec.hydrate(externalized.value), input);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_INLINE_OUTPUT_MAX_BYTES;
    else process.env.AGENT_CLUSTER_INLINE_OUTPUT_MAX_BYTES = previous;
  }
});
