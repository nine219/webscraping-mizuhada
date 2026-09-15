import { Pool, PoolClient } from 'pg';

if (!process.env.SOCIAL_DATABASE_URL) {
  throw new Error('SOCIAL_DATABASE_URL environment variable is required');
}

export const socialPool = new Pool({
  connectionString: process.env.SOCIAL_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

socialPool.on('error', (err) => {
  console.error('Unexpected social DB pool error:', err);
});

export async function socialQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await socialPool.query(sql, params);
  return rows as T[];
}

export async function socialQueryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await socialQuery<T>(sql, params);
  return rows[0] ?? null;
}

export async function withSocialTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await socialPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback error if connection already dead */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function runSocialCleanup(): Promise<number> {
  const result = await socialPool.query<{ cleanup_social_old_data: number }>(
    'SELECT cleanup_social_old_data()'
  );
  return result.rows[0]?.cleanup_social_old_data ?? 0;
}
