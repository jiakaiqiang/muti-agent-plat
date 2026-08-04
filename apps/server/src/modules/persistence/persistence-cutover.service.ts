import type { SystemDataMetadata } from '@agent-cluster/shared';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { PersistenceBackend } from './persistence.service.js';
import { PersistenceService } from './persistence.service.js';
export { assertArtifactPathWithinDataRoot } from './artifact-cutover-cleanup.js';
import { executeArtifactCleanup, planArtifactCleanup } from './artifact-cutover-cleanup.js';
import {
  archiveCutoverState,
  assertArchiveOutsideDataRoot,
  readCutoverArchive,
  type CutoverArchiveResult
} from './cutover-readonly-archive.js';

export const CUTOVER_METADATA_COLLECTION = 'systemDataMetadata';
export const CUTOVER_AUDIT_COLLECTION = 'cutoverAudits';

type CutoverTokenPayload = {
  version: 1;
  environment: string;
  backend: PersistenceBackend;
  revision: string;
  dataEpoch: string;
  cutoverAuditId: string;
  issuedAt: string;
};

export type CutoverInventory = {
  backend: PersistenceBackend;
  revision: string;
  collections: Array<{ key: string; itemCount: number }>;
};

export type CutoverDryRunReport = CutoverInventory & {
  environment: string;
  persistenceLocation: string;
  plannedDataEpoch: string;
  cutoverAuditId: string;
  issuedAt: string;
  confirmToken: string;
  artifactCleanup: {
    deletableCount: number;
    blockedCount: number;
  };
  archiveDirectory: string;
  operationalScope: {
    activeSessionCount: number;
    activeRuntimeInvocationCount: number;
    queuedAutopilotRunCount: number;
    externalQueueObservationRequired: boolean;
  };
  relationshipIntegrity: {
    orphanSessionCollectionKeys: number;
  };
};

export type PersistenceCutoverOptions = {
  environment: string;
  tokenSecret: string;
  now?: () => string;
  randomId?: () => string;
  dataRoot?: string;
  operator?: string;
  commit?: string;
  archiveDirectory?: string;
  archiveSecret?: string;
  executeArtifactCleanup?: typeof executeArtifactCleanup;
};

export type CutoverAudit = {
  auditId: string;
  environment: string;
  operator: string;
  commit: string;
  occurredAt: string;
  backend: PersistenceBackend;
  oldSchemaVersion: number | 'missing';
  newSchemaVersion: 3;
  deletedCollections: Array<{ key: string; itemCount: number }>;
  plannedArtifactDeletionCount: number;
  archiveSha256: string;
  archiveByteLength: number;
  result: 'cleanup_pending' | 'applied';
  dataEpoch: string;
};

export class PersistenceCutoverService {
  private readonly now: () => string;
  private readonly randomId: () => string;
  private readonly artifactCleanup: typeof executeArtifactCleanup;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly options: PersistenceCutoverOptions
  ) {
    if (!options.environment.trim()) {
      throw new Error('CUTOVER_ENVIRONMENT_REQUIRED: provide an explicit environment.');
    }
    if (options.tokenSecret.length < 16) {
      throw new Error('CUTOVER_TOKEN_SECRET_WEAK: token secret must contain at least 16 characters.');
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.artifactCleanup = options.executeArtifactCleanup ?? executeArtifactCleanup;
  }

  inventory(): CutoverInventory {
    const state = this.persistence.snapshotState();
    return {
      backend: this.persistence.backendName(),
      revision: this.persistence.stateRevision(),
      collections: Object.entries(state)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, itemCount: this.itemCount(value) }))
    };
  }

  dryRun(): CutoverDryRunReport {
    this.archiveSecret();
    const state = this.persistence.snapshotState();
    const inventory = this.inventory();
    const artifactPlan = planArtifactCleanup(state, this.dataRoot());
    const payload: CutoverTokenPayload = {
      version: 1,
      environment: this.options.environment,
      backend: inventory.backend,
      revision: inventory.revision,
      dataEpoch: this.randomId(),
      cutoverAuditId: this.randomId(),
      issuedAt: this.now()
    };
    return {
      ...inventory,
      environment: payload.environment,
      persistenceLocation: this.persistence.locationSummary(),
      plannedDataEpoch: payload.dataEpoch,
      cutoverAuditId: payload.cutoverAuditId,
      issuedAt: payload.issuedAt,
      confirmToken: this.sign(payload),
      artifactCleanup: {
        deletableCount: artifactPlan.targets.length,
        blockedCount: artifactPlan.blocked.length
      },
      archiveDirectory: assertArchiveOutsideDataRoot(this.dataRoot(), this.archiveDirectory()),
      operationalScope: this.operationalScope(state),
      relationshipIntegrity: this.relationshipIntegrity(state)
    };
  }

  async apply(input: {
    confirmToken: string;
    seedState?: Record<string, unknown>;
  }): Promise<{
    status: 'applied' | 'already_applied';
    metadata: SystemDataMetadata;
    artifactCleanup: { deletedCount: number; missingCount: number };
    archive?: CutoverArchiveResult;
  }> {
    const payload = this.verify(input.confirmToken);
    if (payload.environment !== this.options.environment) {
      throw new Error('CUTOVER_ENVIRONMENT_MISMATCH: dry-run token belongs to another environment.');
    }
    if (payload.backend !== this.persistence.backendName()) {
      throw new Error('CUTOVER_BACKEND_MISMATCH: dry-run token belongs to another persistence backend.');
    }

    const currentMetadata = this.persistence.snapshotState()[CUTOVER_METADATA_COLLECTION] as
      | SystemDataMetadata
      | undefined;
    if (currentMetadata?.cutoverAuditId === payload.cutoverAuditId) {
      const currentAudit = this.currentAudit(payload.cutoverAuditId);
      if (currentAudit?.result === 'cleanup_pending') {
        const archived = this.readArchive(payload);
        const artifactCleanup = this.artifactCleanup(planArtifactCleanup(archived.state, this.dataRoot()));
        await this.persistAuditResult(payload.cutoverAuditId, 'applied');
        return { status: 'already_applied', metadata: currentMetadata, artifactCleanup, archive: archived.result };
      }
      return {
        status: 'already_applied',
        metadata: currentMetadata,
        artifactCleanup: { deletedCount: 0, missingCount: 0 },
        archive: undefined
      };
    }
    if (!this.persistence.isInMaintenanceMode()) {
      throw new Error('CUTOVER_MAINTENANCE_REQUIRED: enter maintenance mode before apply.');
    }
    if (this.persistence.stateRevision() !== payload.revision) {
      throw new Error('CUTOVER_STALE_DRY_RUN: persisted state changed after dry-run.');
    }

    const currentState = this.persistence.snapshotState();
    const inventory = this.inventory();
    const artifactPlan = planArtifactCleanup(currentState, this.dataRoot());
    if (artifactPlan.blocked.length) {
      throw new Error(`ARTIFACT_CLEANUP_BLOCKED: ${artifactPlan.blocked.length} Artifact path(s) failed validation.`);
    }

    const metadata: SystemDataMetadata = {
      dataSchemaVersion: 3,
      dataEpoch: payload.dataEpoch,
      pipelineVersion: 'v2',
      cutoverAt: this.now(),
      cutoverAuditId: payload.cutoverAuditId
    };
    const seedState = { ...(input.seedState ?? {}) };
    delete seedState[CUTOVER_METADATA_COLLECTION];
    delete seedState[CUTOVER_AUDIT_COLLECTION];
    const previousMetadata = currentState[CUTOVER_METADATA_COLLECTION] as Partial<SystemDataMetadata> | undefined;
    const audit: CutoverAudit = {
      auditId: payload.cutoverAuditId,
      environment: payload.environment,
      operator: this.options.operator?.trim() || 'unknown',
      commit: this.options.commit?.trim() || 'unknown',
      occurredAt: metadata.cutoverAt,
      backend: payload.backend,
      oldSchemaVersion: typeof previousMetadata?.dataSchemaVersion === 'number'
        ? previousMetadata.dataSchemaVersion
        : 'missing',
      newSchemaVersion: 3,
      deletedCollections: inventory.collections,
      plannedArtifactDeletionCount: artifactPlan.targets.length,
      archiveSha256: '',
      archiveByteLength: 0,
      result: 'cleanup_pending',
      dataEpoch: metadata.dataEpoch
    };
    const archive = archiveCutoverState({
      state: currentState,
      sourceRevision: payload.revision,
      dataRoot: this.dataRoot(),
      archiveDirectory: this.archiveDirectory(),
      archiveSecret: this.archiveSecret(),
      archiveId: payload.cutoverAuditId,
      environment: payload.environment,
      createdAt: metadata.cutoverAt,
      collectionCounts: inventory.collections
    });
    audit.archiveSha256 = archive.manifest.encryptedSha256;
    audit.archiveByteLength = archive.manifest.encryptedByteLength;
    const migratedState = buildActiveV2State(seedState);
    await this.persistence.replaceStateForCutover(
      {
        ...migratedState,
        [CUTOVER_METADATA_COLLECTION]: metadata,
        [CUTOVER_AUDIT_COLLECTION]: [audit]
      },
      payload.revision
    );
    const artifactCleanup = this.artifactCleanup(artifactPlan);
    await this.persistAuditResult(payload.cutoverAuditId, 'applied');
    return { status: 'applied', metadata, artifactCleanup, archive };
  }

  private itemCount(value: unknown): number {
    if (Array.isArray(value)) {
      return value.length;
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).length;
    }
    return value === undefined || value === null ? 0 : 1;
  }

  private sign(payload: CutoverTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${this.signature(encoded)}`;
  }

  private verify(token: string): CutoverTokenPayload {
    const [encoded, suppliedSignature, extra] = token.split('.');
    if (!encoded || !suppliedSignature || extra) {
      throw new Error('CUTOVER_TOKEN_INVALID: malformed confirm token.');
    }
    const expectedSignature = this.signature(encoded);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error('CUTOVER_TOKEN_INVALID: confirm token signature is invalid.');
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CutoverTokenPayload;
      if (payload.version !== 1) {
        throw new Error('unsupported token version');
      }
      return payload;
    } catch {
      throw new Error('CUTOVER_TOKEN_INVALID: confirm token payload is invalid.');
    }
  }

  private signature(encodedPayload: string): string {
    return createHmac('sha256', this.options.tokenSecret).update(encodedPayload).digest('base64url');
  }

  private dataRoot(): string {
    return resolve(
      this.options.dataRoot ?? process.env.AGENT_CLUSTER_DATA_DIR ?? dirname(this.persistence.dataFilePath())
    );
  }

  private archiveDirectory(): string {
    const configured = this.options.archiveDirectory ?? process.env.AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR;
    if (!configured?.trim()) {
      throw new Error('CUTOVER_ARCHIVE_DIR_REQUIRED: configure an archive directory outside the active data root.');
    }
    return resolve(configured);
  }

  private archiveSecret(): string {
    const configured = this.options.archiveSecret ?? process.env.AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY;
    if (!configured?.trim()) {
      throw new Error('CUTOVER_ARCHIVE_KEY_REQUIRED: configure a dedicated offline archive key.');
    }
    return configured;
  }

  private readArchive(payload: CutoverTokenPayload) {
    return readCutoverArchive({
      archiveDirectory: this.archiveDirectory(),
      archiveSecret: this.archiveSecret(),
      archiveId: payload.cutoverAuditId,
      environment: payload.environment,
      expectedSourceRevision: payload.revision
    });
  }

  private currentAudit(auditId: string) {
    return this.persistence
      .getCollection<CutoverAudit[]>(CUTOVER_AUDIT_COLLECTION, [])
      .find((audit) => audit.auditId === auditId);
  }

  private async persistAuditResult(auditId: string, result: CutoverAudit['result']) {
    const state = this.persistence.snapshotState();
    const audits = ((state[CUTOVER_AUDIT_COLLECTION] as CutoverAudit[] | undefined) ?? []).map((audit) =>
      audit.auditId === auditId ? { ...audit, result } : audit
    );
    await this.persistence.replaceStateForCutover(
      { ...state, [CUTOVER_AUDIT_COLLECTION]: audits },
      this.persistence.stateRevision()
    );
  }

  private operationalScope(state: Record<string, unknown>) {
    const activeStatuses = new Set([
      'AGENT_DISCUSSING',
      'EXECUTING',
      'REWORKING',
      'WAIT_USER_CONFIRM',
      'WAIT_USER_DECISION',
      'PAUSED'
    ]);
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const invocations = Object.values((state.runtimeInvocationsBySession as Record<string, unknown[]> | undefined) ?? {})
      .flatMap((value) => (Array.isArray(value) ? value : []));
    const autopilotRuns = Array.isArray(state.autopilotRuns) ? state.autopilotRuns : [];
    return {
      activeSessionCount: sessions.filter(
        (value) => value && typeof value === 'object' && activeStatuses.has(String((value as { status?: unknown }).status))
      ).length,
      activeRuntimeInvocationCount: invocations.filter(
        (value) => value && typeof value === 'object' && String((value as { status?: unknown }).status) === 'running'
      ).length,
      queuedAutopilotRunCount: autopilotRuns.filter(
        (value) => value && typeof value === 'object' && ['queued', 'running'].includes(String((value as { status?: unknown }).status))
      ).length,
      externalQueueObservationRequired: true
    };
  }

  private relationshipIntegrity(state: Record<string, unknown>) {
    const sessionIds = new Set(
      (Array.isArray(state.sessions) ? state.sessions : [])
        .map((value) => value && typeof value === 'object' ? String((value as { id?: unknown }).id ?? '') : '')
        .filter(Boolean)
    );
    const sessionCollections = ['eventsBySession', 'tasksBySession', 'briefsBySession', 'memoriesBySession', 'runtimeInvocationsBySession'];
    const orphanSessionCollectionKeys = sessionCollections.reduce((count, key) => {
      const collection = state[key];
      if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return count;
      return count + Object.keys(collection).filter((sessionId) => !sessionIds.has(sessionId)).length;
    }, 0);
    return { orphanSessionCollectionKeys };
  }
}

function buildActiveV2State(seedState: Record<string, unknown>): Record<string, unknown> {
  return { ...seedState };
}
