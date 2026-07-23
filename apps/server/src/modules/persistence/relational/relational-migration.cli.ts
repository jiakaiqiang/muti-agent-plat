import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { ContentReferenceCodec } from '../content-reference-codec.js';
import { LocalContentStore } from '../local-content-store.js';
import { runPostgresMigrations } from './postgres-migration-runner.js';
import {
  assertRelationalCollectionsMapped,
  RelationalStateStore,
  type PersistedState
} from './relational-state-store.js';

type Command = 'schema' | 'inventory' | 'dry-run' | 'apply' | 'verify' | 'rollback-export';

export async function runRelationalMigrationCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const command = argv[0] as Command | undefined;
  if (!command || !['schema', 'inventory', 'dry-run', 'apply', 'verify', 'rollback-export'].includes(command)) {
    throw new Error('MIGRATION_COMMAND_REQUIRED: use schema, inventory, dry-run, apply, verify, or rollback-export.');
  }
  const options = parseOptions(argv.slice(1));
  const sourcePath = options.source ? resolve(options.source) : undefined;
  const outputPath = options.output ? resolve(options.output) : undefined;
  const source = sourcePath ? readState(sourcePath) : undefined;

  if (source) {
    assertRelationalCollectionsMapped(source.state);
    assertV3Metadata(source.state);
  }

  if (command === 'inventory' || command === 'dry-run') {
    if (!source) throw new Error('MIGRATION_SOURCE_REQUIRED: pass --source <state.v3.json>.');
    print({ command, sourcePath, sourceSha256: source.sha256, ...inventory(source.state), result: 'ok' });
    return;
  }

  const databaseUrl = options['database-url'] ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL_REQUIRED: pass --database-url or set DATABASE_URL.');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runPostgresMigrations(pool);
    const store = new RelationalStateStore(pool, new ContentReferenceCodec(new LocalContentStore()));

    if (command === 'schema') {
      print({ command, result: 'ok' });
      return;
    }
    if (command === 'apply') {
      if (!source || !sourcePath) throw new Error('MIGRATION_SOURCE_REQUIRED: pass --source <state.v3.json>.');
      if (options.confirm !== 'true') throw new Error('MIGRATION_CONFIRM_REQUIRED: apply requires --confirm.');
      const targetHasBusinessData = await store.hasBusinessData();
      let rollbackExport: { outputPath: string; outputSha256: string } | undefined;
      if (targetHasBusinessData) {
        if (options['allow-non-empty'] !== 'true') {
          throw new Error('MIGRATION_TARGET_NOT_EMPTY: apply refuses a non-empty relational target; use --allow-non-empty with --output <rollback.json>.');
        }
        if (!outputPath) {
          throw new Error('MIGRATION_ROLLBACK_OUTPUT_REQUIRED: non-empty apply requires --output <rollback.json>.');
        }
        const current = await store.loadState();
        writeAtomic(outputPath, `${JSON.stringify(current, null, 2)}\n`);
        rollbackExport = { outputPath, outputSha256: sha256(readFileSync(outputPath)) };
      }
      await store.replaceState(source.state, (loaded) => {
        const comparison = compareState(source.state, loaded);
        if (comparison.mismatchedCollections.length) {
          throw new Error(`MIGRATION_VERIFY_FAILED: ${comparison.mismatchedCollections.join(', ')}`);
        }
      });
      await recordRun(pool, sourcePath, source.sha256, 'apply', inventory(source.state));
      print({ command, sourcePath, sourceSha256: source.sha256, rollbackExport, ...inventory(source.state), result: 'applied-and-verified' });
      return;
    }
    if (command === 'verify') {
      if (!source) throw new Error('MIGRATION_SOURCE_REQUIRED: verify requires --source <state.v3.json>.');
      const loaded = await store.loadState();
      const comparison = compareState(source.state, loaded);
      if (comparison.mismatchedCollections.length) {
        throw new Error(`MIGRATION_VERIFY_FAILED: ${comparison.mismatchedCollections.join(', ')}`);
      }
      print({ command, ...comparison, result: 'verified' });
      return;
    }
    if (command === 'rollback-export') {
      if (!outputPath) throw new Error('MIGRATION_OUTPUT_REQUIRED: rollback-export requires --output <path>.');
      const loaded = await store.loadState();
      writeAtomic(outputPath, `${JSON.stringify(loaded, null, 2)}\n`);
      print({ command, outputPath, outputSha256: sha256(readFileSync(outputPath)), ...inventory(loaded), result: 'exported' });
    }
  } finally {
    await pool.end();
  }
}

function parseOptions(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`MIGRATION_OPTION_INVALID: ${token}`);
    const key = token.slice(2);
    if (key === 'confirm' || key === 'allow-non-empty') result[key] = 'true';
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`MIGRATION_OPTION_VALUE_REQUIRED: ${token}`);
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function readState(path: string): { state: PersistedState; sha256: string } {
  const bytes = readFileSync(path);
  const state = JSON.parse(bytes.toString('utf8')) as PersistedState;
  return { state, sha256: sha256(bytes) };
}

function assertV3Metadata(state: PersistedState): void {
  const metadata = state.systemDataMetadata as Record<string, unknown> | undefined;
  if (metadata?.dataSchemaVersion !== 3 || metadata.pipelineVersion !== 'v2') {
    throw new Error('MIGRATION_SOURCE_NOT_V3: source must be an active schema-v3/context-v2 state file.');
  }
}

function inventory(state: PersistedState) {
  return {
    collections: Object.keys(state).sort(),
    collectionCount: Object.keys(state).length,
    entityCounts: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, entityCount(value)])),
    canonicalSha256ByCollection: Object.fromEntries(
      Object.entries(state).map(([key, value]) => [key, sha256(Buffer.from(canonicalJson(value)))])
    )
  };
}

function compareState(source: PersistedState, loaded: PersistedState) {
  const sourceInventory = inventory(source);
  const loadedInventory = inventory(loaded);
  const keys = Array.from(new Set([...Object.keys(source), ...Object.keys(loaded)])).sort();
  const mismatchedCollections = keys.filter(
    (key) => sourceInventory.canonicalSha256ByCollection[key] !== loadedInventory.canonicalSha256ByCollection[key]
  );
  return { source: sourceInventory, loaded: loadedInventory, mismatchedCollections };
}

function entityCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return value === undefined ? 0 : 1;
  return Object.keys(value as Record<string, unknown>).length;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function recordRun(pool: Pool, sourcePath: string, sourceSha256: string, mode: string, summary: unknown) {
  await pool.query(
    `insert into agent_cluster.migration_runs (external_id,source_path,source_sha256,mode,status,summary,completed_at,created_by)
     values ($1,$2,$3,$4,'completed',$5,now(),$6)`,
    [randomUUID(), sourcePath, sourceSha256, mode, summary, process.env.USERNAME ?? process.env.USER ?? 'unknown']
  );
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  const descriptor = openSync(temporary, 'r+');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void runRelationalMigrationCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
