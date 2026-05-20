import Redis from 'ioredis';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  reconnectOnError: (err) => {
    logger.warn({ err: err.message }, 'Redis reconnect on error');
    return true;
  },
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error({ err: err.message }, 'Redis error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

/**
 * Verify Redis connectivity. Call at startup.
 */
export async function pingRedis(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== 'PONG') {
    throw new Error(`Unexpected Redis response: ${pong}`);
  }
  logger.info('Redis ping OK');
}

/**
 * Graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis disconnected');
}
