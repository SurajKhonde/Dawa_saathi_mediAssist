import { redis } from '@/redis/client';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { CACHE_PREFIX } from '@/config/constants';
import { todayKey, secondsUntilMidnight } from '@/utils/normalize';
import {
  incrementDailyScan,
  getDailyScanCount,
} from '@/db/repositories/usage.repository';

/**
 * Rate limit result. If allowed=false, resetAt tells the caller when
 * the user can scan again.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
}

/**
 * Check + reserve a slot for a single scan.
 *
 * This is the function called BEFORE doing the expensive OCR+Claude work.
 * It uses an atomic Redis INCR to reserve the slot quickly. If the user
 * is over quota, we return early without doing Postgres work.
 *
 * Postgres is updated AFTER the scan completes (in `recordSuccessfulScan`)
 * so we have durable analytics even if Redis is wiped.
 *
 * Note: Redis is the authoritative source for live rate limiting. Postgres
 * is for durable history. Slight inconsistency between them is acceptable
 * (e.g., if Redis is flushed, user gets fresh quota — by design).
 */
export async function checkAndReserveScanSlot(
  telegramUserId: number
): Promise<RateLimitResult> {
  const limit = env.FREE_DAILY_SCAN_LIMIT;
  const redisKey = CACHE_PREFIX.RATELIMIT_DAILY + telegramUserId + ':' + todayKey();

  // Atomic increment in Redis. First INCR returns 1 (new key), and we set
  // a TTL until midnight so it auto-expires.
  const newCount = await redis.incr(redisKey);
  if (newCount === 1) {
    await redis.expire(redisKey, secondsUntilMidnight());
  }

  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);

  if (newCount > limit) {
    // Roll back the increment so we don't lock the user out forever if their
    // session keeps trying. The user is rate-limited but the counter caps at limit+1.
    await redis.decr(redisKey).catch(() => {
      /* best effort */
    });
    logger.info(
      { telegramUserId, count: newCount - 1, limit },
      'User rate limited'
    );
    return {
      allowed: false,
      remaining: 0,
      limit,
      resetAt: midnight,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - newCount),
    limit,
    resetAt: midnight,
  };
}

/**
 * After a scan completes successfully, also record it in Postgres for analytics.
 * Best-effort: failure here does NOT affect the user.
 */
export async function recordScanInDb(telegramUserId: number): Promise<void> {
  try {
    await incrementDailyScan(telegramUserId);
  } catch (err) {
    logger.warn(
      { telegramUserId, err: (err as Error).message },
      'Failed to record scan in DB'
    );
  }
}

/**
 * Get current usage for /usage command - reads from Postgres for accuracy.
 */
export async function getCurrentUsage(
  telegramUserId: number
): Promise<{ used: number; limit: number; remaining: number }> {
  const used = await getDailyScanCount(telegramUserId).catch(() => 0);
  const limit = env.FREE_DAILY_SCAN_LIMIT;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Roll back a reservation if the scan failed BEFORE doing any expensive work
 * (e.g., image was too large). Don't punish the user for our rejection.
 */
export async function rollbackScanSlot(telegramUserId: number): Promise<void> {
  const redisKey = CACHE_PREFIX.RATELIMIT_DAILY + telegramUserId + ':' + todayKey();
  await redis.decr(redisKey).catch((err) =>
    logger.warn({ err: err.message, telegramUserId }, 'Rate limit rollback failed')
  );
}
