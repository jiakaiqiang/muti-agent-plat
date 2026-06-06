import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';

type PersistedState = Record<string, unknown>;
type PersistenceBackend = 'file' | 'postgres';

@Injectable()
export class PersistenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly backend: PersistenceBackend;
  private readonly databaseUrl?: string;
  private readonly postgresCollectionTable: string;
  private pool?: Pool;
  private pendingPostgresWrites = Promise.resolve();
  private state: PersistedState = {};

  constructor() {
    this.enabled = process.env.AGENT_CLUSTER_PERSISTENCE !== 'false';
    this.backend = process.env.AGENT_CLUSTER_PERSISTENCE_BACKEND === 'postgres' ? 'postgres' : 'file';
    this.databaseUrl = process.env.DATABASE_URL;
    this.postgresCollectionTable = this.safeTableName(
      process.env.AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE ?? 'agent_cluster_collections'
    );
    const dataDir = process.env.AGENT_CLUSTER_DATA_DIR ?? join(process.cwd(), '.cache', 'agent-cluster');
    this.filePath = resolve(process.env.AGENT_CLUSTER_DATA_FILE ?? join(dataDir, 'state.v0.1.json'));
  }

  async initialize() {
    if (!this.enabled) {
      return;
    }

    if (this.backend === 'postgres') {
      await this.initializePostgres();
      this.state = await this.readPostgresState();
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

  setCollection<T>(key: string, value: T) {
    if (!this.enabled) {
      return;
    }
    this.state[key] = this.clone(value);
    if (this.backend === 'postgres') {
      this.writePostgresCollection(key, this.state[key]);
    } else {
      this.writeFileState();
    }
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

  private writeFileState() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    try {
      // Atomic replace. Avoids a window where the target file is missing if the
      // process is killed mid-write (libuv renames over an existing file on both
      // POSIX and Windows). This matters now that writes happen in the background.
      renameSync(tmpPath, this.filePath);
    } catch {
      rmSync(this.filePath, { force: true });
      renameSync(tmpPath, this.filePath);
    }
  }

  private async initializePostgres() {
    if (!this.databaseUrl) {
      this.logger.warn('AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres requires DATABASE_URL; using empty state.');
      return;
    }

    this.pool = new Pool({ connectionString: this.databaseUrl });
    try {
      await this.pool.query(`
        create table if not exists ${this.postgresCollectionTable} (
          key text primary key,
          value jsonb not null,
          updated_at timestamptz not null default now()
        )
      `);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      this.logger.warn(`PostgreSQL persistence initialization failed; using empty state: ${String(error)}`);
    }
  }

  private async readPostgresState(): Promise<PersistedState> {
    if (!this.pool) {
      return {};
    }

    try {
      const result = await this.pool.query<{ key: string; value: unknown }>(
        `select key, value from ${this.postgresCollectionTable}`
      );
      return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
    } catch (error) {
      this.logger.warn(`Ignoring unreadable PostgreSQL persistence state: ${String(error)}`);
      return {};
    }
  }

  private writePostgresCollection(key: string, value: unknown) {
    if (!this.pool) {
      this.logger.warn('PostgreSQL persistence is not initialized; skipping write.');
      return;
    }

    this.pendingPostgresWrites = this.pendingPostgresWrites
      .catch(() => undefined)
      .then(() =>
        this.pool?.query(
          `insert into ${this.postgresCollectionTable} (key, value, updated_at)
           values ($1, $2::jsonb, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [key, JSON.stringify(value)]
        )
      )
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn(`PostgreSQL persistence write failed for ${key}: ${String(error)}`);
      });
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
}
