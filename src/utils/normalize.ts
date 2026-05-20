import { createHash } from 'node:crypto';

/**
 * Build a stable cache key from active ingredients. Two photos of the same
 * medicine produce the same key, regardless of brand-name OCR differences,
 * because awareness is fundamentally about the ACTIVE INGREDIENTS.
 *
 * e.g. [{name:"Tranexamic Acid", strength:"500mg"}] -> "tranexamic acid 500mg"
 */
export function ingredientKey(
  ingredients: { name: string; strength: string | null }[]
): string {
  const normalized = ingredients
    .map((i) => {
      const name = i.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const strength = (i.strength ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();
      return strength ? `${name} ${strength}` : name;
    })
    .filter((s) => s.length > 0)
    .sort()
    .join(' + ');

  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Get today's date as YYYY-MM-DD in server timezone. Used for daily rate limits.
 */
export function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Seconds remaining until midnight (used as Redis TTL for daily rate limit keys).
 */
export function secondsUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}
