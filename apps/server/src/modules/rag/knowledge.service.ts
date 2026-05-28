import { Injectable } from '@nestjs/common';
import type { KnowledgeBase, KnowledgeDocument, RagMatchedChunk } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

@Injectable()
export class KnowledgeService {
  private readonly knowledgeBases = new Map<string, KnowledgeBase>();
  private readonly documentsByBase = new Map<string, KnowledgeDocument[]>();

  createBase(input: Partial<KnowledgeBase> & { name: string; scope: KnowledgeBase['scope'] }) {
    const now = nowIso();
    const kb: KnowledgeBase = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      scope: input.scope,
      ownerId: input.ownerId ?? 'local-user',
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      roleType: input.roleType,
      visibility: input.visibility ?? 'private',
      embeddingModel: input.embeddingModel ?? 'mock-embedding',
      createdAt: now,
      updatedAt: now
    };
    this.knowledgeBases.set(kb.id, kb);
    return kb;
  }

  list() {
    return [...this.knowledgeBases.values()];
  }

  createDocument(knowledgeBaseId: string, input: { title: string; sourceType: KnowledgeDocument['sourceType']; sourceUri?: string }) {
    const now = nowIso();
    const document: KnowledgeDocument = {
      id: crypto.randomUUID(),
      knowledgeBaseId,
      title: input.title,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri,
      status: 'ready',
      createdAt: now,
      updatedAt: now
    };
    this.documentsByBase.set(knowledgeBaseId, [...(this.documentsByBase.get(knowledgeBaseId) ?? []), document]);
    return document;
  }

  search(knowledgeBaseId: string, query: string): RagMatchedChunk[] {
    const document = this.documentsByBase.get(knowledgeBaseId)?.[0];
    return [
      {
        chunkId: crypto.randomUUID(),
        knowledgeBaseId,
        documentId: document?.id ?? crypto.randomUUID(),
        title: document?.title ?? 'Mock RAG Knowledge',
        snippet: `Mock knowledge matched for: ${query}`,
        score: 0.91
      }
    ];
  }
}
