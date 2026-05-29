import { Injectable } from '@nestjs/common';
import type { MemoryItem, MemoryScope, RuntimeMemoryItem, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';

type CreateMemoryInput = {
  sessionId: UUID;
  agentId?: UUID;
  scope?: MemoryScope;
  content: string;
  sourceEventId?: UUID;
  confidence?: number;
};

@Injectable()
export class MemoryService {
  private readonly memoriesBySession = new Map<string, MemoryItem[]>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, MemoryItem[]>>('memoriesBySession', {});
    for (const [sessionId, memories] of Object.entries(persisted)) {
      this.memoriesBySession.set(sessionId, memories);
    }
  }

  create(input: CreateMemoryInput) {
    const now = nowIso();
    const memory: MemoryItem = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      scope: input.scope ?? 'session',
      content: input.content,
      sourceEventId: input.sourceEventId,
      confidence: input.confidence ?? 0.78,
      createdAt: now,
      updatedAt: now
    };
    this.memoriesBySession.set(input.sessionId, [...this.list(input.sessionId), memory]);
    this.persist();
    return memory;
  }

  list(sessionId: string) {
    return this.memoriesBySession.get(sessionId) ?? [];
  }

  search(sessionId: string, query: string, agentId?: string, limit = 6): MemoryItem[] {
    const normalizedQuery = this.normalize(query);
    const tokens = new Set(normalizedQuery.split(/\s+/).filter(Boolean));
    return this.list(sessionId)
      .filter((memory) => !agentId || !memory.agentId || memory.agentId === agentId)
      .map((memory) => ({
        memory,
        score: this.score(this.normalize(memory.content), tokens, normalizedQuery)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.createdAt.localeCompare(left.memory.createdAt))
      .slice(0, limit)
      .map((item) => item.memory);
  }

  toRuntimeMemory(memory: MemoryItem): RuntimeMemoryItem {
    return {
      id: memory.id,
      scope: memory.scope,
      content: memory.content,
      confidence: memory.confidence
    };
  }

  private score(content: string, tokens: Set<string>, normalizedQuery: string) {
    if (!tokens.size) return 0;
    let score = content.includes(normalizedQuery) ? 2 : 0;
    for (const token of tokens) {
      if (token.length > 1 && content.includes(token)) {
        score += 1;
      }
    }
    return score;
  }

  private normalize(value: string) {
    return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  private persist() {
    this.persistence.setCollection('memoriesBySession', Object.fromEntries(this.memoriesBySession));
  }
}
