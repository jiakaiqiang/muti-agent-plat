import { Injectable } from '@nestjs/common';
import type { KnowledgeBase, KnowledgeDocument, RagMatchedChunk } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';

type KnowledgeDocumentRecord = KnowledgeDocument & {
  content?: string;
};

type KnowledgeChunkRecord = RagMatchedChunk & {
  normalizedText: string;
};

@Injectable()
export class KnowledgeService {
  private readonly knowledgeBases = new Map<string, KnowledgeBase>();
  private readonly documentsByBase = new Map<string, KnowledgeDocumentRecord[]>();
  private readonly chunksByBase = new Map<string, KnowledgeChunkRecord[]>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<{
      knowledgeBases: Record<string, KnowledgeBase>;
      documentsByBase: Record<string, KnowledgeDocumentRecord[]>;
      chunksByBase: Record<string, KnowledgeChunkRecord[]>;
    }>('knowledge', { knowledgeBases: {}, documentsByBase: {}, chunksByBase: {} });

    for (const [knowledgeBaseId, knowledgeBase] of Object.entries(persisted.knowledgeBases)) {
      this.knowledgeBases.set(knowledgeBaseId, knowledgeBase);
    }
    for (const [knowledgeBaseId, documents] of Object.entries(persisted.documentsByBase)) {
      this.documentsByBase.set(knowledgeBaseId, documents);
    }
    for (const [knowledgeBaseId, chunks] of Object.entries(persisted.chunksByBase)) {
      this.chunksByBase.set(knowledgeBaseId, chunks);
    }
  }

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
    this.persist();
    return kb;
  }

  list() {
    return [...this.knowledgeBases.values()];
  }

  createDocument(
    knowledgeBaseId: string,
    input: { title: string; sourceType: KnowledgeDocument['sourceType']; sourceUri?: string; content?: string }
  ) {
    const now = nowIso();
    const document: KnowledgeDocumentRecord = {
      id: crypto.randomUUID(),
      knowledgeBaseId,
      title: input.title,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri,
      status: 'ready',
      content: input.content,
      createdAt: now,
      updatedAt: now
    };
    this.documentsByBase.set(knowledgeBaseId, [...(this.documentsByBase.get(knowledgeBaseId) ?? []), document]);
    if (input.content?.trim()) {
      this.chunksByBase.set(knowledgeBaseId, [
        ...(this.chunksByBase.get(knowledgeBaseId) ?? []),
        ...this.chunkDocument(document, input.content)
      ]);
    }
    this.persist();
    return document;
  }

  search(knowledgeBaseId: string, query: string): RagMatchedChunk[] {
    const chunks = this.chunksByBase.get(knowledgeBaseId) ?? [];
    if (chunks.length) {
      const terms = this.toTerms(query);
      return chunks
        .map((chunk) => ({
          ...chunk,
          score: this.scoreChunk(chunk.normalizedText, terms)
        }))
        .filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, Number(process.env.RAG_TOP_K ?? 6))
        .map(({ normalizedText, ...chunk }) => chunk);
    }

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

  private chunkDocument(document: KnowledgeDocument, content: string): KnowledgeChunkRecord[] {
    const chunkSize = Number(process.env.RAG_CHUNK_SIZE ?? 900);
    const overlap = Number(process.env.RAG_CHUNK_OVERLAP ?? 120);
    const step = Math.max(1, chunkSize - overlap);
    const chunks: KnowledgeChunkRecord[] = [];

    for (let start = 0; start < content.length; start += step) {
      const snippet = content.slice(start, start + chunkSize).trim();
      if (!snippet) {
        continue;
      }
      chunks.push({
        chunkId: crypto.randomUUID(),
        knowledgeBaseId: document.knowledgeBaseId,
        documentId: document.id,
        title: document.title,
        snippet,
        normalizedText: this.normalize(snippet),
        score: 0
      });
    }

    return chunks;
  }

  private scoreChunk(normalizedText: string, terms: string[]) {
    if (!terms.length) {
      return 0;
    }
    const hits = terms.filter((term) => normalizedText.includes(term)).length;
    return hits / terms.length;
  }

  private toTerms(value: string) {
    return this.normalize(value)
      .split(' ')
      .map((term) => term.trim())
      .filter(Boolean);
  }

  private normalize(value: string) {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  }

  private persist() {
    this.persistence.setCollection('knowledge', {
      knowledgeBases: Object.fromEntries(this.knowledgeBases),
      documentsByBase: Object.fromEntries(this.documentsByBase),
      chunksByBase: Object.fromEntries(this.chunksByBase)
    });
  }
}
