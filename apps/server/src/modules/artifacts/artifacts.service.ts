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

  /** Resolves the best downloadable representation of an artifact: raw file/diff content when present, else its JSON metadata. */
  toDownload(artifact: Artifact): { filename: string; contentType: string; body: string } {
    const metadata = artifact.metadata ?? {};
    const rawContent = typeof metadata.content === 'string' ? (metadata.content as string) : undefined;
    const isJsonLike = artifact.type === 'json' || artifact.type === 'test_report' || artifact.type === 'feishu_draft';
    const body = rawContent ?? JSON.stringify((metadata.output as unknown) ?? metadata, null, 2);
    const path = typeof metadata.path === 'string' ? (metadata.path as string) : undefined;
    const baseName = (path ?? artifact.title ?? artifact.id).split(/[\\/]/).pop() || artifact.id;
    const filename = isJsonLike && !/\.[a-z0-9]+$/i.test(baseName) ? `${baseName}.json` : baseName;
    const contentType = isJsonLike ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    return { filename, contentType, body };
  }

  private persist() {
    this.persistence.setCollection('artifactsBySession', Object.fromEntries(this.artifactsBySession));
  }
}
