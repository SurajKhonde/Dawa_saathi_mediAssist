/**
 * STAGE 1 OUTPUT: Vision extraction.
 * This is pure transcription — what Claude can actually READ on the package.
 * NO medical interpretation happens here. The point is accuracy of reading.
 */
export interface VisionExtraction {
  /** Is this image actually a medicine package/strip/bottle? */
  isMedicine: boolean;

  /** Medicine name EXACTLY as printed (brand or generic). "unknown" if unreadable. */
  medicineName: string;

  /**
   * Active ingredients EXACTLY as printed, with strength.
   * e.g., [{ name: "Tranexamic Acid", strength: "500mg" }]
   * Empty array if not clearly readable.
   */
  activeIngredients: { name: string; strength: string | null }[];

  /** All other clearly-legible text (manufacturer, batch, etc.). For context. */
  otherReadableText: string;

  /**
   * Confidence (0-1) specifically in reading the NAME and ACTIVE INGREDIENTS.
   * This is the safety-critical number. Low = blurry/ambiguous = ask for retry.
   *
   * Claude is instructed to LOWER this when characters are unclear or when
   * the name could be confused with a similar drug (e.g. Tranexamic vs Mefenamic).
   */
  readConfidence: number;

  /** If confidence is low, a short reason (e.g. "name is blurry", "glare on strip"). */
  uncertaintyReason: string | null;
}

/**
 * Optional data pulled from openFDA to verify and enrich the active ingredient.
 */
export interface FdaEnrichment {
  /** Was the active ingredient found in the FDA database? */
  verified: boolean;
  /** Generic name as per FDA. */
  genericName: string | null;
  /** Authoritative purpose/indications text (trimmed). */
  purpose: string | null;
  /** Authoritative warnings text (trimmed). */
  warnings: string | null;
}

/**
 * STAGE 2 OUTPUT: The awareness summary shown to the user.
 * Richer than before — drug class, how it works, serious vs common side effects.
 * Still strictly educational: no diagnosis, no dosage, no "safe to take".
 */
export interface MedicineAnalysis {
  medicineName: string;
  activeIngredients: string[];

  /** Drug class in simple words, e.g. "Medicine that helps stop bleeding". */
  drugClass: string | null;

  /** Simple one-line explanation of what it does in the body. */
  howItWorks: string | null;

  /** Common uses in plain language. Max 5. */
  commonUses: string[];

  /** Common, usually-mild side effects. Max 5. */
  commonSideEffects: string[];

  /** Serious side effects = "see a doctor immediately if...". Max 4. */
  seriousSideEffects: string[];

  warnings: {
    pregnancy: string | null;
    liver: string | null;
    kidney: string | null;
    alcohol: string | null;
    children: string | null;
    elderly: string | null;
  };

  /** Interactions to be aware of (food, other medicines). Max 4. */
  interactions: string[];

  /** Awareness note about overdose (NOT dosage advice). */
  overdoseAwareness: string | null;

  /** Whether this analysis was backed by FDA-verified ingredient data. */
  fdaVerified: boolean;
}

export interface StoredMedicine {
  id: number;
  ingredientKey: string;
  medicineName: string;
  analysis: MedicineAnalysis;
  createdAt: Date;
  hitCount: number;
}

/**
 * Result of the full pipeline. The handler maps each variant to a Telegram reply.
 */
export type PipelineResult =
  | { kind: 'extracted'; extraction: VisionExtraction }
  | { kind: 'not_a_medicine' }
  | { kind: 'low_confidence'; reason: string | null; readConfidence: number }
  | { kind: 'extraction_failed'; reason: string }
  | { kind: 'rate_limited'; resetAt: Date }
  | { kind: 'image_too_large'; sizeBytes: number; maxBytes: number };
