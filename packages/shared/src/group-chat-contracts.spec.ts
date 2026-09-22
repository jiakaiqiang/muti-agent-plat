import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROUP_CHAT_MAX_ATTACHMENTS,
  GROUP_CHAT_MAX_FILES,
  GROUP_CHAT_MAX_IMAGES,
  normalizeGroupChatMessageDraft,
  type GroupChatAttachmentRef,
  type GroupChatAgentRef,
  type GroupChatSkillRef
} from './group-chat-contracts.js';

const skill: GroupChatSkillRef = { id: 'skill-1', key: 'vision', name: 'Vision' };
const agent: GroupChatAgentRef = { id: 'agent-1', name: 'Reviewer' };

function attachment(
  id: string,
  kind: GroupChatAttachmentRef['kind'],
  overrides: Partial<GroupChatAttachmentRef> = {}
): GroupChatAttachmentRef {
  return {
    id,
    sessionId: 'session-1',
    kind,
    fileName: `${id}.${kind === 'image' ? 'png' : 'txt'}`,
    mimeType: kind === 'image' ? 'image/png' : 'text/plain',
    sizeBytes: 100,
    uploadStatus: 'ready',
    ...(kind === 'image' ? { recognitionStatus: 'ready' as const } : {}),
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides
  };
}

test('normalizes an ordinary message without optional directives', () => {
  const result = normalizeGroupChatMessageDraft({ text: 'hello', skills: [], agents: [], attachments: [] });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.text, 'hello');
    assert.equal(result.value.directives.skill, undefined);
    assert.deepEqual(result.value.directives.agents, []);
    assert.deepEqual(result.value.directives.attachments, []);
  }
});

test('normalizes one Skill, multiple Agent candidates and attachments', () => {
  const result = normalizeGroupChatMessageDraft({
    text: 'inspect these',
    skills: [skill],
    agents: [agent, { id: 'agent-2', name: 'Architect' }],
    attachments: [attachment('image-1', 'image'), attachment('file-1', 'file')]
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.directives.skill, skill);
    assert.equal(result.value.directives.agents.length, 2);
    assert.equal(result.value.directives.attachments.length, 2);
  }
});

test('rejects more than one Skill', () => {
  const result = normalizeGroupChatMessageDraft({
    text: '',
    skills: [skill, { ...skill, id: 'skill-2', key: 'other' }],
    agents: [],
    attachments: []
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors.map((error) => error.code), ['multiple_skills']);
});

test('JSON round-trip preserves text, references, provider summary and future reference metadata', () => {
  const image = { ...attachment('image-1', 'image'), recognitionSummary: '红色折线图', futureMetadata: { revision: 2 } };
  const draft = { text: '/备注 @正文', skills: [skill], agents: [agent], attachments: [image] };
  const result = normalizeGroupChatMessageDraft(draft);
  assert.ok(result.ok);
  const value = { ...result.value, collaboration: { taskId: 'task-1', summaryVersion: 2 } };
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(result.value.directives.attachments[0]?.recognitionSummary, '红色折线图');
  assert.deepEqual(draft.attachments, [image], 'normalization must not mutate the draft');
});

test('preserves every lifecycle state and rejects an invalid image recognition state', () => {
  for (const uploadStatus of ['uploading', 'ready', 'failed', 'deleted'] as const) {
    for (const recognitionStatus of ['not_started', 'processing', 'ready', 'failed'] as const) {
      const result = normalizeGroupChatMessageDraft({ text: '', skills: [], agents: [],
        attachments: [attachment('image-1', 'image', { uploadStatus, recognitionStatus })] });
      assert.ok(result.ok);
      assert.equal(result.value.directives.attachments[0]?.uploadStatus, uploadStatus);
      assert.equal(result.value.directives.attachments[0]?.recognitionStatus, recognitionStatus);
    }
  }
  const invalid = normalizeGroupChatMessageDraft({ text: '', skills: [], agents: [],
    attachments: [attachment('image-1', 'image', { recognitionStatus: 'unknown' as never })] });
  assert.ok(!invalid.ok);
  assert.equal(invalid.errors[0]?.code, 'invalid_image_recognition_status');
});

test('enforces the image, file and total attachment caps', () => {
  const images = Array.from({ length: GROUP_CHAT_MAX_IMAGES + 1 }, (_, index) => attachment(`image-${index}`, 'image'));
  const files = Array.from({ length: GROUP_CHAT_MAX_FILES + 1 }, (_, index) => attachment(`file-${index}`, 'file'));
  const result = normalizeGroupChatMessageDraft({ text: '', skills: [], agents: [], attachments: [...images, ...files] });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.errors.map((error) => error.code), [
      'too_many_images',
      'too_many_files',
      'too_many_attachments'
    ]);
    assert.equal(GROUP_CHAT_MAX_ATTACHMENTS, GROUP_CHAT_MAX_IMAGES + GROUP_CHAT_MAX_FILES);
  }
});

test('rejects invalid attachment state without treating it as ready', () => {
  const result = normalizeGroupChatMessageDraft({
    text: 'use this',
    skills: [],
    agents: [],
    attachments: [attachment('image-1', 'image', { uploadStatus: 'failed', recognitionStatus: 'processing' })]
  });

  assert.equal(result.ok, true, 'failed and processing are valid lifecycle states');

  const invalid = normalizeGroupChatMessageDraft({
    text: 'use this',
    skills: [],
    agents: [],
    attachments: [attachment('image-2', 'image', { uploadStatus: 'unknown' as never })]
  });

  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.errors[0]?.code, 'invalid_attachment_status');
});
