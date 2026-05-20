import { redis } from '@/redis/client';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { CACHE_PREFIX } from '@/config/constants';
import type { MedicineAnalysis, StoredMedicine, VisionExtraction } from '@/types';
import {
  findMedicineByKey,
  upsertMedicine,
  incrementHitCount,
} from '@/db/repositories/medicine.repository';

/**
 * Two-tier cache for medicine analyses, keyed by active-ingredient signature:
 *   Tier 1: Redis (fast, TTL'd)
 *   Tier 2: Postgres (durable)
 */

export async function lookupCachedMedicine(
  ingredientKey: string
): Promise<{ analysis: MedicineAnalysis; source: 'redis' | 'postgres' } | null> {
  const redisKey = CACHE_PREFIX.MEDICINE + ingredientKey;

  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      logger.debug({ ingredientKey }, 'Cache HIT (redis)');
      return { analysis: JSON.parse(cached) as MedicineAnalysis, source: 'redis' };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Redis lookup failed, falling through');
  }

  const stored = await findMedicineByKey(ingredientKey);
  if (stored) {
    logger.debug({ ingredientKey, medicineId: stored.id }, 'Cache HIT (postgres)');
    redis
      .setex(redisKey, env.MEDICINE_CACHE_TTL_SECONDS, JSON.stringify(stored.analysis))
      .catch((err) => logger.warn({ err: err.message }, 'Redis backfill failed'));
    incrementHitCount(stored.id).catch(() => {});
    return { analysis: stored.analysis, source: 'postgres' };
  }

  logger.debug({ ingredientKey }, 'Cache MISS');
  return null;
}

export async function storeMedicine(args: {
  ingredientKey: string;
  medicineName: string;
  analysis: MedicineAnalysis;
}): Promise<StoredMedicine> {
  const { ingredientKey, medicineName, analysis } = args;

  const stored = await upsertMedicine({ ingredientKey, medicineName, analysis });

  try {
    await redis.setex(
      CACHE_PREFIX.MEDICINE + ingredientKey,
      env.MEDICINE_CACHE_TTL_SECONDS,
      JSON.stringify(analysis)
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Redis write failed (postgres has data)');
  }

  return stored;
}

// ---- Pending extraction storage (for the "ask purpose" flow) ----
// Between reading the photo and the user telling us WHY they take the medicine,
// we hold the extraction in Redis keyed by chatId with a short TTL.

const PENDING_PREFIX = 'pending:v1:';
const PENDING_TTL_SECONDS = 600; // 10 minutes to answer the purpose question

/** Save a mid-flow extraction while we wait for the user's stated purpose. */
export async function savePendingExtraction(
  chatId: number,
  extraction: VisionExtraction
): Promise<void> {
  await redis.setex(
    PENDING_PREFIX + chatId,
    PENDING_TTL_SECONDS,
    JSON.stringify(extraction)
  );
}

/** Retrieve + delete the pending extraction for a user. Null if none/expired. */
export async function takePendingExtraction(
  chatId: number
): Promise<VisionExtraction | null> {
  const key = PENDING_PREFIX + chatId;
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  try {
    return JSON.parse(raw) as VisionExtraction;
  } catch {
    return null;
  }
}
