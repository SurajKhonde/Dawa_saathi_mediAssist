import { env } from '@/config/env';
import { logger, type Logger } from '@/config/logger';
import { DEFAULT_LANG, type LangCode } from '@/config/languages';
import type { PipelineResult, MedicineAnalysis, VisionExtraction } from '@/types';
import { ingredientKey } from '@/utils/normalize';
import { extractMedicineFromImage } from './vision.service';
import { enrichWithFda } from './fda.service';
import { generateAwareness } from './awareness.service';
import { lookupCachedMedicine, storeMedicine } from './cache.service';
import {
  checkAndReserveScanSlot,
  rollbackScanSlot,
  recordScanInDb,
} from './ratelimit.service';
import { logScan } from '@/db/repositories/usage.repository';

/**
 * Full medicine pipeline with safety-first design.
 *
 * Stages:
 *   1. Rate limit reserve (Redis)
 *   2. Size check
 *   3. Vision extraction (Claude reads the label — NEVER guesses)
 *   4. GATE: not a medicine?            -> ask for medicine photo, refund quota
 *   5. GATE: confidence < threshold?    -> ask for clearer photo, refund quota
 *   6. Cache lookup by ingredient
 *   7. openFDA verify + enrich ingredient (optional, resilient)
 *   8. Awareness generation (Claude)
 *   9. Cache write
 *
 * KEY SAFETY PROPERTY: if we are not confident we read the medicine correctly,
 * we DO NOT produce an answer and we DO NOT consume the user's scan quota.
 */
export async function runMedicinePipeline(args: {
  telegramUserId: number;
  imageBuffer: Buffer;
  reqLogger: Logger;
}): Promise<PipelineResult> {
  const { telegramUserId, imageBuffer, reqLogger } = args;
  const startedAt = Date.now();

  // ---- 1. Rate limit ----
  const rl = await checkAndReserveScanSlot(telegramUserId);
  if (!rl.allowed) {
    return { kind: 'rate_limited', resetAt: rl.resetAt };
  }

  try {
    // ---- 2. Size check ----
    if (imageBuffer.length > env.MAX_IMAGE_BYTES) {
      await rollbackScanSlot(telegramUserId);
      return {
        kind: 'image_too_large',
        sizeBytes: imageBuffer.length,
        maxBytes: env.MAX_IMAGE_BYTES,
      };
    }

    // ---- 3. Vision extraction ----
    let extraction;
    try {
      extraction = await extractMedicineFromImage(imageBuffer);
    } catch (err) {
      await rollbackScanSlot(telegramUserId);
      reqLogger.error({ err: (err as Error).message }, 'Vision extraction threw');
      logScan({
        telegramUserId,
        outcome: 'extraction_error',
        cacheHit: false,
        durationMs: Date.now() - startedAt,
      });
      return { kind: 'extraction_failed', reason: 'Could not read the image' };
    }

    // ---- 4. GATE: not a medicine ----
    if (!extraction.isMedicine) {
      await rollbackScanSlot(telegramUserId);
      reqLogger.info('Image is not a medicine');
      logScan({
        telegramUserId,
        outcome: 'not_a_medicine',
        cacheHit: false,
        readConfidence: extraction.readConfidence,
        durationMs: Date.now() - startedAt,
      });
      return { kind: 'not_a_medicine' };
    }

    // ---- 5. GATE: confidence threshold (THE CRITICAL SAFETY CHECK) ----
    if (
      extraction.readConfidence < env.EXTRACTION_CONFIDENCE_THRESHOLD ||
      extraction.medicineName.toLowerCase() === 'unknown' ||
      extraction.activeIngredients.length === 0
    ) {
      // Not confident we read it right. Refuse to guess. Refund quota.
      await rollbackScanSlot(telegramUserId);
      reqLogger.warn(
        {
          readConfidence: extraction.readConfidence,
          threshold: env.EXTRACTION_CONFIDENCE_THRESHOLD,
          reason: extraction.uncertaintyReason,
        },
        'Below confidence threshold; asking for clearer photo (no quota used)'
      );
      logScan({
        telegramUserId,
        outcome: 'low_confidence',
        cacheHit: false,
        readConfidence: extraction.readConfidence,
        durationMs: Date.now() - startedAt,
      });
      return {
        kind: 'low_confidence',
        reason: extraction.uncertaintyReason,
        readConfidence: extraction.readConfidence,
      };
    }

    reqLogger.info(
      {
        medicine: extraction.medicineName,
        ingredients: extraction.activeIngredients.map((i) => i.name),
        confidence: extraction.readConfidence,
      },
      'Extraction passed confidence gate'
    );

    // Extraction succeeded — this counts as a used scan.
    await recordScanInDb(telegramUserId);
    logScan({
      telegramUserId,
      outcome: 'extraction_ok',
      cacheHit: false,
      readConfidence: extraction.readConfidence,
      durationMs: Date.now() - startedAt,
    });

    // We STOP here and hand the extraction back to the handler, which asks the
    // user WHY they take the medicine before generating tailored awareness.
    return { kind: 'extracted', extraction };
  } catch (err) {
    await rollbackScanSlot(telegramUserId).catch(() => {});
    logger.error({ err: (err as Error).message }, 'Pipeline crashed');
    throw err;
  }
}

/**
 * STAGE 2 (called after the user states their purpose).
 *
 * Cache lookup (purpose-aware) -> openFDA enrich -> awareness generation -> store.
 * Quota was already consumed at extraction time, so this never touches rate limits.
 *
 * @returns the analysis, or null if generation failed.
 */
export async function generateAwarenessForExtraction(args: {
  extraction: VisionExtraction;
  purpose: string | null;
  lang?: LangCode;
  reqLogger?: Logger;
}): Promise<MedicineAnalysis | null> {
  const { extraction, purpose, lang = DEFAULT_LANG, reqLogger = logger } = args;

  // Cache key includes purpose AND language, so "skin" vs "bleeding" and
  // English vs Kannada each get their own cached answer.
  const baseKey = ingredientKey(extraction.activeIngredients);
  const purposeTag = purpose
    ? purpose.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)
    : 'none';
  const key = `${baseKey}:${purposeTag}:${lang}`;

  // Cache lookup
  const cached = await lookupCachedMedicine(key).catch(() => null);
  if (cached) {
    reqLogger.info(
      { medicine: cached.analysis.medicineName, source: cached.source },
      'Returning cached analysis'
    );
    return cached.analysis;
  }

  // openFDA enrich (resilient)
  const primaryIngredient = extraction.activeIngredients[0]?.name ?? '';
  const fda = await enrichWithFda(primaryIngredient).catch(() => null);
  if (fda?.verified) {
    reqLogger.info({ ingredient: primaryIngredient }, 'FDA verified ingredient');
  }

  // Awareness generation
  let analysis: MedicineAnalysis;
  try {
    analysis = await generateAwareness({ extraction, fda, purpose, lang });
  } catch (err) {
    reqLogger.error({ err: (err as Error).message }, 'Awareness generation failed');
    return null;
  }

  // Store (best-effort)
  await storeMedicine({
    ingredientKey: key,
    medicineName: extraction.medicineName,
    analysis,
  }).catch((err) => {
    reqLogger.error({ err: (err as Error).message }, 'Store failed (returning anyway)');
    return null;
  });

  reqLogger.info({ medicine: analysis.medicineName }, 'Awareness generated');
  return analysis;
}
