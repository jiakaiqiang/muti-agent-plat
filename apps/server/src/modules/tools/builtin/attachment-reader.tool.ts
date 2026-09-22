import { Injectable } from '@nestjs/common';
import { LocalContentStore } from '../../persistence/local-content-store.js';
import { PersistenceService } from '../../persistence/persistence.service.js';
import {
  GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES,
  type PersistedGroupChatAttachment
} from '../../attachments/attachments.service.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';

/** Read a group-chat file by its server-issued attachment id, never by path. */
@Injectable()
export class AttachmentReaderTool implements Tool {
  readonly name = 'read_attachment';
  readonly description = 'Read a bounded binary slice from a group-chat file attachment by stable ID';
  readonly category = 'file' as const;
  readonly riskLevel = 'low' as const;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      attachmentId: {
        type: 'string',
        description: 'Stable attachment ID from the current message context'
      },
      offset: { type: 'integer', minimum: 0, default: 0 },
      maxBytes: { type: 'integer', minimum: 1, maximum: GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES, default: GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES }
    },
    required: ['attachmentId']
  };

  constructor(
    private readonly persistence: PersistenceService,
    private readonly contentStore: LocalContentStore
  ) {}

  async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const input = this.parse(params);
      if (!input.attachmentId) return { success: false, output: null, error: 'attachmentId is required.' };
      const records = this.persistence.getCollection<PersistedGroupChatAttachment[]>('groupChatAttachments', []);
      const item = records.find((candidate) => candidate.id === input.attachmentId && candidate.sessionId === context.sessionId);
      if (!item) return { success: false, output: null, error: 'ATTACHMENT_NOT_FOUND_OR_OUTSIDE_SESSION' };
      if (item.kind !== 'file') return { success: false, output: null, error: 'ATTACHMENT_NOT_A_FILE' };
      if (item.uploadStatus === 'deleted') return { success: false, output: null, error: 'ATTACHMENT_DELETED' };
      if (item.uploadStatus !== 'ready' || !item.contentRef) return { success: false, output: null, error: 'ATTACHMENT_NOT_READY' };
      const bytes = this.contentStore.read(item.contentRef);
      const offset = input.offset ?? 0;
      const maxBytes = Math.min(input.maxBytes ?? GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES, GROUP_CHAT_ATTACHMENT_READ_MAX_BYTES);
      const boundedOffset = Math.min(offset, bytes.byteLength);
      const slice = bytes.subarray(boundedOffset, boundedOffset + maxBytes);
      return {
        success: true,
        output: {
          attachmentId: item.id,
          fileName: item.fileName,
          mimeType: item.mimeType,
          offset: boundedOffset,
          totalBytes: bytes.byteLength,
          truncated: boundedOffset + slice.byteLength < bytes.byteLength,
          bytesBase64: Buffer.from(slice).toString('base64')
        },
        metadata: { attachmentId: item.id, fileName: item.fileName, mimeType: item.mimeType }
      };
    } catch (error) {
      return { success: false, output: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private parse(params: unknown): { attachmentId?: string; offset?: number; maxBytes?: number } {
    if (!params || typeof params !== 'object') return {};
    const value = params as Record<string, unknown>;
    const attachmentId = typeof value.attachmentId === 'string' ? value.attachmentId.trim() : undefined;
    const offset = value.offset === undefined ? undefined : Number(value.offset);
    const maxBytes = value.maxBytes === undefined ? undefined : Number(value.maxBytes);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('offset must be a non-negative integer.');
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error('maxBytes must be a positive integer.');
    return { attachmentId, offset, maxBytes };
  }
}
