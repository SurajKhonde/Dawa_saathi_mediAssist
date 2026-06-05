/**
 * STAGE 2 PROMPT: Awareness generation.
 *
 * Runs ONLY after Stage 1 confidently identified the medicine. By this point we
 * have a verified medicine name + active ingredients (optionally cross-checked
 * against openFDA). This prompt turns that into a rich, plain-language awareness
 * summary.
 *
 * Safety guardrails (unchanged from v1, still absolute):
 *   - No diagnosis
 *   - No prescription
 *   - No specific dosage
 *   - No "safe to take" language
 *   - Educational framing only, "consult a doctor" for any decision
 */

import type { FdaEnrichment } from '@/types';
import { LANGUAGES, type LangCode } from '@/config/languages';

export const AWARENESS_SYSTEM_PROMPT = `You are an educational assistant that explains medicines in simple, elder-friendly language. You are NOT a doctor or pharmacist. You give ONLY educational awareness, never medical advice.

## ABSOLUTE PROHIBITIONS
NEVER:
- Recommend a specific dosage or frequency
- Diagnose any condition or suggest the user has an illness
- Say a medicine is "safe to take" or "okay for you"
- Recommend taking, stopping, combining, or substituting any medicine
- Make claims about effectiveness for a specific person

## YOUR TASK
You are given a CONFIRMED medicine name and its active ingredients. Produce an educational awareness summary as JSON only.

Schema (return ONLY this JSON, no prose, no markdown fences):

{
  "medicineName": "string",
  "activeIngredients": ["string"],
  "drugClass": "string or null — the drug family in SIMPLE words, e.g. 'Medicine that helps stop bleeding' not 'antifibrinolytic agent'",
  "howItWorks": "string or null — one simple sentence on what it does in the body",
  "commonUses": ["string"] — plain-language, max 5 items, each under 12 words,
  "commonSideEffects": ["string"] — usually-mild effects, max 5, each under 12 words,
  "seriousSideEffects": ["string"] — rare but serious; phrase as 'See a doctor immediately if...', max 4,
  "warnings": {
    "pregnancy": "string or null",
    "liver": "string or null",
    "kidney": "string or null",
    "alcohol": "string or null",
    "children": "string or null",
    "elderly": "string or null"
  },
  "interactions": ["string"] — foods/medicines to be cautious about, max 4, framed as awareness,
  "overdoseAwareness": "string or null — risks of taking too much, NEVER state safe amounts"
}

## LANGUAGE RULES
- Simple everyday words an elderly person understands
- Avoid jargon: say "stomach" not "gastric", "liver" not "hepatic", "kidney" not "renal"
- Every warning is AWARENESS, framed as 'consult a doctor', never as a command
- Keep each item short

## ACCURACY RULE
Base your answer ONLY on the confirmed active ingredients given to you. Do NOT invent uses or effects for a different medicine. If you genuinely do not have reliable information about an ingredient, use null/empty arrays rather than guessing.

## USER PURPOSE RULE (IMPORTANT FOR SAFETY)
If the user tells you WHY they are taking the medicine, LEAD the commonUses and explanation with information relevant to THAT purpose, so a correctly-prescribed patient is not frightened by an unrelated primary use. Example: a medicine primarily used to stop bleeding may also be prescribed by dermatologists for skin pigmentation — if the user says "for skin", explain the skin use first and calmly, then briefly mention the primary use as context. NEVER approve or recommend the user's stated use; explain it for awareness only and keep the "consult your doctor" framing.

Return ONLY the JSON object.`;

/**
 * Build the awareness system prompt for a target output language.
 *
 * For English we return the base prompt unchanged. For any other language we
 * append an OUTPUT LANGUAGE block instructing the model to write all
 * human-readable VALUES in that language while keeping the JSON keys in English
 * (so parsing/formatting is untouched) and drug names in Latin script. The
 * model GENERATES directly in the target language — there is no separate
 * translation step, which keeps it to a single LLM call.
 */
export function buildAwarenessSystemPrompt(lang: LangCode): string {
  if (lang === 'en') return AWARENESS_SYSTEM_PROMPT;

  const name = LANGUAGES[lang].promptName;
  return (
    AWARENESS_SYSTEM_PROMPT +
    `\n\n## OUTPUT LANGUAGE\n` +
    `Write every human-readable VALUE in the JSON in ${name}. This includes drugClass, howItWorks, every item in commonUses, commonSideEffects, and seriousSideEffects, every non-null value inside warnings, every item in interactions, and overdoseAwareness.\n` +
    `- Keep all JSON KEYS exactly in English as in the schema. Do NOT translate the keys.\n` +
    `- Keep medicineName and the activeIngredients in their original Latin spelling. Do NOT translate or transliterate drug or ingredient names. Units such as mg and ml stay as written.\n` +
    `- Use simple, everyday ${name} that an elderly person with little schooling can understand. Avoid heavy or literary words. If you are unsure of the right term, add the common English word in brackets after the simple word.\n` +
    `- EVERY safety rule above applies equally in ${name}: no dosage, no diagnosis, no "safe to take" language, educational framing only, and always "consult a doctor".`
  );
}

/**
 * Build the user message for awareness generation, embedding the confirmed
 * extraction and any FDA-verified data.
 */
export function buildAwarenessUserMessage(args: {
  medicineName: string;
  ingredients: { name: string; strength: string | null }[];
  fda: FdaEnrichment | null;
  purpose?: string | null;
}): string {
  const { medicineName, ingredients, fda, purpose } = args;

  const ingredientLines = ingredients
    .map((i) => `- ${i.name}${i.strength ? ` (${i.strength})` : ''}`)
    .join('\n');

  const purposeBlock = purpose
    ? `\n\nUSER'S STATED PURPOSE: "${purpose}". Lead with information relevant to this use first, calmly. Then briefly mention the medicine's primary use for context. Do NOT approve the use.`
    : '';

  let fdaBlock = '';
  if (fda && fda.verified) {
    fdaBlock =
      `\n\nAUTHORITATIVE FDA REFERENCE DATA (use to improve accuracy, rewrite in simple words):\n` +
      (fda.genericName ? `- Generic name: ${fda.genericName}\n` : '') +
      (fda.purpose ? `- Purpose: ${fda.purpose}\n` : '') +
      (fda.warnings ? `- Warnings: ${fda.warnings}\n` : '');
  }

  return (
    `CONFIRMED MEDICINE:\n` +
    `Name: ${medicineName}\n` +
    `Active ingredients:\n${ingredientLines}` +
    purposeBlock +
    fdaBlock +
    `\n\nGenerate the educational awareness JSON for the active ingredients above.`
  );
}
