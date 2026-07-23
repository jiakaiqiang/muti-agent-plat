import { createHash } from 'node:crypto';

export type CutoverPostgresQueryResult = {
  rows: Array<{ key: string; value: unknown }>;
};

export type CutoverPostgresClient = {
  query(sql: string, params?: unknown[]): Promise<CutoverPostgresQueryResult>;
  release(): void;
};

export type CutoverPostgresPool = {
  connect(): Promise<CutoverPostgresClient>;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePersistenceRevision(state: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(state)).digest('hex');
}

export async function replacePostgresStateTransaction(input: {
  pool: CutoverPostgresPool;
  tableName: string;
  expectedRevision: string;
  nextState: Record<string, unknown>;
}): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.tableName)) {
    throw new Error(`Invalid PostgreSQL collection table name: ${input.tableName}`);
  }
  const client = await input.pool.connect();
  try {
    await client.query('begin');
    await client.query(`lock table ${input.tableName} in access exclusive mode`);
    const current = await client.query(`select key, value from ${input.tableName} order by key`);
    const currentState = Object.fromEntries(current.rows.map((row) => [row.key, row.value]));
    if (computePersistenceRevision(currentState) !== input.expectedRevision) {
      throw new Error('CUTOVER_STALE_DRY_RUN: persisted state changed after dry-run.');
    }
    await client.query(`delete from ${input.tableName}`);
    for (const [key, value] of Object.entries(input.nextState).sort(([left], [right]) => left.localeCompare(right))) {
      await client.query(
        `insert into ${input.tableName} (key, value, updated_at) values ($1, $2::jsonb, now())`,
        [key, JSON.stringify(value)]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
