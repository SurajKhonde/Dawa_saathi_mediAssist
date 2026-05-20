import { pool, closeDb } from './client';
import { logger } from '@/config/logger';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS medicines (
  id              SERIAL PRIMARY KEY,
  ingredient_key  VARCHAR(64) UNIQUE NOT NULL,
  medicine_name   VARCHAR(255) NOT NULL,
  analysis        JSONB NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medicines_name
  ON medicines (LOWER(medicine_name));

CREATE TABLE IF NOT EXISTS usage_log (
  id                SERIAL PRIMARY KEY,
  telegram_user_id  BIGINT NOT NULL,
  scan_date         DATE NOT NULL,
  scan_count        INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_user_id, scan_date)
);

CREATE INDEX IF NOT EXISTS idx_usage_user_date
  ON usage_log (telegram_user_id, scan_date);

CREATE TABLE IF NOT EXISTS scan_log (
  id                SERIAL PRIMARY KEY,
  telegram_user_id  BIGINT NOT NULL,
  outcome           VARCHAR(32) NOT NULL,
  cache_hit         BOOLEAN NOT NULL DEFAULT FALSE,
  read_confidence   REAL,
  duration_ms       INTEGER,
  medicine_id       INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_log_created
  ON scan_log (created_at DESC);
`;

export async function migrate(): Promise<void> {
  logger.info('Running migrations...');
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    logger.info('Migrations complete');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
