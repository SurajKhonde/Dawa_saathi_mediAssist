import { Router } from 'express';
import { pool } from '@/db/client';
import { redis } from '@/redis/client';

export const healthRouter = Router();

/**
 * Liveness check - basic "is the process running?" answer.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Readiness check - verifies all dependencies (Postgres, Redis) are reachable.
 * Used by Docker healthcheck and external monitoring.
 */
healthRouter.get('/health/ready', async (_req, res) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  // Postgres
  try {
    await pool.query('SELECT 1');
    checks.postgres = { ok: true };
  } catch (err) {
    checks.postgres = { ok: false, error: (err as Error).message };
  }

  // Redis
  try {
    const pong = await redis.ping();
    checks.redis = { ok: pong === 'PONG' };
  } catch (err) {
    checks.redis = { ok: false, error: (err as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});
