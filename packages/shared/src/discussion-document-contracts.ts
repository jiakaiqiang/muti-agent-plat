import type { ActorRef, ISODateTime, UUID, WorkspaceRevision } from './contracts.js';

export const DISCUSSION_DOCUMENT_MAX_BYTES = 200_000;
export const DISCUSSION_DOCUMENT_ROLE = 'discussion_plan' as const;

export type DiscussionDocumentStatus = 'published' | 'active' | 'superseded' | 'failed';
export type DiscussionDocumentCreatedBy = 'user' | 'main_agent' | 'system';
export type DiscussionDocumentReadStatus = 'reading' | 'completed' | 'failed';

export type DiscussionDocument = {
  id: UUID;
  dataEpoch: UUID;
  sessionId: UUID;
  workItemId?: UUID;
  parentDocumentId?: UUID;
  revision: number;
  title: string;
  relativePath: string;
  contentRef: string;
  contentHash: string;
  sizeBytes: number;
  status: DiscussionDocumentStatus;
  createdBy: DiscussionDocumentCreatedBy;
  createdByActor?: ActorRef;
  workspaceRevision?: WorkspaceRevision;
  artifactId?: UUID;
  idempotencyKey: string;
  failureCode?: string;
  failureMessage?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  supersededAt?: ISODateTime;
};

export type DocumentReadReceipt = {
  id: UUID;
  documentId: UUID;
  sessionId: UUID;
  agentId: UUID;
  invocationId: UUID;
  relativePath: string;
  contentHash: string;
  workspaceRevision: WorkspaceRevision;
  complete: boolean;
  truncated: boolean;
  status: DiscussionDocumentReadStatus;
  errorCode?: string;
  errorMessage?: string;
  readAt: ISODateTime;
};

export type DiscussionDocumentPublishedPayload = {
  documentId: UUID;
  artifactId: UUID;
  documentRole: typeof DISCUSSION_DOCUMENT_ROLE;
  revision: number;
  parentDocumentId?: UUID;
  title: string;
  relativePath: string;
  contentUrl: string;
  uiUrl: string;
  contentHash: string;
  sizeBytes: number;
  readStatus: DiscussionDocumentReadStatus;
};

export type DiscussionDocumentReadPayload = {
  documentId: UUID;
  agentId: UUID;
  invocationId: UUID;
  contentHash: string;
  complete: boolean;
  truncated: boolean;
  status: DiscussionDocumentReadStatus;
  errorCode?: string;
};

export type CreateDiscussionDocumentInput = {
  title: string;
  content: string;
  clientMessageId: string;
  parentDocumentId?: UUID;
  workItemId?: UUID;
  createdBy?: DiscussionDocumentCreatedBy;
};

export type DiscussionDocumentView = DiscussionDocument & {
  contentUrl: string;
  uiUrl: string;
  latestReadReceipt?: DocumentReadReceipt;
};

const PUBLISHED_KEYS = new Set([
  'documentId', 'artifactId', 'documentRole', 'revision', 'parentDocumentId', 'title',
  'relativePath', 'contentUrl', 'uiUrl', 'contentHash', 'sizeBytes', 'readStatus'
]);

export function isDiscussionDocumentPublishedPayload(value: unknown): value is DiscussionDocumentPublishedPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !PUBLISHED_KEYS.has(key))) return false;
  return (
    typeof item.documentId === 'string' &&
    typeof item.artifactId === 'string' &&
    item.documentRole === DISCUSSION_DOCUMENT_ROLE &&
    Number.isInteger(item.revision) && Number(item.revision) > 0 &&
    (item.parentDocumentId === undefined || typeof item.parentDocumentId === 'string') &&
    typeof item.title === 'string' && item.title.trim().length > 0 &&
    typeof item.relativePath === 'string' && item.relativePath.endsWith('.md') &&
    typeof item.contentUrl === 'string' && item.contentUrl.startsWith('/api/') &&
    typeof item.uiUrl === 'string' && item.uiUrl.startsWith('/sessions/') &&
    typeof item.contentHash === 'string' && /^[a-f0-9]{64}$/.test(item.contentHash) &&
    Number.isInteger(item.sizeBytes) && Number(item.sizeBytes) >= 0 &&
    ['reading', 'completed', 'failed'].includes(String(item.readStatus))
  );
}

