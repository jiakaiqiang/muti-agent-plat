import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { SystemDataMetadata } from '@agent-cluster/shared';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { computePersistenceRevision } from './postgres-cutover-transaction.js';
import { runPostgresMigrations } from './relational/postgres-migration-runner.js';
import {
  RelationalStateStore,
  type McpObservationRecord,
  type ToolDefinitionRecord,
  type ToolInvocationAuditRecord
} from './relational/relational-state-store.js';
import { ContentReferenceCodec } from './content-reference-codec.js';
import { LocalContentStore } from './local-content-store.js';

type PersistedState = Record<string, unknown>;
export type PersistenceBackend = 'file' | 'postgres';

export type PersistenceServiceOptions = {
  enabled?: boolean;
  backend?: PersistenceBackend;
  databaseUrl?: string;
  postgresCollectionTable?: string;
  filePath?: string;
  maintenanceMode?: boolean;
};

const SYSTEM_DATA_METADATA_COLLECTION = 'systemDataMetadata';

@Injectable()
export class PersistenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly backend: PersistenceBackend;
  private readonly databaseUrl?: string;
  private readonly postgresCollectionTable: string;
  private pool?: Pool;
  private relationalStore?: RelationalStateStore;
  private pendingPostgresWrites = Promise.resolve();
  private pendingPostgresWriteError?: Error;
  private state: PersistedState = {};
  private loadedFromLegacyPostgres = false;
  private maintenanceMode: boolean;
  private readonly ephemeralDataEpoch = randomUUID();

  constructor(options: PersistenceServiceOptions = {}) {
    this.enabled = options.enabled ?? process.env.AGENT_CLUSTER_PERSISTENCE !== 'false';
    this.backend = options.backend ?? (process.env.AGENT_CLUSTER_PERSISTENCE_BACKEND === 'postgres' ? 'postgres' : 'file');
    this.databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    this.postgresCollectionTable = this.safeTableName(
      options.postgresCollectionTable ?? process.env.AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE ?? 'agent_cluster_collections'
    );
    const environmentRoot = process.env.AGENT_CLUSTER_ENV_DIR?.trim();
    const dataDir = process.env.AGENT_CLUSTER_DATA_DIR ?? join(environmentRoot || process.cwd(), '.cache', 'agent-cluster');
    const configuredFile = options.filePath ?? process.env.AGENT_CLUSTER_DATA_FILE?.trim();
    this.filePath = resolve(configuredFile || join(dataDir, 'state.v3.json'));
    this.maintenanceMode =
      options.maintenanceMode ?? (process.env.AGENT_CLUSTER_MAINTENANCE_MODE ?? 'false').trim().toLowerCase() === 'true';
  }

  async initialize() {
    if (!this.enabled) {
      return;
    }

    if (this.backend === 'postgres') {
      await this.initializePostgres();
      this.state = await this.readPostgresState();
      if (this.loadedFromLegacyPostgres && this.relationalStore) {
        await this.relationalStore.replaceState(this.state);
        this.loadedFromLegacyPostgres = false;
      }
      if (!this.state[SYSTEM_DATA_METADATA_COLLECTION] && await this.isEmptyRelationalDatabase() && this.relationalStore) {
        const now = new Date().toISOString();
        const metadata: SystemDataMetadata = {
          dataSchemaVersion: 3,
          dataEpoch: this.ephemeralDataEpoch,
          pipelineVersion: 'v2',
          cutoverAt: now,
          cutoverAuditId: `bootstrap:${randomUUID()}`
        };
        this.state = { ...this.state, [SYSTEM_DATA_METADATA_COLLECTION]: metadata };
        await this.relationalStore.replaceState(this.state);
      }
      return;
    }

    this.state = this.readFileState();
  }

  async onModuleDestroy() {
    await this.pendingPostgresWrites.catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
  }

  getCollection<T>(key: string, fallback: T): T {
    if (!this.enabled) {
      return fallback;
    }
    const value = this.state[key];
    if (value === undefined) {
      return fallback;
    }
    return this.clone(value) as T;
  }

  setCollection<T>(key: string, value: T): Promise<boolean> {
    if (!this.enabled) {
      return Promise.resolve(true);
    }
    this.assertWritable();
    this.state[key] = this.clone(value);
    if (this.backend === 'postgres') {
      return this.writePostgresCollection(key, this.state[key]);
    } else {
      this.writeFileState();
      return Promise.resolve(true);
    }
  }

  async flush(): Promise<void> {
    await this.pendingPostgresWrites;
    const error = this.pendingPostgresWriteError;
    this.pendingPostgresWriteError = undefined;
    if (error) throw error;
  }

  recordToolInvocation(input: ToolInvocationAuditRecord): Promise<boolean> {
    if (!this.enabled || this.backend !== 'postgres') return Promise.resolve(true);
    return this.enqueuePostgresWrite(`tool-invocation:${input.externalId}`, () => {
      if (!this.relationalStore) throw new Error('RELATIONAL_PERSISTENCE_UNAVAILABLE: relational state store is not initialized.');
      return this.relationalStore.writeToolInvocation(input);
    });
  }

  syncToolDefinitions(definitions: ToolDefinitionRecord[]): Promise<boolean> {
    if (!this.enabled || this.backend !== 'postgres') return Promise.resolve(true);
    return this.enqueuePostgresWrite('tool-catalog', () => {
      if (!this.relationalStore) throw new Error('RELATIONAL_PERSISTENCE_UNAVAILABLE: relational state store is not initialized.');
      return this.relationalStore.writeToolDefinitions(definitions);
    });
  }

  recordMcpObservation(input: McpObservationRecord): Promise<boolean> {
    if (!this.enabled || this.backend !== 'postgres') return Promise.resolve(true);
    return this.enqueuePostgresWrite(`mcp:${input.serverExternalId}:${input.providerCallId}`, () => {
      if (!this.relationalStore) throw new Error('RELATIONAL_PERSISTENCE_UNAVAILABLE: relational state store is not initialized.');
      return this.relationalStore.writeMcpObservation(input);
    });
  }

  markEventPublished(eventExternalId: string): Promise<boolean> {
    if (!this.enabled || this.backend !== 'postgres') return Promise.resolve(true);
    return this.enqueuePostgresWrite(`event-published:${eventExternalId}`, () => {
      if (!this.relationalStore) throw new Error('RELATIONAL_PERSISTENCE_UNAVAILABLE: relational state store is not initialized.');
      return this.relationalStore.markEventPublished(eventExternalId);
    });
  }

  backendName(): PersistenceBackend {
    return this.backend;
  }

  dataFilePath(): string {
    return this.filePath;
  }

  locationSummary(): string {
    return this.backend === 'postgres' ? `postgres:public.${this.postgresCollectionTable}` : this.filePath;
  }

  snapshotState(): PersistedState {
    return this.clone(this.state);
  }

  stateRevision(): string {
    return computePersistenceRevision(this.state);
  }

  enterMaintenanceMode(): void {
    this.maintenanceMode = true;
  }

  exitMaintenanceMode(): void {
    this.maintenanceMode = false;
  }

  isInMaintenanceMode(): boolean {
    return this.maintenanceMode;
  }

  assertWritable(): void {
    if (this.maintenanceMode) {
      throw new Error('MAINTENANCE_MODE: persistence writes are disabled.');
    }
  }

  assertCurrentDataReady(): SystemDataMetadata | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const metadata = this.state[SYSTEM_DATA_METADATA_COLLECTION] as Partial<SystemDataMetadata> | undefined;
    if (
      metadata?.dataSchemaVersion !== 3 ||
      metadata.pipelineVersion !== 'v2' ||
      typeof metadata.dataEpoch !== 'string' ||
      !metadata.dataEpoch ||
      typeof metadata.cutoverAt !== 'string' ||
      !metadata.cutoverAt ||
      typeof metadata.cutoverAuditId !== 'string' ||
      !metadata.cutoverAuditId
    ) {
      throw new Error('CUTOVER_REQUIRED: persisted state is not initialized for data schema v3.');
    }
    return this.clone(metadata as SystemDataMetadata);
  }

  currentDataEpoch(): string {
    if (!this.enabled) {
      return this.ephemeralDataEpoch;
    }
    const metadata = this.assertCurrentDataReady();
    if (!metadata) {
      throw new Error('CUTOVER_REQUIRED: current dataEpoch is unavailable.');
    }
    return metadata.dataEpoch;
  }

  async replaceStateForCutover(nextState: PersistedState, expectedRevision: string): Promise<void> {
    if (!this.maintenanceMode) {
      throw new Error('CUTOVER_MAINTENANCE_REQUIRED: enter maintenance mode before apply.');
    }
    await this.pendingPostgresWrites;
    if (this.backend === 'postgres') {
      await this.replacePostgresState(nextState, expectedRevision);
      return;
    }
    if (this.stateRevision() !== expectedRevision) {
      throw new Error('CUTOVER_STALE_DRY_RUN: persisted state changed after dry-run.');
    }
    this.writeFileState(nextState);
    this.state = this.clone(nextState);
  }

  private readFileState(): PersistedState {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedState;
    } catch (error) {
      this.logger.warn(`Ignoring unreadable persistence file ${this.filePath}: ${String(error)}`);
      return {};
    }
  }

  private writeFileState(state: PersistedState = this.state) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      const descriptor = openSync(tmpPath, 'r+');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(tmpPath, this.filePath);
      renamed = true;
    } finally {
      if (!renamed && existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Preserve the original persistence error; a later cleanup can remove this unique temp file.
        }
      }
    }
  }

  private async initializePostgres() {
    if (!this.databaseUrl) {
      throw new Error('POSTGRES_DATABASE_URL_REQUIRED: AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres requires DATABASE_URL.');
    }

    this.pool = new Pool({ connectionString: this.databaseUrl });
    try {
      await runPostgresMigrations(this.pool);
      this.relationalStore = new RelationalStateStore(
        this.pool,
        new ContentReferenceCodec(new LocalContentStore())
      );
      await this.pool.query(`
        create table if not exists public.${this.postgresCollectionTable} (
          key text primary key,
          value jsonb not null,
          updated_at timestamptz not null default now()
        )
      `);
      await this.pool.query(`comment on table public.${this.postgresCollectionTable} is '关系型迁移过渡期的只读旧 collection 兼容表。'`);
      await this.pool.query(`comment on column public.${this.postgresCollectionTable}.key is '旧 JSON collection 的名称，仅用于迁移回退读取。'`);
      await this.pool.query(`comment on column public.${this.postgresCollectionTable}.value is '旧 JSON collection 内容，关系型主流程不再写入。'`);
      await this.pool.query(`comment on column public.${this.postgresCollectionTable}.updated_at is '旧 collection 最后更新时间。'`);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw new Error(`POSTGRES_PERSISTENCE_INITIALIZATION_FAILED: ${String(error)}`, { cause: error });
    }
  }

  private async readPostgresState(): Promise<PersistedState> {
    if (!this.pool) {
      throw new Error('POSTGRES_PERSISTENCE_UNAVAILABLE: PostgreSQL pool is not initialized.');
    }

    try {
      this.loadedFromLegacyPostgres = false;
      const relational = this.relationalStore ? await this.relationalStore.loadState() : {};
      if (await this.relationalStore?.hasBusinessData()) return relational;
      let result = await this.pool.query<{ key: string; value: unknown }>(`select key, value from public.${this.postgresCollectionTable}`);
      if (result.rows.length === 0) {
        const legacySchemaResult = await this.pool.query<{ exists: boolean }>(
          `select to_regclass($1) is not null as exists`,
          [`agent_cluster.${this.postgresCollectionTable}`]
        );
        if (legacySchemaResult.rows[0]?.exists) {
          result = await this.pool.query<{ key: string; value: unknown }>(`select key, value from agent_cluster.${this.postgresCollectionTable}`);
        }
      }
      if (result.rows.length > 0) {
        this.loadedFromLegacyPostgres = true;
        return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
      }
      return relational;
    } catch (error) {
      throw new Error(`POSTGRES_PERSISTENCE_READ_FAILED: ${String(error)}`, { cause: error });
    }
  }

  private writePostgresCollection(key: string, value: unknown): Promise<boolean> {
    if (!this.pool) {
      const error = new Error('POSTGRES_PERSISTENCE_UNAVAILABLE: PostgreSQL persistence is not initialized.');
      this.pendingPostgresWriteError ??= error;
      return Promise.resolve(false);
    }

    return this.enqueuePostgresWrite(key, () => {
      if (!this.relationalStore) throw new Error('RELATIONAL_PERSISTENCE_UNAVAILABLE: relational state store is not initialized.');
      return this.relationalStore.writeCollection(key, value);
    });
  }

  private enqueuePostgresWrite(label: string, operation: () => Promise<unknown>): Promise<boolean> {
    const write = this.pendingPostgresWrites.then(operation);
    const result = write.then(
      () => true,
      (cause: unknown) => {
        const error = new Error(`POSTGRES_PERSISTENCE_WRITE_FAILED: ${label}: ${String(cause)}`, { cause });
        this.logger.error(error.message);
        this.pendingPostgresWriteError ??= error;
        return false;
      }
    );
    this.pendingPostgresWrites = result.then(() => undefined);
    return result;
  }

  private async replacePostgresState(nextState: PersistedState, expectedRevision: string): Promise<void> {
    if (!this.pool || !this.relationalStore) {
      throw new Error('CUTOVER_POSTGRES_UNAVAILABLE: PostgreSQL relational persistence is not initialized.');
    }
    if (this.stateRevision() !== expectedRevision) throw new Error('CUTOVER_STALE_DRY_RUN: persisted state changed after dry-run.');
    await this.relationalStore.replaceState(nextState);
    this.state = this.clone(nextState);
  }

  private safeTableName(value: string) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Invalid PostgreSQL collection table name: ${value}`);
    }
    return value;
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private async isEmptyRelationalDatabase(): Promise<boolean> {
    return this.relationalStore ? !(await this.relationalStore.hasBusinessData()) : false;
  }

}
