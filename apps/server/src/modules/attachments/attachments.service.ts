import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  GroupChatAttachmentKind,
  GroupChatAttachmentRef,
  GroupChatAttachmentUploadStatus,
  GroupChatImageRecognitionStatus
} from '@agent-cluster/shared';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { LocalContentStore } from '../persistence/local-content-store.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import {
  ImageContentUnderstandingProvider,
  ImageRecognitionUnsupportedError,
  UnsupportedImageContentUnderstandingProvider
} from './image-recognition.provider.js';

export const GROUP_CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GROUP_CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const GROUP_CHAT_MAX_IMAGES = 4;
export const GROUP_CHAT_MAX_FILES = 4;
export const GROUP_CHAT_MAX_ATTACHMENTS = GROUP_CHAT_MAX_IMAGES + GROUP_CHAT_MAX_FILES;
/** Maximum bytes returned by one on-demand attachment read. */
export const GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES = 32 * 1024;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const FILE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/octet-stream'
]);
const FILE_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt']);

export type AttachmentUploadFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

export type PersistedGroupChatAttachment = GroupChatAttachmentRef & {
  scopeKey: string;
  contentRef?: string;
  sha256?: string;
  storagePath?: string;
  errorCode?: string;
  errorMessage?: string;
  recognitionAttempts?: number;
  recognitionErrorCode?: string;
  recognitionErrorMessage?: string;
  deletedAt?: string;
};

export type AttachmentUploadResult = {
  items: GroupChatAttachmentRef[];
  accepted: number;
  failed: number;
};

export type AttachmentReadResult = {
  attachment: GroupChatAttachmentRef;
  bytes: Buffer;
  offset: number;
  totalBytes: number;
  truncated: boolean;
};

@Injectable()
export class AttachmentsService {
  private readonly attachments: PersistedGroupChatAttachment[];

  constructor(
    private readonly persistence: PersistenceService,
    private readonly contentStore: LocalContentStore,
    private readonly events?: EventsService,
    private readonly recognitionProvider?: ImageContentUnderstandingProvider
  ) {
    this.attachments = this.persistence.getCollection<PersistedGroupChatAttachment[]>('groupChatAttachments', []).map((item) => ({ ...item }));
  }

  async upload(sessionId: string, files: AttachmentUploadFile[], input: { messageId?: string; batchId?: string } = {}) {
    if (!sessionId.trim()) throw new BadRequestException('Session id is required.');
    if (!files.length) throw new BadRequestException('At least one attachment is required.');
    if (files.length > GROUP_CHAT_MAX_ATTACHMENTS) {
      throw new BadRequestException(`A message may contain at most ${GROUP_CHAT_MAX_ATTACHMENTS} attachments.`);
    }

    const scopeKey = this.scopeKey(input.messageId, input.batchId);
    const records: PersistedGroupChatAttachment[] = [];
    for (const file of files) {
      const record = await this.uploadOne(sessionId, scopeKey, file, input.messageId);
      this.attachments.push(record);
      records.push(record);
    }
    const recognitionRecords = records.filter((record) => record.kind === 'image' && record.uploadStatus === 'ready');
    for (const record of recognitionRecords) this.markRecognitionProcessing(record);
    await this.persist();
    for (const record of recognitionRecords) {
      void this.runRecognition(sessionId, record.id, record.recognitionAttempts ?? 1).catch(() => undefined);
    }
    const result = records.map((record) => this.toRef(record));
    return {
      items: result,
      accepted: result.filter((item) => item.uploadStatus === 'ready').length,
      failed: result.filter((item) => item.uploadStatus === 'failed').length
    } satisfies AttachmentUploadResult;
  }

  list(sessionId: string, input: { messageId?: string; batchId?: string } = {}) {
    const scopeKey = input.messageId || input.batchId ? this.scopeKey(input.messageId, input.batchId) : undefined;
    return this.attachments
      .filter((item) => item.sessionId === sessionId && item.uploadStatus !== 'deleted' && (!scopeKey || item.scopeKey === scopeKey))
      .map((item) => this.toRef(item));
  }

  async retry(sessionId: string, attachmentId: string, file: AttachmentUploadFile) {
    const current = this.getForSession(sessionId, attachmentId);
    if (current.uploadStatus !== 'failed') {
      throw new ConflictException('Only a failed attachment can be retried.');
    }
    const replacement = await this.uploadOne(sessionId, current.scopeKey, file, current.messageId, current.id);
    const index = this.attachments.findIndex((item) => item.id === current.id);
    this.attachments[index] = replacement;
    await this.persist();
    return this.toRef(replacement);
  }

  /** Re-runs image understanding without creating a second attachment record. */
  async retryRecognition(sessionId: string, attachmentId: string) {
    const current = this.getForSession(sessionId, attachmentId);
    if (current.kind !== 'image') throw new ConflictException('Only image attachments support recognition retry.');
    if (current.uploadStatus !== 'ready' || !current.contentRef) {
      throw new ConflictException('Only a successfully uploaded image can be recognized.');
    }
    if (current.recognitionStatus === 'processing') return this.toRef(current);
    this.markRecognitionProcessing(current);
    await this.persist();
    return this.runRecognition(sessionId, current.id, current.recognitionAttempts ?? 1);
  }

  async remove(sessionId: string, attachmentId: string) {
    const current = this.getForSession(sessionId, attachmentId);
    if (current.messageId) {
      throw new ConflictException('Sent attachments can only be removed with their message.');
    }
    if (current.uploadStatus === 'deleted') return this.toRef(current);
    current.uploadStatus = 'deleted';
    current.deletedAt = new Date().toISOString();
    await this.removeContentIfUnreferenced(current);
    await this.persist();
    return this.toRef(current);
  }

  /** Idempotent lifecycle hook consumed by the later message/group deletion task. */
  async removeForMessage(sessionId: string, messageId: string) {
    const affected = this.attachments.filter((item) => item.sessionId === sessionId && item.messageId === messageId && item.uploadStatus !== 'deleted');
    for (const item of affected) {
      item.uploadStatus = 'deleted';
      item.deletedAt = new Date().toISOString();
      await this.removeContentIfUnreferenced(item);
    }
    if (affected.length) await this.persist();
    return affected.map((item) => item.id);
  }

  /** Idempotent lifecycle hook consumed by the later group deletion task. */
  async removeForSession(sessionId: string) {
    const affected = this.attachments.filter((item) => item.sessionId === sessionId && item.uploadStatus !== 'deleted');
    for (const item of affected) {
      item.uploadStatus = 'deleted';
      item.deletedAt = new Date().toISOString();
      await this.removeContentIfUnreferenced(item);
    }
    if (affected.length) await this.persist();
    return affected.map((item) => item.id);
  }

  getForSession(sessionId: string, attachmentId: string) {
    const item = this.attachments.find((candidate) => candidate.id === attachmentId && candidate.sessionId === sessionId);
    if (!item) throw new NotFoundException(`Attachment not found: ${attachmentId}`);
    return item;
  }

  /**
   * Resolve the metadata index for a message. This method never reads the
   * content object, so attaching a file to a message cannot accidentally inject
   * its full body into a normal model request.
   */
  contextRefsForMessage(sessionId: string, attachmentIds: readonly string[]): GroupChatAttachmentRef[] {
    const ids = [...new Set(attachmentIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length > GROUP_CHAT_MAX_ATTACHMENTS) {
      throw new BadRequestException(`A message may contain at most ${GROUP_CHAT_MAX_ATTACHMENTS} attachments.`);
    }
    return ids.map((attachmentId) => {
      const item = this.getForSession(sessionId, attachmentId);
      if (item.uploadStatus === 'deleted') {
        throw new NotFoundException(`Attachment is deleted: ${attachmentId}`);
      }
      if (item.uploadStatus !== 'ready' || !item.contentRef) {
        throw new ConflictException(`Attachment is not ready: ${attachmentId}`);
      }
      return this.toRef(item);
    });
  }

  /** Bind successfully sent draft attachments to the durable message id. */
  async associateWithMessage(sessionId: string, messageId: string, attachmentIds: readonly string[]) {
    const refs = this.contextRefsForMessage(sessionId, attachmentIds);
    if (!refs.length) return refs;
    for (const attachmentId of refs.map((item) => item.id)) {
      const item = this.getForSession(sessionId, attachmentId);
      if (item.messageId && item.messageId !== messageId) {
        throw new ConflictException(`Attachment is already bound to message: ${attachmentId}`);
      }
      item.messageId = messageId;
      item.scopeKey = messageId;
    }
    await this.persist();
    return refs.map((item) => ({ ...item, messageId }));
  }

  /**
   * Read a bounded binary slice by stable attachment id. No client-provided
   * filesystem path is accepted and the persisted metadata is never mutated.
   */
  readFileById(
    sessionId: string,
    attachmentId: string,
    input: { offset?: number; maxBytes?: number } = {}
  ): AttachmentReadResult {
    const item = this.getForSession(sessionId, attachmentId);
    if (item.kind !== 'file') throw new ConflictException('Only file attachments can be read by the file tool.');
    if (item.uploadStatus === 'deleted') throw new NotFoundException(`Attachment is deleted: ${attachmentId}`);
    if (item.uploadStatus !== 'ready' || !item.contentRef) {
      throw new ConflictException(`Attachment is not ready: ${attachmentId}`);
    }
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new BadRequestException('offset must be a non-negative integer.');
    const requested = input.maxBytes ?? GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new BadRequestException('maxBytes must be a positive integer.');
    }
    const maxBytes = Math.min(requested, GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES);
    const bytes = this.contentStore.read(item.contentRef);
    const boundedOffset = Math.min(offset, bytes.byteLength);
    const slice = bytes.subarray(boundedOffset, boundedOffset + maxBytes);
    return {
      attachment: this.toRef(item),
      bytes: Buffer.from(slice),
      offset: boundedOffset,
      totalBytes: bytes.byteLength,
      truncated: boundedOffset + slice.byteLength < bytes.byteLength
    };
  }

  private async uploadOne(
    sessionId: string,
    scopeKey: string,
    file: AttachmentUploadFile,
    messageId?: string,
    existingId?: string
  ): Promise<PersistedGroupChatAttachment> {
    const id = existingId ?? randomUUID();
    const now = new Date().toISOString();
    const base = {
      id,
      ...(messageId ? { messageId } : {}),
      sessionId,
      scopeKey,
      fileName: safeFileName(file.originalname),
      mimeType: String(file.mimetype || '').toLowerCase(),
      sizeBytes: Number(file.size ?? file.buffer?.byteLength ?? 0),
      uploadStatus: 'failed' as GroupChatAttachmentUploadStatus,
      createdAt: now
    };

    try {
      const kind = classifyAttachment(file);
      const maxBytes = kind === 'image' ? GROUP_CHAT_IMAGE_MAX_BYTES : GROUP_CHAT_FILE_MAX_BYTES;
      if (base.sizeBytes > maxBytes) throw new AttachmentValidationError('size_exceeded', `Attachment exceeds the ${maxBytes} byte limit.`);
      this.assertCapacity(sessionId, scopeKey, kind, existingId);
      if (!Buffer.isBuffer(file.buffer)) throw new AttachmentValidationError('missing_bytes', 'Attachment bytes are missing.');

      const stored = this.contentStore.put(file.buffer, base.mimeType, base.fileName);
      return {
        ...base,
        kind,
        uploadStatus: 'ready',
        ...(kind === 'image' ? { recognitionStatus: 'not_started' as GroupChatImageRecognitionStatus } : {}),
        contentRef: stored.contentRef,
        sha256: stored.sha256,
        storagePath: stored.storagePath
      };
    } catch (error) {
      const normalized = error instanceof AttachmentValidationError
        ? error
        : new AttachmentValidationError('storage_failed', error instanceof Error ? error.message : String(error));
      return {
        ...base,
        kind: inferKind(file),
        uploadStatus: 'failed',
        ...(inferKind(file) === 'image' ? { recognitionStatus: 'not_started' as GroupChatImageRecognitionStatus } : {}),
        errorCode: normalized.code,
        errorMessage: normalized.message
      };
    }
  }

  private markRecognitionProcessing(record: PersistedGroupChatAttachment) {
    record.recognitionStatus = 'processing';
    record.recognitionAttempts = (record.recognitionAttempts ?? 0) + 1;
    delete record.recognitionSummary;
    delete record.recognitionErrorCode;
    delete record.recognitionErrorMessage;
    this.publishRecognitionEvent('attachment_recognition_started', record);
  }

  private async runRecognition(sessionId: string, attachmentId: string, attempt: number) {
    const record = this.getForSession(sessionId, attachmentId);
    if (record.kind !== 'image' || record.uploadStatus !== 'ready' || !record.contentRef) {
      throw new ConflictException('Image attachment is not available for recognition.');
    }
    if (record.recognitionStatus !== 'processing' || record.recognitionAttempts !== attempt) {
      return this.toRef(record);
    }
    try {
      const result = await (this.recognitionProvider ?? new UnsupportedImageContentUnderstandingProvider()).describe({
        attachmentId: record.id,
        fileName: record.fileName,
        mimeType: record.mimeType,
        bytes: this.contentStore.read(record.contentRef),
        attempt
      });
      const summary = String(result?.summary ?? '').trim();
      if (!summary) throw new Error('image_recognition_empty_summary');
      record.recognitionStatus = 'ready';
      record.recognitionSummary = summary.slice(0, 4_000);
      delete record.recognitionErrorCode;
      delete record.recognitionErrorMessage;
      await this.persist();
      this.publishRecognitionEvent('attachment_recognition_completed', record);
    } catch (error) {
      record.recognitionStatus = 'failed';
      record.recognitionErrorCode = error instanceof ImageRecognitionUnsupportedError
        ? error.code
        : error instanceof Error && error.message === 'image_recognition_empty_summary'
          ? 'image_recognition_empty_summary'
          : 'image_recognition_failed';
      record.recognitionErrorMessage = error instanceof ImageRecognitionUnsupportedError
        ? error.message
        : 'Image content understanding failed; the original image is still available.';
      await this.persist();
      this.publishRecognitionEvent('attachment_recognition_failed', record);
    }
    return this.toRef(record);
  }

  private publishRecognitionEvent(
    type: 'attachment_recognition_started' | 'attachment_recognition_completed' | 'attachment_recognition_failed',
    record: PersistedGroupChatAttachment
  ) {
    this.events?.create({
      sessionId: record.sessionId,
      type,
      actor: { type: 'system', id: 'system' },
      content: type === 'attachment_recognition_started'
        ? `图片 ${record.fileName} 正在进行内容理解。`
        : type === 'attachment_recognition_completed'
          ? `图片 ${record.fileName} 内容理解完成。`
          : `图片 ${record.fileName} 内容理解失败，可重试。`,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'system_notice',
        payload: {
          attachmentId: record.id,
          fileName: record.fileName,
          status: record.recognitionStatus,
          attempt: record.recognitionAttempts ?? 0,
          ...(record.recognitionSummary ? { summary: record.recognitionSummary } : {}),
          ...(record.recognitionErrorCode ? { errorCode: record.recognitionErrorCode } : {})
        }
      }
    });
  }

  private assertCapacity(sessionId: string, scopeKey: string, kind: GroupChatAttachmentKind, replacingId?: string) {
    const current = this.attachments.filter((item) =>
      item.sessionId === sessionId &&
      item.scopeKey === scopeKey &&
      (item.uploadStatus === 'ready' || item.uploadStatus === 'uploading') &&
      item.id !== replacingId
    );
    const imageCount = current.filter((item) => item.kind === 'image').length;
    const fileCount = current.filter((item) => item.kind === 'file').length;
    if (kind === 'image' && imageCount >= GROUP_CHAT_MAX_IMAGES) throw new AttachmentValidationError('too_many_images', 'A message may contain at most 4 images.');
    if (kind === 'file' && fileCount >= GROUP_CHAT_MAX_FILES) throw new AttachmentValidationError('too_many_files', 'A message may contain at most 4 files.');
    if (current.length >= GROUP_CHAT_MAX_ATTACHMENTS) throw new AttachmentValidationError('too_many_attachments', 'A message may contain at most 8 attachments.');
  }

  private scopeKey(messageId?: string, batchId?: string) {
    return messageId?.trim() || `draft:${batchId?.trim() || 'default'}`;
  }

  private toRef(item: PersistedGroupChatAttachment): GroupChatAttachmentRef {
    return {
      id: item.id,
      ...(item.messageId ? { messageId: item.messageId } : {}),
      sessionId: item.sessionId,
      kind: item.kind,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      uploadStatus: item.uploadStatus,
      ...(item.recognitionStatus ? { recognitionStatus: item.recognitionStatus } : {}),
      ...(item.recognitionSummary ? { recognitionSummary: item.recognitionSummary } : {}),
      createdAt: item.createdAt
    };
  }

  private async removeContentIfUnreferenced(item: PersistedGroupChatAttachment) {
    if (!item.contentRef) return;
    const referenced = this.attachments.some((candidate) => candidate.id !== item.id && candidate.contentRef === item.contentRef && candidate.uploadStatus !== 'deleted');
    if (!referenced) this.contentStore.remove(item.contentRef);
  }

  private async persist() {
    await this.persistence.setCollection('groupChatAttachments', this.attachments);
  }
}

export function classifyAttachment(file: Pick<AttachmentUploadFile, 'originalname' | 'mimetype'>): GroupChatAttachmentKind {
  const mime = String(file.mimetype || '').toLowerCase();
  const extension = extname(file.originalname || '').toLowerCase();
  if (IMAGE_MIME_TYPES.has(mime) && (!extension || IMAGE_EXTENSIONS.has(extension))) return 'image';
  if (FILE_MIME_TYPES.has(mime) && FILE_EXTENSIONS.has(extension)) return 'file';
  if (IMAGE_EXTENSIONS.has(extension) && (!mime || IMAGE_MIME_TYPES.has(mime) || mime === 'application/octet-stream')) return 'image';
  if (FILE_EXTENSIONS.has(extension) && (!mime || FILE_MIME_TYPES.has(mime))) return 'file';
  throw new AttachmentValidationError('unsupported_type', `Unsupported attachment type: ${file.originalname || mime || 'unknown'}.`);
}

function inferKind(file: Pick<AttachmentUploadFile, 'originalname' | 'mimetype'>): GroupChatAttachmentKind {
  const extension = extname(file.originalname || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || IMAGE_MIME_TYPES.has(String(file.mimetype || '').toLowerCase()) ? 'image' : 'file';
}

function safeFileName(value: string) {
  const normalized = value.replace(/[\\/\0]/g, '_').trim();
  return normalized || 'unnamed-attachment';
}

export class AttachmentValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

export function assertHumanAttachmentUpload(actorType?: string, agentId?: string) {
  if (agentId?.trim() || (actorType && actorType !== 'user')) {
    throw new ForbiddenException('Only a human user can upload group-chat attachments.');
  }
}
