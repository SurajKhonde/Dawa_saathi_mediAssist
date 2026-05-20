import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import {
  AWARENESS_SYSTEM_PROMPT,
  buildAwarenessUserMessage,
} from '@/prompts/awareness.prompt';
import type { FdaEnrichment, MedicineAnalysis, VisionExtraction } from '@/types';
import { retry } from '@/utils/async';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Generate the awareness summary for a CONFIRMED medicine.
 *
 * Stage 2 of the pipeline. Only called after vision extraction passed the
 * confidence gate. Uses the (cheaper) awareness model since the hard accuracy
 * work — reading the label — already happened in stage 1.
 */
export async function generateAwareness(args: {
  extraction: VisionExtraction;
  fda: FdaEnrichment | null;
  purpose?: string | null;
}): Promise<MedicineAnalysis> {
  const { extraction, fda, purpose } = args;

  const userMessage = buildAwarenessUserMessage({
    medicineName: extraction.medicineName,
    ingredients: extraction.activeIngredients,
    fda,
    purpose: purpose ?? null,
  });

  const response = await retry(
    () =>
      client.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 2000,
        system: AWARENESS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      onAttemptFail: (attempt, err) =>
        logger.warn(
          { attempt, err: (err as Error).message },
          'Awareness generation attempt failed, retrying'
        ),
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        if (status === undefined) return true;
        return status >= 500 || status === 429;
      },
    }
  );

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('Awareness model returned non-text response');
  }

  return parseAndValidate(block.text, extraction, fda?.verified ?? false);
}

function parseAndValidate(
  raw: string,
  extraction: VisionExtraction,
  fdaVerified: boolean
): MedicineAnalysis {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { snippet: cleaned.slice(0, 300), err: (err as Error).message },
      'Failed to parse awareness JSON'
    );
    throw new Error('Awareness model returned invalid JSON');
  }

  const warningsObj = (obj.warnings as Record<string, unknown> | undefined) ?? {};

  return {
    medicineName: String(obj.medicineName ?? extraction.medicineName),
    activeIngredients: Array.isArray(obj.activeIngredients)
      ? (obj.activeIngredients as unknown[]).map(String)
      : extraction.activeIngredients.map((i) =>
          i.strength ? `${i.name} ${i.strength}` : i.name
        ),
    drugClass: stringOrNull(obj.drugClass),
    howItWorks: stringOrNull(obj.howItWorks),
    commonUses: toStringArray(obj.commonUses, 5),
    commonSideEffects: toStringArray(obj.commonSideEffects, 5),
    seriousSideEffects: toStringArray(obj.seriousSideEffects, 4),
    warnings: {
      pregnancy: stringOrNull(warningsObj.pregnancy),
      liver: stringOrNull(warningsObj.liver),
      kidney: stringOrNull(warningsObj.kidney),
      alcohol: stringOrNull(warningsObj.alcohol),
      children: stringOrNull(warningsObj.children),
      elderly: stringOrNull(warningsObj.elderly),
    },
    interactions: toStringArray(obj.interactions, 4),
    overdoseAwareness: stringOrNull(obj.overdoseAwareness),
    fdaVerified,
  };
}

function stringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 || s.toLowerCase() === 'null' ? null : s;
}

function toStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map(String).filter((s) => s.trim().length > 0).slice(0, max);
}
