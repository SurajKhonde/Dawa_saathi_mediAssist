import type { MedicineAnalysis } from '@/types';
import { DISCLAIMER } from '@/config/constants';

/**
 * Render a MedicineAnalysis into a clean, elder-friendly Telegram message.
 * Richer than v1: drug class, how it works, serious side effects, interactions.
 * Always ends with the disclaimer.
 */
export function formatAnalysisForTelegram(a: MedicineAnalysis): string {
  const s: string[] = [];

  s.push(`💊 *${escapeMarkdown(a.medicineName)}*`);

  if (a.activeIngredients.length > 0) {
    s.push(`*Contains:* ${a.activeIngredients.map(escapeMarkdown).join(', ')}`);
  }

  if (a.drugClass) {
    s.push(`*What kind of medicine:* ${escapeMarkdown(a.drugClass)}`);
  }

  if (a.howItWorks) {
    s.push(`*How it works:* ${escapeMarkdown(a.howItWorks)}`);
  }

  if (a.commonUses.length > 0) {
    s.push(`*Commonly used for:*\n${bullets(a.commonUses)}`);
  }

  if (a.commonSideEffects.length > 0) {
    s.push(`*Common side effects:*\n${bullets(a.commonSideEffects)}`);
  }

  if (a.seriousSideEffects.length > 0) {
    s.push(`🚑 *See a doctor immediately if:*\n${bullets(a.seriousSideEffects)}`);
  }

  const activeWarnings = Object.entries(a.warnings).filter(
    ([, msg]) => msg !== null && msg.trim().length > 0
  ) as [string, string][];
  if (activeWarnings.length > 0) {
    const list = activeWarnings
      .map(([k, msg]) => `  • *${capitalize(k)}:* ${escapeMarkdown(msg)}`)
      .join('\n');
    s.push(`⚠️ *Warnings:*\n${list}`);
  }

  if (a.interactions.length > 0) {
    s.push(`*Be careful with:*\n${bullets(a.interactions)}`);
  }

  if (a.overdoseAwareness) {
    s.push(`🚨 *Overdose awareness:* ${escapeMarkdown(a.overdoseAwareness)}`);
  }

  if (a.fdaVerified) {
    s.push(`_✓ Ingredient verified against FDA drug database._`);
  }

  s.push(`\n${DISCLAIMER}`);

  return s.join('\n\n');
}

function bullets(items: string[]): string {
  return items.map((i) => `  • ${escapeMarkdown(i)}`).join('\n');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatRateLimitMessage(resetAt: Date, limit: number): string {
  const hours = Math.ceil((resetAt.getTime() - Date.now()) / (1000 * 60 * 60));
  return (
    `🛑 *Daily limit reached*\n\n` +
    `You've used your ${limit} free scans for today. ` +
    `Your limit resets in about ${hours} hour${hours === 1 ? '' : 's'}.\n\n` +
    DISCLAIMER
  );
}

/**
 * Shown when the medicine name/ingredients couldn't be read confidently.
 * IMPORTANT: tells the user their scan was NOT counted, so they retry freely.
 */
export function formatLowConfidenceMessage(reason: string | null): string {
  return (
    `🔍 *I couldn't read this clearly enough to be sure*\n\n` +
    (reason ? `_${escapeMarkdown(reason)}_\n\n` : '') +
    `For your safety, I won't guess the medicine name — a wrong guess could be dangerous.\n\n` +
    `Please send a clearer photo:\n` +
    `  • Good lighting, no glare\n` +
    `  • Focus on the medicine name and ingredients\n` +
    `  • Hold the camera steady and close\n\n` +
    `_This attempt was NOT counted against your daily limit._\n\n` +
    DISCLAIMER
  );
}

export function formatNotAMedicineMessage(): string {
  return (
    `🤔 *That doesn't look like a medicine package*\n\n` +
    `Please send a clear photo of a medicine strip, bottle, or box.\n\n` +
    `_This attempt was NOT counted against your daily limit._\n\n` +
    DISCLAIMER
  );
}

export function formatWelcomeMessage(): string {
  return (
    `👋 *Welcome to Dawa Saathi — your medicine awareness companion*\n\n` +
    `Send me a photo of any medicine label and I'll explain in simple language:\n` +
    `  • What it's commonly used for\n` +
    `  • Common and serious side effects\n` +
    `  • Important warnings\n\n` +
    `You can scan up to 3 medicines per day for free.\n\n` +
    DISCLAIMER
  );
}

export function formatHelpMessage(): string {
  return (
    `*How to use Dawa Saathi:*\n\n` +
    `1. Take a clear, well-lit photo of the medicine label\n` +
    `2. Send the photo to this chat\n` +
    `3. Wait a few seconds for the analysis\n\n` +
    `*Tips for best results:*\n` +
    `  • Focus on the name and ingredients\n` +
    `  • Avoid glare and shadows\n` +
    `  • Hold steady and close\n\n` +
    `*Commands:*\n` +
    `  /start — Welcome message\n` +
    `  /help — Show this help\n` +
    `  /usage — Check today's remaining scans\n\n` +
    DISCLAIMER
  );
}
