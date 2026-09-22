import { defaultAgents } from '@agent-cluster/shared';
import { pathToFileURL } from 'node:url';
import { defaultCapabilities } from '../capabilities/default-capabilities.js';
import { PersistenceCutoverService } from './persistence-cutover.service.js';
import { PersistenceService } from './persistence.service.js';

export type CutoverCliOptions = {
  mode: 'dry-run' | 'apply';
  environment: string;
  confirmToken?: string;
};

export function parseCutoverCliArgs(argv: string[], env: Record<string, string | undefined>): CutoverCliOptions {
  let dryRun = false;
  let apply = false;
  let confirmToken: string | undefined;
  let environment = env.AGENT_CLUSTER_CUTOVER_ENVIRONMENT ?? env.APP_ENV ?? env.NODE_ENV;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--confirm' || argument === '--environment') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`CUTOVER_ARGUMENT_VALUE_REQUIRED: ${argument} requires a value.`);
      }
      if (argument === '--confirm') {
        confirmToken = value;
      } else {
        environment = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`CUTOVER_ARGUMENT_UNKNOWN: unsupported argument ${argument}.`);
  }

  if (dryRun && apply) {
    throw new Error('CUTOVER_MODE_CONFLICT: choose either --dry-run or --apply.');
  }
  if (!environment?.trim()) {
    throw new Error('CUTOVER_ENVIRONMENT_REQUIRED: provide --environment or APP_ENV.');
  }
  if (apply && !confirmToken) {
    throw new Error('CUTOVER_CONFIRM_TOKEN_REQUIRED: --apply requires --confirm <dry-run-token>.');
  }
  return {
    mode: apply ? 'apply' : 'dry-run',
    environment: environment.trim(),
    ...(confirmToken ? { confirmToken } : {})
  };
}

export function buildV2SeedState(): Record<string, unknown> {
  return {
    agents: defaultAgents,
    capabilities: {
      capabilities: defaultCapabilities,
      approvals: [],
      definitionExtensions: {}
    },
    workflowCatalog: {},
    workflows: [],
    systemAgentRuntimePolicies: {},
    skills: [],
    sessions: [],
    workItemsBySession: {},
    decisionRecordsBySession: {},
    contextSnapshotsBySession: {},
    intentRoutingRecordsBySession: {},
    followUpMessagesBySession: {},
    eventOutbox: [],
    fileRevisions: {},
    eventsBySession: {},
    tasksBySession: {},
    briefsBySession: {},
    suggestedTasksByBriefId: {},
    memoriesBySession: {},
    runtimeInvocationsBySession: {},
    logicalOperationsBySession: {},
    sessionLifecyclesBySession: {},
    sessionStopRequestsBySession: {},
    workItemBudgetsBySession: {},
    summaryCheckpointsBySession: {},
    discussionsBySession: {},
    requirementDocumentsBySession: {},
    discussionDocumentsBySession: {},
    workflowStartRequestsBySession: {},
    changeRequestsBySession: {},
    artifacts: { artifactsById: {}, artifactIdsBySession: {} },
    knowledge: { knowledgeBases: {}, documentsByBase: {}, chunksByBase: {} },
    runtimeModelConfig: {},
    workflowRuntime: {},
    autopilots: [],
    autopilotRuns: [],
    localRuntimeDevices: [],
    localRuntimeOperationAudits: [],
    workspaceSessionLeases: {},
    workspaceWritebacks: []
  };
}

export async function runCutoverCommand(input: {
  argv: string[];
  env: Record<string, string | undefined>;
  persistence?: PersistenceService;
  writeOutput?: (line: string) => void;
}) {
  const options = parseCutoverCliArgs(input.argv, input.env);
  const tokenSecret = input.env.AGENT_CLUSTER_CUTOVER_TOKEN_SECRET;
  if (!tokenSecret) {
    throw new Error('CUTOVER_TOKEN_SECRET_REQUIRED: set AGENT_CLUSTER_CUTOVER_TOKEN_SECRET.');
  }
  const backend = input.env.AGENT_CLUSTER_PERSISTENCE_BACKEND === 'postgres' ? 'postgres' : 'file';
  if (!input.persistence) {
    if (backend === 'file' && !input.env.AGENT_CLUSTER_DATA_FILE?.trim()) {
      throw new Error('CUTOVER_DATA_FILE_REQUIRED: set AGENT_CLUSTER_DATA_FILE to the exact active state file.');
    }
    if (backend === 'postgres' && !input.env.DATABASE_URL?.trim()) {
      throw new Error('CUTOVER_DATABASE_URL_REQUIRED: set DATABASE_URL for the exact active database.');
    }
  }
  const operator = input.env.AGENT_CLUSTER_CUTOVER_OPERATOR?.trim();
  if (options.mode === 'apply' && !operator) {
    throw new Error('CUTOVER_OPERATOR_REQUIRED: set AGENT_CLUSTER_CUTOVER_OPERATOR for apply.');
  }
  if (options.mode === 'apply' && input.env.AGENT_CLUSTER_CUTOVER_QUIESCED?.trim().toLowerCase() !== 'true') {
    throw new Error('CUTOVER_QUIESCED_REQUIRED: confirm all server replicas, runtimes, brokers, and queues are stopped.');
  }
  const persistence = input.persistence ?? new PersistenceService({
    enabled: input.env.AGENT_CLUSTER_PERSISTENCE !== 'false',
    backend,
    databaseUrl: input.env.DATABASE_URL,
    postgresCollectionTable: input.env.AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE,
    filePath: input.env.AGENT_CLUSTER_DATA_FILE,
    maintenanceMode: input.env.AGENT_CLUSTER_MAINTENANCE_MODE?.trim().toLowerCase() === 'true'
  });
  const ownsPersistence = !input.persistence;
  try {
    await persistence.initialize();
    const cutover = new PersistenceCutoverService(persistence, {
      environment: options.environment,
      tokenSecret,
      dataRoot: input.env.AGENT_CLUSTER_DATA_DIR,
      archiveDirectory: input.env.AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR,
      archiveSecret: input.env.AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY,
      operator,
      commit: input.env.AGENT_CLUSTER_COMMIT ?? input.env.GIT_COMMIT ?? input.env.COMMIT_SHA
    });
    const writeOutput = input.writeOutput ?? ((line: string) => process.stdout.write(`${line}\n`));

    if (options.mode === 'dry-run') {
      const report = cutover.dryRun();
      const output = {
        mode: 'dry-run',
        environment: report.environment,
        backend: report.backend,
        persistenceLocation: report.persistenceLocation,
        revision: report.revision,
        collections: report.collections,
        plannedDataEpoch: report.plannedDataEpoch,
        cutoverAuditId: report.cutoverAuditId,
        issuedAt: report.issuedAt,
        confirmToken: report.confirmToken,
        artifactCleanup: report.artifactCleanup,
        archiveDirectory: report.archiveDirectory,
        operationalScope: report.operationalScope,
        relationshipIntegrity: report.relationshipIntegrity
      };
      writeOutput(JSON.stringify(output));
      return output;
    }

    const result = await cutover.apply({
      confirmToken: options.confirmToken!,
      seedState: buildV2SeedState()
    });
    const output = {
      mode: 'apply',
      environment: options.environment,
      backend: persistence.backendName(),
      status: result.status,
      metadata: result.metadata,
      artifactCleanup: result.artifactCleanup,
      archive: result.archive
        ? {
            archiveFile: result.archive.archiveFile,
            manifestFile: result.archive.manifestFile,
            encryptedSha256: result.archive.manifest.encryptedSha256,
            encryptedByteLength: result.archive.manifest.encryptedByteLength
          }
        : undefined
    };
    writeOutput(JSON.stringify(output));
    return output;
  } finally {
    if (ownsPersistence) {
      await persistence.onModuleDestroy();
    }
  }
}

async function main() {
  try {
    await runCutoverCommand({ argv: process.argv.slice(2), env: process.env });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
