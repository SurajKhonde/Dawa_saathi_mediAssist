import { env } from '@/config/env';
import { logger } from '@/config/logger';
import type { FdaEnrichment } from '@/types';

/**
 * openFDA drug label lookup.
 *
 * Purpose: a verification + enrichment layer. After Claude reads the active
 * ingredient, we check it against the FDA's free drug label database
 * (https://open.fda.gov). This:
 *   - Confirms the ingredient is a REAL drug (catches obvious hallucinations)
 *   - Pulls authoritative purpose + warnings text we feed back to Claude
 *
 * IMPORTANT LIMITATIONS (be honest about these):
 *   - openFDA is US data. Indian BRAND names won't be found — but ACTIVE
 *     INGREDIENTS (the chemical, e.g. "tranexamic acid") are universal and
 *     usually present. We search by ingredient, not brand.
 *   - It will NOT catch "read one real drug instead of another real drug"
 *     (both Tranexamic and Mefenamic exist in FDA). That class of error is
 *     prevented upstream by Claude vision + the confidence gate. openFDA is
 *     a secondary enrichment, not the primary safety layer.
 *   - No API key needed for low volume. Rate limit ~240 req/min, 1000/day.
 *
 * Resilient by design: any failure returns { verified: false } and the pipeline
 * continues with Claude-only knowledge. FDA lookup never blocks a response.
 */
export async function enrichWithFda(
  ingredientName: string
): Promise<FdaEnrichment> {
  const empty: FdaEnrichment = {
    verified: false,
    genericName: null,
    purpose: null,
    warnings: null,
  };

  if (!env.ENABLE_FDA_LOOKUP) return empty;
  if (!ingredientName || ingredientName.trim().length < 3) return empty;

  // Sanitize: openFDA search is sensitive to punctuation.
  const term = ingredientName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();

  // Search the drug label endpoint by active ingredient.
  const url =
    `https://api.fda.gov/drug/label.json?search=` +
    encodeURIComponent(`active_ingredient:"${term}"`) +
    `&limit=1`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.status === 404) {
      // openFDA returns 404 when no results match — not an error, just a miss.
      logger.debug({ ingredient: term }, 'FDA: no match');
      return empty;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, ingredient: term }, 'FDA lookup non-OK');
      return empty;
    }

    const data = (await res.json()) as {
      results?: Array<{
        openfda?: { generic_name?: string[] };
        purpose?: string[];
        indications_and_usage?: string[];
        warnings?: string[];
      }>;
    };

    const result = data.results?.[0];
    if (!result) return empty;

    const genericName = result.openfda?.generic_name?.[0] ?? null;
    const purpose =
      trimText(result.purpose?.[0]) ??
      trimText(result.indications_and_usage?.[0]);
    const warnings = trimText(result.warnings?.[0]);

    logger.info({ ingredient: term, genericName }, 'FDA: verified ingredient');

    return {
      verified: true,
      genericName,
      purpose,
      warnings,
    };
  } catch (err) {
    // Timeout, network error, etc. Non-fatal.
    logger.warn(
      { ingredient: term, err: (err as Error).message },
      'FDA lookup failed (continuing without it)'
    );
    return empty;
  }
}

/**
 * Trim long FDA label text to a reasonable size for the prompt.
 */
function trimText(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 600 ? cleaned.slice(0, 600) + '…' : cleaned;
}
