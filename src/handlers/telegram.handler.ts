import type TelegramBot from 'node-telegram-bot-api';
import { env } from '@/config/env';
import { logger, withReqId } from '@/config/logger';
import { genReqId } from '@/utils/async';
import {
  bot,
  downloadFile,
  sendMarkdownMessage,
  sendMessageWithRetry,
  sendTypingAction,
} from '@/services/telegram.service';
import {
  runMedicinePipeline,
  generateAwarenessForExtraction,
} from '@/services/medicine.service';
import { getCurrentUsage } from '@/services/ratelimit.service';
import {
  savePendingExtraction,
  takePendingExtraction,
} from '@/services/cache.service';
import {
  formatAnalysisForTelegram,
  formatRateLimitMessage,
  formatLowConfidenceMessage,
  formatNotAMedicineMessage,
  formatWelcomeMessage,
  formatHelpMessage,
} from '@/utils/format';
import { DISCLAIMER } from '@/config/constants';
import type { VisionExtraction } from '@/types';

/**
 * Map of purpose button callback codes -> human-readable purpose text.
 * Keep these short and broadly useful. "type" and "skip" are special.
 */
const PURPOSE_OPTIONS: { code: string; label: string; purpose: string | null }[] = [
  { code: 'skin', label: '🧴 Skin / pigmentation', purpose: 'skin pigmentation or melasma' },
  { code: 'bleeding', label: '🩸 Bleeding / periods', purpose: 'bleeding or heavy periods' },
  { code: 'pain', label: '💢 Pain / fever', purpose: 'pain or fever' },
  { code: 'infection', label: '🦠 Infection', purpose: 'an infection' },
  { code: 'bp', label: '❤️ BP / heart', purpose: 'blood pressure or heart condition' },
  { code: 'sugar', label: '🩺 Diabetes / sugar', purpose: 'diabetes or blood sugar' },
  { code: 'acidity', label: '🔥 Acidity / stomach', purpose: 'acidity or stomach issues' },
  { code: 'allergy', label: '🤧 Allergy / cold', purpose: 'allergy or cold' },
];

/**
 * Wire up all Telegram event handlers. Idempotent — safe to call once at startup.
 */
export function registerHandlers(): void {
  // /start
  bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    try {
      await sendMarkdownMessage(msg.chat.id, formatWelcomeMessage());
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/start handler failed');
    }
  });

  // /help
  bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
    try {
      await sendMarkdownMessage(msg.chat.id, formatHelpMessage());
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/help handler failed');
    }
  });

  // /usage
  bot.onText(/^\/usage(?:@\w+)?$/, async (msg) => {
    if (!msg.from) return;
    try {
      const usage = await getCurrentUsage(msg.from.id);
      const text =
        `📊 *Today's usage:* ${usage.used} of ${usage.limit} scans used\n` +
        `Remaining: *${usage.remaining}*\n\n` +
        DISCLAIMER;
      await sendMarkdownMessage(msg.chat.id, text);
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/usage handler failed');
    }
  });

  // Photo messages
  bot.on('photo', (msg) => {
    handlePhotoMessage(msg).catch((err) => {
      logger.error(
        { err: (err as Error).message, chatId: msg.chat.id },
        'photo handler crashed'
      );
    });
  });

  // Document messages (image sent as file)
  bot.on('document', (msg) => {
    handleDocumentMessage(msg).catch((err) => {
      logger.error(
        { err: (err as Error).message, chatId: msg.chat.id },
        'document handler crashed'
      );
    });
  });

  // Inline button taps (purpose selection)
  bot.on('callback_query', (q) => {
    handleCallbackQuery(q).catch((err) => {
      logger.error({ err: (err as Error).message }, 'callback handler crashed');
    });
  });

  // Text messages: could be a typed purpose (if mid-flow) or unrelated text
  bot.on('message', (msg) => {
    handleTextMessage(msg).catch((err) => {
      logger.error({ err: (err as Error).message }, 'text handler crashed');
    });
  });

  logger.info('Telegram handlers registered');
}

/* ----------------------------- Photo / document ----------------------------- */

async function handlePhotoMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.from || !msg.photo || msg.photo.length === 0) return;
  const log = withReqId(genReqId(), { chatId: msg.chat.id, userId: msg.from.id });
  log.info('Photo received');
  const largest = msg.photo[msg.photo.length - 1];
  await processImage({
    chatId: msg.chat.id,
    telegramUserId: msg.from.id,
    fileId: largest.file_id,
    reqLogger: log,
  });
}

async function handleDocumentMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.from || !msg.document) return;
  const mime = msg.document.mime_type ?? '';
  if (!mime.startsWith('image/')) {
    await sendMarkdownMessage(
      msg.chat.id,
      `Please send an *image* of your medicine label.\n\n${DISCLAIMER}`
    );
    return;
  }
  const log = withReqId(genReqId(), { chatId: msg.chat.id, userId: msg.from.id });
  log.info('Image document received');
  await processImage({
    chatId: msg.chat.id,
    telegramUserId: msg.from.id,
    fileId: msg.document.file_id,
    reqLogger: log,
  });
}

/**
 * Stage 1: download image, run extraction pipeline. On a confident read, store
 * the extraction and ASK THE USER WHY they take the medicine (purpose question).
 * Awareness is generated later, in handleCallbackQuery / handleTextMessage.
 */
async function processImage(args: {
  chatId: number;
  telegramUserId: number;
  fileId: string;
  reqLogger: ReturnType<typeof withReqId>;
}): Promise<void> {
  const { chatId, telegramUserId, fileId, reqLogger } = args;

  await sendTypingAction(chatId);

  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadFile(fileId, env.MAX_IMAGE_BYTES);
  } catch (err) {
    reqLogger.warn({ err: (err as Error).message }, 'Failed to download user image');
    await sendMarkdownMessage(
      chatId,
      `❌ Couldn't download the image. Please try sending it again.\n\n${DISCLAIMER}`
    );
    return;
  }

  const result = await runMedicinePipeline({ telegramUserId, imageBuffer, reqLogger });

  switch (result.kind) {
    case 'extracted': {
      // Save the extraction and ask the purpose question.
      await savePendingExtraction(chatId, result.extraction);
      await askPurpose(chatId, result.extraction);
      break;
    }
    case 'rate_limited':
      await sendMarkdownMessage(
        chatId,
        formatRateLimitMessage(result.resetAt, env.FREE_DAILY_SCAN_LIMIT)
      );
      break;
    case 'low_confidence':
      reqLogger.info(
        { reason: result.reason, readConfidence: result.readConfidence },
        'Low confidence - asked for clearer photo'
      );
      await sendMarkdownMessage(chatId, formatLowConfidenceMessage(result.reason));
      break;
    case 'not_a_medicine':
      await sendMarkdownMessage(chatId, formatNotAMedicineMessage());
      break;
    case 'extraction_failed':
      await sendMarkdownMessage(
        chatId,
        `❌ Couldn't read the image. Please try a clearer photo.\n\n${DISCLAIMER}`
      );
      break;
    case 'image_too_large': {
      const mb = (result.maxBytes / (1024 * 1024)).toFixed(0);
      await sendMarkdownMessage(
        chatId,
        `📦 Image is too large. Please send an image under ${mb} MB.\n\n${DISCLAIMER}`
      );
      break;
    }
  }
}

/* ------------------------------ Purpose question ----------------------------- */

/**
 * Ask the user what they are taking the medicine for, with tappable buttons.
 * Knowing the purpose lets us tailor the response so a correctly-prescribed
 * patient isn't alarmed by an unrelated primary use.
 */
async function askPurpose(chatId: number, extraction: VisionExtraction): Promise<void> {
  const ingredients = extraction.activeIngredients
    .map((i) => (i.strength ? `${i.name} ${i.strength}` : i.name))
    .join(', ');

  // Build a 2-per-row inline keyboard from PURPOSE_OPTIONS, plus type/skip.
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < PURPOSE_OPTIONS.length; i += 2) {
    rows.push(
      PURPOSE_OPTIONS.slice(i, i + 2).map((o) => ({
        text: o.label,
        callback_data: `purpose:${o.code}`,
      }))
    );
  }
  rows.push([
    { text: '✍️ Type my reason', callback_data: 'purpose:type' },
    { text: '⏭️ Skip', callback_data: 'purpose:skip' },
  ]);

  await sendMessageWithRetry(
    chatId,
    `✅ I read: *${escapeMd(extraction.medicineName)}*\n` +
      (ingredients ? `Ingredient: ${escapeMd(ingredients)}\n\n` : '\n') +
      `To give you the *right* information, what are you using this for?`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

/* ----------------------------- Callback handler ------------------------------ */

async function handleCallbackQuery(q: TelegramBot.CallbackQuery): Promise<void> {
  const chatId = q.message?.chat.id;
  if (!chatId || !q.data || !q.data.startsWith('purpose:')) return;

  // Always acknowledge the tap so Telegram stops the loading spinner.
  await bot.answerCallbackQuery(q.id).catch(() => {});

  // Remove the buttons immediately so a second tap can't double-fire.
  if (q.message) {
    await bot
      .editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: q.message.message_id }
      )
      .catch(() => {});
  }

  const code = q.data.split(':')[1];

  if (code === 'type') {
    await sendMessageWithRetry(
      chatId,
      `Please type what you are using it for (e.g. "for skin marks", "for periods").`
    );
    // The pending extraction stays in Redis; handleTextMessage will pick it up.
    return;
  }

  const extraction = await takePendingExtraction(chatId);
  if (!extraction) {
    // await sendMessageWithRetry(
    //   chatId,
    //   `That request expired. Please send the medicine photo again.`
    // );
    return;
  }

  let purpose: string | null = null;
  if (code !== 'skip') {
    purpose = PURPOSE_OPTIONS.find((o) => o.code === code)?.purpose ?? null;
  }

  await runAwarenessAndReply(chatId, extraction, purpose);
}

/* ------------------------------- Text handler -------------------------------- */

async function handleTextMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.text || msg.text.startsWith('/')) return; // commands handled elsewhere
  const chatId = msg.chat.id;

  // If the user has a pending extraction, treat their text as the purpose.
  const extraction = await takePendingExtraction(chatId);
  if (extraction) {
    await runAwarenessAndReply(chatId, extraction, msg.text.trim());
    return;
  }

  // Otherwise, gently guide them to send a photo.
  await sendMarkdownMessage(
    chatId,
    `Please send a *photo* of your medicine label.\n\nUse /help for instructions.\n\n${DISCLAIMER}`
  );
}

/* ------------------------------ Shared awareness ----------------------------- */

/**
 * Generate the (purpose-tailored) awareness response and send it.
 * Quota was already consumed at extraction time, so this is free to the user.
 */
async function runAwarenessAndReply(
  chatId: number,
  extraction: VisionExtraction,
  purpose: string | null
): Promise<void> {
  await sendTypingAction(chatId);
  const log = withReqId(genReqId(), { chatId });

  const analysis = await generateAwarenessForExtraction({
    extraction,
    purpose,
    reqLogger: log,
  });

  if (!analysis) {
    await sendMarkdownMessage(
      chatId,
      `❌ Something went wrong preparing the information. Please send the photo again.\n\n${DISCLAIMER}`
    );
    return;
  }

  await sendMarkdownMessage(chatId, formatAnalysisForTelegram(analysis));
}

/** Minimal Markdown escaping for inline values. */
function escapeMd(text: string): string {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}
