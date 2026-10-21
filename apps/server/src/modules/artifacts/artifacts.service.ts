import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  Artifact,
  ArtifactMetadata,
  ArtifactType,
  RuntimeArtifactProposal,
  RuntimeArtifactSystemEvidence,
  UUID
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { appendArtifactInDraft, type ArtifactState } from './artifact-store.js';

type CreateArtifactInput = {
  sessionId: UUID;
  workItemId?: UUID;
  taskId?: UUID;
  agentId?: UUID;
  type: ArtifactType;
  title: string;
  uri?: string;
  contentSummary?: string;
  metadata: ArtifactMetadata;
  runtimeProposals?: RuntimeArtifactProposal[];
  platformProjections?: Artifact['platformProjections'];
  systemEvidence?: RuntimeArtifactSystemEvidence | null;
};

const forbiddenPersistedArtifactFields = ['fileChanges'] as const;
const forbiddenPersistedArtifactMetadataFields = [
  'output',
  'fileChanges',
  'validationEvidence',
  'runtimeProposals',
  'platformProjections',
  'systemEvidence'
] as const;

@Injectable()
export class ArtifactsService {
  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<{
      artifactsById: Record<string, Artifact>;
      artifactIdsBySession: Record<string, string[]>;
    }>('artifacts', { artifactsById: {}, artifactIdsBySession: {} });

    const dataEpoch = this.persistence.currentDataEpoch();
    for (const [artifactId, artifact] of Object.entries(persisted.artifactsById)) {
      if (typeof artifact.dataEpoch !== 'string' || !artifact.dataEpoch) {
        throw new Error(`CUTOVER_REQUIRED: persisted Artifact has no dataEpoch: ${artifactId}`);
      }
      assertCurrentDataEpoch(dataEpoch, artifact.dataEpoch, `Artifact ${artifactId}`);
      if (
        !artifact.metadata ||
        typeof artifact.metadata.phase !== 'string' ||
        !Array.isArray(artifact.runtimeProposals) ||
        !Array.isArray(artifact.platformProjections) ||
        !Object.prototype.hasOwnProperty.call(artifact, 'systemEvidence') ||
        hasOwnField(artifact, forbiddenPersistedArtifactFields) ||
        hasOwnField(artifact.metadata, forbiddenPersistedArtifactMetadataFields)
      ) {
        throw new Error(`CUTOVER_REQUIRED: persisted Artifact does not satisfy the v3 contract: ${artifactId}`);
      }
    }
  }

  async create(input: CreateArtifactInput) {
    const dataEpoch = this.persistence.currentDataEpoch();
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      dataEpoch,
      sessionId: input.sessionId,
      workItemId: input.workItemId,
      taskId: input.taskId,
      agentId: input.agentId,
      type: input.type,
      title: input.title,
      uri: input.uri,
      contentSummary: input.contentSummary,
      metadata: input.metadata,
      runtimeProposals: input.runtimeProposals ?? [],
      platformProjections: input.platformProjections ?? [],
      systemEvidence: input.systemEvidence ?? null,
      createdAt: nowIso()
    };

    return this.persistence.mutateCollections(['artifacts', 'sessions', 'sessionLifecyclesBySession'],
      draft => appendArtifactInDraft(draft, artifact), { sessionIds: [input.sessionId] });
  }

  listBySession(sessionId: string) {
    const state = this.state();
    return (state.artifactIdsBySession[sessionId] ?? [])
      .map((artifactId) => state.artifactsById[artifactId])
      .filter((artifact): artifact is Artifact => artifact !== undefined);
  }

  get(artifactId: string) {
    const artifact = this.state().artifactsById[artifactId];
    if (!artifact) {
      throw new NotFoundException(`Artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  async deleteSession(sessionId: string) {
    await this.persistence.mutateCollections(['artifacts'], draft => {
      const state = draft.artifacts as ArtifactState | undefined;
      if (!state) return;
      for (const artifactId of state.artifactIdsBySession[sessionId] ?? []) delete state.artifactsById[artifactId];
      delete state.artifactIdsBySession[sessionId];
    }, { sessionIds: [sessionId] });
  }

  private state() {
    return this.persistence.getCollection<ArtifactState>('artifacts', { artifactsById: {}, artifactIdsBySession: {} });
  }
}

function hasOwnField(value: object, fields: readonly string[]) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}
