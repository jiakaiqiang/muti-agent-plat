import { Injectable, Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type PersistedState = Record<string, unknown>;
type PersistenceBackend = 'file' | 'postgres';

@Injectable()
export class PersistenceService {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly backend: PersistenceBackend;
  private readonly databaseUrl?: string;
  private readonly postgresCollectionTable: string;
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

    if (this.enabled) {
      this.state = this.backend === 'postgres' ? this.readPostgresState() : this.readFileState();
    }
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
      this.writePostgresState();
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
    rmSync(this.filePath, { force: true });
    renameSync(tmpPath, this.filePath);
  }

  private readPostgresState(): PersistedState {
    if (!this.databaseUrl) {
      this.logger.warn('AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres requires DATABASE_URL; using empty state.');
      return {};
    }

    try {
      return this.runPostgresPersistenceScript('read');
    } catch (error) {
      this.logger.warn(`Ignoring unreadable PostgreSQL persistence state: ${String(error)}`);
      return {};
    }
  }

  private writePostgresState() {
    if (!this.databaseUrl) {
      this.logger.warn('AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres requires DATABASE_URL; skipping write.');
      return;
    }

    this.runPostgresPersistenceScript('write', this.state);
  }

  private runPostgresPersistenceScript(action: 'read'): PersistedState;
  private runPostgresPersistenceScript(action: 'write', state: PersistedState): PersistedState;
  private runPostgresPersistenceScript(action: 'read' | 'write', state?: PersistedState): PersistedState {
    const script = `
      const { Client } = require('pg');
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      const action = process.env.AGENT_CLUSTER_PERSISTENCE_ACTION;
      const tableName = process.env.AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE;

      async function main() {
        await client.connect();
        await client.query(\`
          create table if not exists \${tableName} (
            key text primary key,
            value jsonb not null,
            updated_at timestamptz not null default now()
          )
        \`);

        if (action === 'read') {
          const result = await client.query(\`select key, value from \${tableName}\`);
          const state = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
          process.stdout.write(JSON.stringify(state));
          return;
        }

        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const state = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        await client.query('begin');
        try {
          for (const [key, value] of Object.entries(state)) {
            await client.query(
              \`insert into \${tableName} (key, value, updated_at)
               values ($1, $2::jsonb, now())
               on conflict (key) do update set value = excluded.value, updated_at = now()\`,
              [key, JSON.stringify(value)]
            );
          }
          await client.query('commit');
          process.stdout.write(JSON.stringify(state));
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      }

      main()
        .catch((error) => {
          console.error(error instanceof Error ? error.stack : String(error));
          process.exit(1);
        })
        .finally(() => client.end());
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_CLUSTER_PERSISTENCE_ACTION: action,
        AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE: this.postgresCollectionTable
      },
      input: action === 'write' ? JSON.stringify(state ?? {}) : undefined,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return output.trim() ? (JSON.parse(output) as PersistedState) : {};
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
