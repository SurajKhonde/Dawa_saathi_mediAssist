import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import {
  VISION_EXTRACTION_SYSTEM_PROMPT,
  VISION_EXTRACTION_USER_TEXT,
} from '@/prompts/extraction.prompt';
import type { VisionExtraction } from '@/types';
import { retry } from '@/utils/async';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Detect the image media type from the buffer's magic bytes.
 * Claude needs the correct media_type for the image content block.
 */
function detectMediaType(
  buffer: Buffer
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  // Default to JPEG (Telegram photos are usually JPEG)
  return 'image/jpeg';
}

/**
 * Extract medicine information from an image using Claude vision.
 *
 * This REPLACES Tesseract OCR. Claude vision reads drug names far more
 * accurately and — critically — follows the "never guess" instruction,
 * lowering confidence instead of hallucinating a similar-looking name.
 *
 * Uses the EXTRACTION_MODEL (defaults to Sonnet for accuracy on the
 * safety-critical reading step).
 */
export async function extractMedicineFromImage(
  imageBuffer: Buffer
): Promise<VisionExtraction> {
  const mediaType = detectMediaType(imageBuffer);
  const base64 = imageBuffer.toString('base64');
  const startedAt = Date.now();

  const response = await retry(
    () =>
      client.messages.create({
        model: env.EXTRACTION_MODEL,
        max_tokens: 1024,
        system: VISION_EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              },
              { type: 'text', text: VISION_EXTRACTION_USER_TEXT },
            ],
          },
        ],
      }),
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      onAttemptFail: (attempt, err) =>
        logger.warn(
          { attempt, err: (err as Error).message },
          'Vision extraction attempt failed, retrying'
        ),
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        if (status === undefined) return true;
        return status >= 500 || status === 429;
      },
    }
  );

  const durationMs = Date.now() - startedAt;
  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('Vision model returned non-text response');
  }

  const extraction = parseExtraction(block.text);
  logger.info(
    {
      durationMs,
      isMedicine: extraction.isMedicine,
      readConfidence: extraction.readConfidence,
      medicine: extraction.medicineName,
    },
    'Vision extraction complete'
  );

  return extraction;
}

function parseExtraction(raw: string): VisionExtraction {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { snippet: cleaned.slice(0, 300), err: (err as Error).message },
      'Failed to parse vision extraction JSON'
    );
    throw new Error('Vision model returned invalid JSON');
  }

  const rawIngredients = Array.isArray(parsed.activeIngredients)
    ? (parsed.activeIngredients as unknown[])
    : [];

  return {
    isMedicine: parsed.isMedicine === true,
    medicineName: String(parsed.medicineName ?? 'unknown'),
    activeIngredients: rawIngredients
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        name: String(x.name ?? '').trim(),
        strength:
          x.strength === null || x.strength === undefined
            ? null
            : String(x.strength).trim(),
      }))
      .filter((x) => x.name.length > 0),
    otherReadableText: String(parsed.otherReadableText ?? ''),
    readConfidence:
      typeof parsed.readConfidence === 'number'
        ? Math.max(0, Math.min(1, parsed.readConfidence))
        : 0,
    uncertaintyReason:
      parsed.uncertaintyReason === null || parsed.uncertaintyReason === undefined
        ? null
        : String(parsed.uncertaintyReason),
  };
}
