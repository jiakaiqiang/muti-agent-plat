import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  DISCUSSION_DOCUMENT_MAX_BYTES,
  DISCUSSION_DOCUMENT_ROLE,
  type CreateDiscussionDocumentInput,
  type DiscussionDocument,
  type DiscussionDocumentPublishedPayload,
  type DiscussionDocumentReadPayload,
  type DiscussionDocumentView,
  type DocumentReadReceipt,
  type SessionDetail,
  type WorkspaceChangeSet
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { EventsService } from '../events/events.service.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import type { PersistedState } from '../persistence/persistence.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { TasksService } from '../tasks/tasks.service.js';

export const DISCUSSION_DOCUMENTS_COLLECTION = 'discussionDocumentsBySession';

type PersistedDiscussionDocument = DiscussionDocument & { readReceipts: DocumentReadReceipt[] };
type DiscussionDocumentsBySession = Record<string, PersistedDiscussionDocument[]>;

type CreateOutcome = {
  document: DiscussionDocument;
  duplicate: boolean;
};

@Injectable()
export class DiscussionDocumentsService {
  private publicationTail = Promise.resolve();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly contentStore: LocalContentStore,
    private readonly workspaceProviders: WorkspaceProviderResolver,
    private readonly artifacts: ArtifactsService,
    private readonly events: EventsService,
    private readonly tasks?: TasksService
  ) {}

  list(sessionId: string): DiscussionDocumentView[] {
    return this.rows(sessionId)
      .map((row) => this.view(row))
      .sort((left, right) => right.revision - left.revision);
  }

  active(sessionId: string): DiscussionDocumentView | undefined {
    const active = this.rows(sessionId)
      .filter((row) => row.status === 'active')
      .sort((left, right) => right.revision - left.revision)[0];
    return active ? this.view(active) : undefined;
  }

  get(sessionId: string, documentId: string): DiscussionDocumentView {
    const row = this.row(sessionId, documentId);
    if (!row) throw new NotFoundException(`Discussion document not found: ${documentId}`);
    return this.view(row);
  }

  content(sessionId: string, documentId: string): { content: string; contentHash: string } {
    const row = this.row(sessionId, documentId);
    if (!row) throw new NotFoundException(`Discussion document not found: ${documentId}`);
    if (row.status === 'failed') throw new ConflictException('DISCUSSION_DOCUMENT_FAILED: the document was not published.');
    const content = this.contentStore.read(row.contentRef).toString('utf8');
    const contentHash = sha256(content);
    if (contentHash !== row.contentHash) {
      throw new ConflictException('DISCUSSION_DOCUMENT_CONTENT_HASH_MISMATCH: stored content is not trustworthy.');
    }
    return { content, contentHash };
  }

  create(session: SessionDetail, input: CreateDiscussionDocumentInput): Promise<DiscussionDocumentView> {
    const operation = this.publicationTail.then(() => this.createInternal(session, input));
    this.publicationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async recordAgentRead(input: {
    sessionId: string;
    documentId: string;
    agentId: string;
    invocationId: string;
    relativePath: string;
    reportedTruncated?: boolean;
  }): Promise<DocumentReadReceipt> {
    const session = this.persistedSession(input.sessionId);
    const document = this.get(session.id, input.documentId);
    const timestamp = nowIso();
    let receipt: DocumentReadReceipt;
    try {
      if (input.reportedTruncated) throw new Error('DOCUMENT_READ_TRUNCATED');
      if (document.status !== 'active') throw new Error('DOCUMENT_SUPERSEDED');
      if (input.relativePath !== document.relativePath) throw new Error('DOCUMENT_PATH_MISMATCH');
      const provider = this.requireProvider(session, false);
      const read = await provider.readFile({ path: document.relativePath, maxBytes: DISCUSSION_DOCUMENT_MAX_BYTES });
      const hash = read.hash?.algorithm === 'sha256' ? read.hash.value : undefined;
      if (read.truncated) throw new Error('DOCUMENT_READ_TRUNCATED');
      if (!hash) throw new Error('DOCUMENT_READ_HASH_MISSING');
      if (hash !== document.contentHash || sha256(read.content) !== document.contentHash) {
        throw new Error('DOCUMENT_READ_HASH_MISMATCH');
      }
      receipt = {
        id: crypto.randomUUID(),
        documentId: document.id,
        sessionId: document.sessionId,
        agentId: input.agentId,
        invocationId: input.invocationId,
        relativePath: document.relativePath,
        contentHash: document.contentHash,
        workspaceRevision: read.revision,
        complete: true,
        truncated: false,
        status: 'completed',
        readAt: timestamp
      };
    } catch (error) {
      const code = errorCode(error);
      receipt = {
        id: crypto.randomUUID(),
        documentId: document.id,
        sessionId: document.sessionId,
        agentId: input.agentId,
        invocationId: input.invocationId,
        relativePath: input.relativePath,
        contentHash: document.contentHash,
        workspaceRevision: document.workspaceRevision ?? { id: 'unavailable', observedAt: timestamp },
        complete: false,
        truncated: code === 'DOCUMENT_READ_TRUNCATED',
        status: 'failed',
        errorCode: code,
        errorMessage: errorMessage(error),
        readAt: timestamp
      };
    }

    const persisted = await this.appendReceipt(receipt);
    const payload: DiscussionDocumentReadPayload = {
      documentId: persisted.documentId,
      agentId: persisted.agentId,
      invocationId: persisted.invocationId,
      contentHash: persisted.contentHash,
      complete: persisted.complete,
      truncated: persisted.truncated,
      status: persisted.status,
      ...(persisted.errorCode ? { errorCode: persisted.errorCode } : {})
    };
    this.events.createOnce(`discussion-document-read:${persisted.id}`, {
      sessionId: persisted.sessionId,
      type: 'discussion_document_read',
      fromAgentId: persisted.agentId,
      content: persisted.status === 'completed' ? '主 Agent 已读取当前方案文档。' : `方案文档读取失败：${persisted.errorCode}`,
      metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload }
    });
    return persisted;
  }

  hasCompleteReceipt(documentId: string, agentId: string, invocationId: string): boolean {
    for (const rows of Object.values(this.all())) {
      const document = rows.find((item) => item.id === documentId);
      if (!document) continue;
      return document.readReceipts.some((item) =>
        item.agentId === agentId && item.invocationId === invocationId && item.status === 'completed' &&
        item.complete && !item.truncated && item.contentHash === document.contentHash
      );
    }
    return false;
  }

  private async createInternal(session: SessionDetail, input: CreateDiscussionDocumentInput): Promise<DiscussionDocumentView> {
    const title = normalizeTitle(input.title);
    const content = normalizeContent(input.content);
    const clientMessageId = input.clientMessageId?.trim();
    if (!clientMessageId || clientMessageId.length > 200) {
      throw new BadRequestException('clientMessageId is required and must not exceed 200 characters.');
    }
    if (input.workItemId && input.workItemId !== session.activeWorkItemId) {
      throw new ConflictException('DISCUSSION_DOCUMENT_STALE_WORK_ITEM: the selected work item is no longer active.');
    }
    const provider = this.requireProvider(session, true);
    const stored = this.contentStore.put(content, 'text/markdown; charset=utf-8', `${title}.md`);
    const hash = stored.sha256;
    const idempotencyKey = sha256(JSON.stringify({
      sessionId: session.id,
      parentDocumentId: input.parentDocumentId ?? null,
      contentHash: hash,
      clientMessageId
    }));
    const reserved = await this.reserve(session, {
      ...input,
      title,
      contentRef: stored.contentRef,
      contentHash: hash,
      sizeBytes: stored.sizeBytes,
      idempotencyKey
    });
    if (reserved.document.status === 'active') return this.get(session.id, reserved.document.id);

    const document = reserved.document;
    try {
      const baseRevision = await provider.getRevision();
      const changeSet: WorkspaceChangeSet = {
        id: `discussion-document:${document.id}`,
        baseRevision,
        changes: [{ operation: 'create', path: document.relativePath, content, encoding: 'utf-8' }],
        createdAt: nowIso()
      };
      const applied = await provider.applyChangeSet(changeSet);
      if (!applied.ok) {
        const existing = await provider.readFile({ path: document.relativePath, maxBytes: DISCUSSION_DOCUMENT_MAX_BYTES });
        if (existing.truncated || existing.hash?.value !== document.contentHash) {
          throw new Error('DISCUSSION_DOCUMENT_WORKSPACE_CONFLICT');
        }
      }
      const read = await provider.readFile({ path: document.relativePath, maxBytes: DISCUSSION_DOCUMENT_MAX_BYTES });
      if (read.truncated || read.byteLength !== document.sizeBytes || read.hash?.value !== document.contentHash || sha256(read.content) !== document.contentHash) {
        throw new Error('DISCUSSION_DOCUMENT_WORKSPACE_HASH_MISMATCH');
      }
      const artifact = this.artifacts.create({
        sessionId: session.id,
        workItemId: document.workItemId,
        type: 'markdown',
        title: document.title,
        uri: document.relativePath,
        contentSummary: `方案文档 v${document.revision}，SHA-256 ${document.contentHash}`,
        metadata: { phase: 'discussion_document', status: 'active' },
        systemEvidence: null
      });
      const active = await this.activate(session.id, document.id, read.revision, artifact.id);
      this.tasks?.markDiscussionDocumentSuperseded(session.id, active);
      const payload: DiscussionDocumentPublishedPayload = {
        documentId: active.id,
        artifactId: artifact.id,
        documentRole: DISCUSSION_DOCUMENT_ROLE,
        revision: active.revision,
        ...(active.parentDocumentId ? { parentDocumentId: active.parentDocumentId } : {}),
        title: active.title,
        relativePath: active.relativePath,
        contentUrl: contentUrl(active),
        uiUrl: uiUrl(active),
        contentHash: active.contentHash,
        sizeBytes: active.sizeBytes,
        readStatus: 'reading'
      };
      this.events.createOnce(`discussion-document-published:${active.id}`, {
        sessionId: active.sessionId,
        workItemId: active.workItemId,
        type: 'discussion_document_published',
        content: `方案文档 v${active.revision} 已写入工作区，主 Agent 正在读取。`,
        metadata: { schemaVersion: '0.1', renderAs: 'discussion_document', title: active.title, payload }
      });
      return this.get(session.id, active.id);
    } catch (error) {
      await this.fail(session.id, document.id, errorCode(error), errorMessage(error));
      throw error instanceof BadRequestException || error instanceof ConflictException
        ? error
        : new ConflictException(`${errorCode(error)}: ${errorMessage(error)}`);
    }
  }

  private async reserve(
    session: SessionDetail,
    input: CreateDiscussionDocumentInput & {
      title: string;
      contentRef: string;
      contentHash: string;
      sizeBytes: number;
      idempotencyKey: string;
    }
  ): Promise<CreateOutcome> {
    return this.persistence.mutateCollections(
      [DISCUSSION_DOCUMENTS_COLLECTION, 'sessions', 'sessionLifecyclesBySession'],
      (draft: PersistedState): CreateOutcome => {
        const sessionExists = ((draft.sessions ?? []) as SessionDetail[]).some((item) =>
          item.id === session.id && item.dataEpoch === session.dataEpoch
        );
        if (!sessionExists) throw new Error('DISCUSSION_DOCUMENT_SESSION_NOT_FOUND');
        const lifecycle = (draft.sessionLifecyclesBySession as Record<string, { state?: string; admission?: string }> | undefined)?.[session.id];
        if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
          throw new Error('DISCUSSION_DOCUMENT_SESSION_CLOSED');
        }
        const all = (draft[DISCUSSION_DOCUMENTS_COLLECTION] ??= {}) as DiscussionDocumentsBySession;
        const rows = (all[session.id] ??= []);
        const duplicate = rows.find((item) =>
          item.idempotencyKey === input.idempotencyKey ||
          (item.parentDocumentId === input.parentDocumentId && item.contentHash === input.contentHash && item.status !== 'failed')
        );
        if (duplicate) return { document: stripReceipts(duplicate), duplicate: true };
        if (input.parentDocumentId && !rows.some((item) => item.id === input.parentDocumentId)) {
          throw new Error('DISCUSSION_DOCUMENT_PARENT_NOT_FOUND');
        }
        const active = rows.find((item) => item.status === 'active');
        if (input.parentDocumentId && active && input.parentDocumentId !== active.id) {
          throw new Error('DISCUSSION_DOCUMENT_STALE_PARENT');
        }
        const revision = Math.max(0, ...rows.map((item) => item.revision)) + 1;
        const timestamp = nowIso();
        const document: PersistedDiscussionDocument = {
          id: crypto.randomUUID(),
          dataEpoch: session.dataEpoch,
          sessionId: session.id,
          ...(input.workItemId ?? session.activeWorkItemId ? { workItemId: input.workItemId ?? session.activeWorkItemId } : {}),
          ...(input.parentDocumentId ? { parentDocumentId: input.parentDocumentId } : {}),
          revision,
          title: input.title,
          relativePath: `.agent-cluster/discussion-documents/${session.id}/plan-revision-${String(revision).padStart(3, '0')}.md`,
          contentRef: input.contentRef,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          status: 'published',
          createdBy: input.createdBy ?? 'user',
          idempotencyKey: input.idempotencyKey,
          createdAt: timestamp,
          updatedAt: timestamp,
          readReceipts: []
        };
        rows.push(document);
        return { document: stripReceipts(document), duplicate: false };
      }
    );
  }

  private async activate(sessionId: string, documentId: string, workspaceRevision: DiscussionDocument['workspaceRevision'], artifactId: string) {
    return this.mutateDocument(sessionId, documentId, (document, rows) => {
      if (document.status === 'active') return stripReceipts(document);
      const timestamp = nowIso();
      for (const candidate of rows) {
        if (candidate.id === document.id || candidate.status !== 'active') continue;
        candidate.status = 'superseded';
        candidate.supersededAt = timestamp;
        candidate.updatedAt = timestamp;
      }
      document.status = 'active';
      document.workspaceRevision = workspaceRevision;
      document.artifactId = artifactId;
      document.updatedAt = timestamp;
      delete document.failureCode;
      delete document.failureMessage;
      return stripReceipts(document);
    });
  }

  private async fail(sessionId: string, documentId: string, code: string, message: string) {
    return this.mutateDocument(sessionId, documentId, (document) => {
      if (document.status === 'active') return stripReceipts(document);
      document.status = 'failed';
      document.failureCode = code;
      document.failureMessage = message;
      document.updatedAt = nowIso();
      return stripReceipts(document);
    });
  }

  private appendReceipt(receipt: DocumentReadReceipt): Promise<DocumentReadReceipt> {
    return this.mutateDocument(receipt.sessionId, receipt.documentId, (document) => {
      const existing = document.readReceipts.find((item) =>
        item.agentId === receipt.agentId && item.invocationId === receipt.invocationId
      );
      if (existing) return structuredClone(existing);
      document.readReceipts.push(structuredClone(receipt));
      document.updatedAt = nowIso();
      return structuredClone(receipt);
    });
  }

  private mutateDocument<T>(
    sessionId: string,
    documentId: string,
    mutation: (document: PersistedDiscussionDocument, rows: PersistedDiscussionDocument[]) => T
  ): Promise<T> {
    return this.persistence.mutateCollections([DISCUSSION_DOCUMENTS_COLLECTION], (draft) => {
      const all = (draft[DISCUSSION_DOCUMENTS_COLLECTION] ??= {}) as DiscussionDocumentsBySession;
      const rows = (all[sessionId] ??= []);
      const document = rows.find((item) => item.id === documentId);
      if (!document) throw new Error('DISCUSSION_DOCUMENT_NOT_FOUND');
      return mutation(document, rows);
    });
  }

  private requireProvider(session: SessionDetail, write: boolean) {
    const provider = this.workspaceProviders.resolve(session);
    if (!provider) throw new BadRequestException('DISCUSSION_DOCUMENT_WORKSPACE_UNAVAILABLE: no Workspace Provider is bound.');
    const capabilities = provider.capabilities();
    if (!capabilities.read || write && !capabilities.write) {
      throw new BadRequestException('DISCUSSION_DOCUMENT_WORKSPACE_PERMISSION_DENIED: read and write access are required.');
    }
    return provider;
  }

  private persistedSession(sessionId: string): SessionDetail {
    const session = this.persistence.getCollection<SessionDetail[]>('sessions', []).find((item) => item.id === sessionId);
    if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
    return session;
  }

  private all(): DiscussionDocumentsBySession {
    return this.persistence.getCollection<DiscussionDocumentsBySession>(DISCUSSION_DOCUMENTS_COLLECTION, {});
  }

  private rows(sessionId: string): PersistedDiscussionDocument[] {
    const rows = this.all()[sessionId] ?? [];
    // A restored Session may have a new dataEpoch. Never surface an active
    // document from a previous epoch after restart/migration; callers then
    // fail closed instead of asking an Agent to read stale workspace content.
    const session = this.persistence.getCollection<SessionDetail[]>('sessions', [])
      .find((item) => item.id === sessionId);
    if (!session) return [];
    return rows.filter((item) => item.dataEpoch === session.dataEpoch);
  }

  private row(sessionId: string, documentId: string): PersistedDiscussionDocument | undefined {
    return this.rows(sessionId).find((item) => item.id === documentId);
  }

  private view(document: PersistedDiscussionDocument): DiscussionDocumentView {
    const latestReadReceipt = [...document.readReceipts].sort((left, right) => right.readAt.localeCompare(left.readAt))[0];
    const base = stripReceipts(document);
    return {
      ...base,
      contentUrl: contentUrl(base),
      uiUrl: uiUrl(base),
      ...(latestReadReceipt ? { latestReadReceipt: structuredClone(latestReadReceipt) } : {})
    };
  }
}

function stripReceipts(document: PersistedDiscussionDocument): DiscussionDocument {
  const { readReceipts: _receipts, ...rest } = document;
  return structuredClone(rest);
}

function normalizeTitle(value: string) {
  const title = value?.trim();
  if (!title) throw new BadRequestException('title is required.');
  if (title.length > 200) throw new BadRequestException('title must not exceed 200 characters.');
  return title;
}

function normalizeContent(value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('content must be non-empty Markdown.');
  if (value.includes('\0')) throw new BadRequestException('DISCUSSION_DOCUMENT_BINARY_UNSUPPORTED: only UTF-8 Markdown is allowed.');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > DISCUSSION_DOCUMENT_MAX_BYTES) {
    throw new BadRequestException(`DISCUSSION_DOCUMENT_TOO_LARGE: maximum size is ${DISCUSSION_DOCUMENT_MAX_BYTES} bytes.`);
  }
  return value.replace(/\r\n/g, '\n');
}

function contentUrl(document: Pick<DiscussionDocument, 'sessionId' | 'id'>) {
  return `/api/sessions/${encodeURIComponent(document.sessionId)}/discussion-documents/${encodeURIComponent(document.id)}/content`;
}

function uiUrl(document: Pick<DiscussionDocument, 'sessionId' | 'id'>) {
  return `/sessions/${encodeURIComponent(document.sessionId)}?document=${encodeURIComponent(document.id)}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown) {
  const message = errorMessage(error);
  const match = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
  return match?.[0] ?? 'DISCUSSION_DOCUMENT_OPERATION_FAILED';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
