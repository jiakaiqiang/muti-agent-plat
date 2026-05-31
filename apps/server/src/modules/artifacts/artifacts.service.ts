import { Injectable } from '@nestjs/common';
import type { Artifact } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';

type CreateArtifactInput = {
  sessionId: string;
  taskId?: string;
  agentId?: string;
  type: Artifact['type'];
  title: string;
  uri?: string;
  contentSummary?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class ArtifactsService {
  private readonly artifactsBySession = new Map<string, Artifact[]>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, Artifact[]>>('artifactsBySession', {});
    for (const [sessionId, artifacts] of Object.entries(persisted)) {
      this.artifactsBySession.set(sessionId, artifacts);
    }
  }

  create(input: CreateArtifactInput): Artifact {
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      type: input.type,
      title: input.title,
      uri: input.uri,
      contentSummary: input.contentSummary,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    };
    this.artifactsBySession.set(input.sessionId, [...this.listBySession(input.sessionId), artifact]);
    this.persist();
    return artifact;
  }

  list(sessionId: string) {
    return this.artifactsBySession.get(sessionId) ?? [];
  }

  listBySession(sessionId: string) {
    return this.list(sessionId);
  }

  getById(artifactId: string) {
    for (const artifacts of this.artifactsBySession.values()) {
      const found = artifacts.find((artifact) => artifact.id === artifactId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private persist() {
    this.persistence.setCollection('artifactsBySession', Object.fromEntries(this.artifactsBySession));
  }
}
