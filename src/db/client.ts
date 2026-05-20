import { Pool } from 'pg';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

export const pool = new Pool({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Postgres pool error');
});

/**
 * Verify DB connectivity. Call at startup.
 */
export async function pingDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    logger.info('Postgres connected');
  } finally {
    client.release();
  }
}

/**
 * Graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  await pool.end();
  logger.info('Postgres pool closed');
}
