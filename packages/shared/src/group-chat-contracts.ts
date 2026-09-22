import type { ISODateTime, UUID } from './contracts.js';

export const GROUP_CHAT_MAX_IMAGES = 4;
export const GROUP_CHAT_MAX_FILES = 4;
export const GROUP_CHAT_MAX_ATTACHMENTS = GROUP_CHAT_MAX_IMAGES + GROUP_CHAT_MAX_FILES;

export type GroupChatAttachmentKind = 'image' | 'file';

export type GroupChatAttachmentUploadStatus = 'uploading' | 'ready' | 'failed' | 'deleted';

export type GroupChatImageRecognitionStatus = 'not_started' | 'processing' | 'ready' | 'failed';

export type GroupChatAttachmentRef = {
  id: UUID;
  messageId?: UUID;
  sessionId: UUID;
  kind: GroupChatAttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadStatus: GroupChatAttachmentUploadStatus;
  recognitionStatus?: GroupChatImageRecognitionStatus;
  /** Provider-produced, read-only context. It is never an editable user field. */
  recognitionSummary?: string;
  createdAt: ISODateTime;
};

export type GroupChatSkillScope = 'system' | 'group' | 'personal';

export type GroupChatSkillRef = {
  id: UUID;
  key: string;
  name: string;
  revision?: number;
  scope?: GroupChatSkillScope;
  scopeId?: string;
  categoryId?: string;
  status?: 'active' | 'disabled';
};

export type GroupChatAgentRef = {
  id: UUID;
  key?: string;
  name: string;
};

export type GroupChatRoutingMode = 'main' | 'single' | 'distributed';

/** Durable, server-resolved routing state for one composed message. */
export type GroupChatRoutingSnapshot = {
  mode: GroupChatRoutingMode;
  reason: string;
  candidateAgentIds: UUID[];
  distributionAgentIds: UUID[];
  resolvedAgentId?: UUID;
  resolvedAgent?: GroupChatAgentRef;
  skill?: GroupChatSkillRef;
};

/** Draft shape used by the composer before the single-Skill rule is normalized. */
export type GroupChatMessageDraft = {
  text: string;
  skills: readonly GroupChatSkillRef[];
  agents: readonly GroupChatAgentRef[];
  attachments: readonly GroupChatAttachmentRef[];
};

/** Persisted shape used by the message/event pipeline after validation. */
export type GroupChatMessageDirectives = {
  skill?: GroupChatSkillRef;
  agents: readonly GroupChatAgentRef[];
  attachments: readonly GroupChatAttachmentRef[];
};

export type GroupChatMessageContext = {
  text: string;
  directives: GroupChatMessageDirectives;
  /** References only; task execution and summary contents live in their own records. */
  collaboration?: { taskId: UUID; summaryVersion?: number };
};

export type GroupChatMessageValidationCode =
  | 'multiple_skills'
  | 'too_many_images'
  | 'too_many_files'
  | 'too_many_attachments'
  | 'invalid_attachment_status'
  | 'invalid_image_recognition_status';

export type GroupChatMessageValidationError = {
  code: GroupChatMessageValidationCode;
  message: string;
};

export type GroupChatMessageNormalizationResult =
  | { ok: true; value: GroupChatMessageContext }
  | { ok: false; errors: GroupChatMessageValidationError[] };

const validUploadStatuses = new Set<GroupChatAttachmentUploadStatus>([
  'uploading',
  'ready',
  'failed',
  'deleted'
]);

const validRecognitionStatuses = new Set<GroupChatImageRecognitionStatus>([
  'not_started',
  'processing',
  'ready',
  'failed'
]);

/**
 * Normalizes composer state into the persisted message contract.
 * The function is deliberately pure so Web, Desktop and Server can share the
 * same boundary tests without depending on a runtime or a database.
 */
export function normalizeGroupChatMessageDraft(
  draft: GroupChatMessageDraft
): GroupChatMessageNormalizationResult {
  const errors: GroupChatMessageValidationError[] = [];
  const images = draft.attachments.filter((attachment) => attachment.kind === 'image');
  const files = draft.attachments.filter((attachment) => attachment.kind === 'file');

  if (draft.skills.length > 1) {
    errors.push({ code: 'multiple_skills', message: 'A group-chat message may select at most one Skill.' });
  }
  if (images.length > GROUP_CHAT_MAX_IMAGES) {
    errors.push({ code: 'too_many_images', message: `A message may contain at most ${GROUP_CHAT_MAX_IMAGES} images.` });
  }
  if (files.length > GROUP_CHAT_MAX_FILES) {
    errors.push({ code: 'too_many_files', message: `A message may contain at most ${GROUP_CHAT_MAX_FILES} files.` });
  }
  if (draft.attachments.length > GROUP_CHAT_MAX_ATTACHMENTS) {
    errors.push({
      code: 'too_many_attachments',
      message: `A message may contain at most ${GROUP_CHAT_MAX_ATTACHMENTS} attachments.`
    });
  }

  for (const attachment of draft.attachments) {
    if (!validUploadStatuses.has(attachment.uploadStatus)) {
      errors.push({
        code: 'invalid_attachment_status',
        message: `Attachment ${attachment.id} has an invalid upload status.`
      });
    }
    if (
      attachment.kind === 'image' &&
      attachment.recognitionStatus !== undefined &&
      !validRecognitionStatuses.has(attachment.recognitionStatus)
    ) {
      errors.push({
        code: 'invalid_image_recognition_status',
        message: `Image attachment ${attachment.id} has an invalid recognition status.`
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      text: draft.text,
      directives: {
        skill: draft.skills[0],
        agents: [...draft.agents],
        attachments: [...draft.attachments]
      }
    }
  };
}
