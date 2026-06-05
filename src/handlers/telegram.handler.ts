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
import { getUserLang, setUserLang } from '@/services/lang.service';
import {
  formatAnalysisForTelegram,
  formatRateLimitMessage,
  formatLowConfidenceMessage,
  formatNotAMedicineMessage,
  formatWelcomeMessage,
  formatHelpMessage,
} from '@/utils/format';
import { t, LANGUAGE_PROMPT } from '@/config/i18n';
import { LANGUAGES, SUPPORTED_LANGS, isLangCode, type LangCode } from '@/config/languages';
import type { VisionExtraction } from '@/types';

/**
 * Purpose buttons. `code` is stable, `purpose` is the English phrase sent to the
 * awareness model (it understands English and generates the reply in the user's
 * language). The button LABEL the user sees comes from the i18n table by code.
 */
const PURPOSE_OPTIONS: { code: string; purpose: string }[] = [
  { code: 'skin', purpose: 'skin pigmentation or melasma' },
  { code: 'bleeding', purpose: 'bleeding or heavy periods' },
  { code: 'pain', purpose: 'pain or fever' },
  { code: 'infection', purpose: 'an infection' },
  { code: 'bp', purpose: 'blood pressure or heart condition' },
  { code: 'sugar', purpose: 'diabetes or blood sugar' },
  { code: 'acidity', purpose: 'acidity or stomach issues' },
  { code: 'allergy', purpose: 'allergy or cold' },
];

/* ------------------------------ Language picker ----------------------------- */

/** Inline keyboard offering every supported language (button = native name). */
function languageKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  return [
    SUPPORTED_LANGS.map((code) => ({
      text: LANGUAGES[code].nativeName,
      callback_data: `lang:${code}`,
    })),
  ];
}

/** Ask the user which language they are comfortable in (shown on /start, /language). */
async function askLanguage(chatId: number): Promise<void> {
  await sendMessageWithRetry(chatId, LANGUAGE_PROMPT, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: languageKeyboard() },
  });
}

/**
 * Wire up all Telegram event handlers. Idempotent — call once at startup.
 */
export function registerHandlers(): void {
  // /start -> ask language first, so everything afterwards is in that language
  bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    try {
      await askLanguage(msg.chat.id);
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/start handler failed');
    }
  });

  // /language -> change language anytime
  bot.onText(/^\/language(?:@\w+)?$/, async (msg) => {
    try {
      await askLanguage(msg.chat.id);
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/language handler failed');
    }
  });

  // /help
  bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
    try {
      const lang = await getUserLang(msg.chat.id);
      await sendMarkdownMessage(msg.chat.id, formatHelpMessage(lang));
    } catch (err) {
      logger.error({ err: (err as Error).message }, '/help handler failed');
    }
  });

  // /usage
  bot.onText(/^\/usage(?:@\w+)?$/, async (msg) => {
    if (!msg.from) return;
    try {
      const lang = await getUserLang(msg.chat.id);
      const usage = await getCurrentUsage(msg.from.id);
      await sendMarkdownMessage(
        msg.chat.id,
        t(lang).usage(usage.used, usage.limit, usage.remaining)
      );
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

  // Inline button taps (language selection OR purpose selection)
  bot.on('callback_query', (q) => {
    handleCallbackQuery(q).catch((err) => {
      logger.error({ err: (err as Error).message }, 'callback handler crashed');
    });
  });

  // Text messages: a typed purpose (if mid-flow) or unrelated text
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
  const lang = await getUserLang(msg.chat.id);
  const mime = msg.document.mime_type ?? '';
  if (!mime.startsWith('image/')) {
    await sendMarkdownMessage(msg.chat.id, t(lang).sendImage);
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

  const lang = await getUserLang(chatId);
  await sendTypingAction(chatId);

  let imageBuffer: Buffer;
  try {
    imageBuffer = await downloadFile(fileId, env.MAX_IMAGE_BYTES);
  } catch (err) {
    reqLogger.warn({ err: (err as Error).message }, 'Failed to download user image');
    await sendMarkdownMessage(chatId, t(lang).downloadFailed);
    return;
  }

  const result = await runMedicinePipeline({ telegramUserId, imageBuffer, reqLogger });

  switch (result.kind) {
    case 'extracted': {
      await savePendingExtraction(chatId, result.extraction);
      await askPurpose(chatId, result.extraction, lang);
      break;
    }
    case 'rate_limited':
      await sendMarkdownMessage(
        chatId,
        formatRateLimitMessage(result.resetAt, env.FREE_DAILY_SCAN_LIMIT, lang)
      );
      break;
    case 'low_confidence':
      reqLogger.info(
        { reason: result.reason, readConfidence: result.readConfidence },
        'Low confidence - asked for clearer photo'
      );
      await sendMarkdownMessage(chatId, formatLowConfidenceMessage(result.reason, lang));
      break;
    case 'not_a_medicine':
      await sendMarkdownMessage(chatId, formatNotAMedicineMessage(lang));
      break;
    case 'extraction_failed':
      await sendMarkdownMessage(chatId, t(lang).extractionFailed);
      break;
    case 'image_too_large': {
      const mb = (result.maxBytes / (1024 * 1024)).toFixed(0);
      await sendMarkdownMessage(chatId, t(lang).imageTooLarge(mb));
      break;
    }
  }
}

/* ------------------------------ Purpose question ----------------------------- */

/**
 * Ask the user what they are taking the medicine for, with tappable buttons.
 * Knowing the purpose lets us tailor the response so a correctly-prescribed
 * patient isn't alarmed by an unrelated primary use. Labels come from i18n.
 */
async function askPurpose(
  chatId: number,
  extraction: VisionExtraction,
  lang: LangCode
): Promise<void> {
  const L = t(lang);
  const ingredients = extraction.activeIngredients
    .map((i) => (i.strength ? `${i.name} ${i.strength}` : i.name))
    .join(', ');

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < PURPOSE_OPTIONS.length; i += 2) {
    rows.push(
      PURPOSE_OPTIONS.slice(i, i + 2).map((o) => ({
        text: L.purposeLabels[o.code] ?? o.code,
        callback_data: `purpose:${o.code}`,
      }))
    );
  }
  rows.push([
    { text: L.typeLabel, callback_data: 'purpose:type' },
    { text: L.skipLabel, callback_data: 'purpose:skip' },
  ]);

  await sendMessageWithRetry(
    chatId,
    L.purposeQuestion(extraction.medicineName, ingredients),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

/* ----------------------------- Callback handler ------------------------------ */

async function handleCallbackQuery(q: TelegramBot.CallbackQuery): Promise<void> {
  const chatId = q.message?.chat.id;
  if (!chatId || !q.data) return;

  // Acknowledge the tap so Telegram stops the loading spinner.
  await bot.answerCallbackQuery(q.id).catch(() => {});

  // Remove the buttons so a second tap can't double-fire.
  if (q.message) {
    await bot
      .editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: q.message.message_id }
      )
      .catch(() => {});
  }

  // ---- Language selection ----
  if (q.data.startsWith('lang:')) {
    const code = q.data.split(':')[1];
    if (!isLangCode(code)) return;
    await setUserLang(chatId, code);
    // Greet the user in the language they just picked.
    await sendMarkdownMessage(chatId, formatWelcomeMessage(code));
    return;
  }

  // ---- Purpose selection ----
  if (!q.data.startsWith('purpose:')) return;
  const lang = await getUserLang(chatId);
  const code = q.data.split(':')[1];

  if (code === 'type') {
    await sendMarkdownMessage(chatId, t(lang).purposeTypePrompt);
    // The pending extraction stays in Redis; handleTextMessage picks it up.
    return;
  }

  const extraction = await takePendingExtraction(chatId);
  if (!extraction) return;

  let purpose: string | null = null;
  if (code !== 'skip') {
    purpose = PURPOSE_OPTIONS.find((o) => o.code === code)?.purpose ?? null;
  }

  await runAwarenessAndReply(chatId, extraction, purpose, lang);
}

/* ------------------------------- Text handler -------------------------------- */

async function handleTextMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.text || msg.text.startsWith('/')) return; // commands handled elsewhere
  const chatId = msg.chat.id;
  const lang = await getUserLang(chatId);

  // If the user has a pending extraction, treat their text as the purpose.
  const extraction = await takePendingExtraction(chatId);
  if (extraction) {
    await runAwarenessAndReply(chatId, extraction, msg.text.trim(), lang);
    return;
  }

  // Otherwise, gently guide them to send a photo.
  await sendMarkdownMessage(chatId, t(lang).sendPhoto);
}

/* ------------------------------ Shared awareness ----------------------------- */

/**
 * Generate the (purpose-tailored) awareness response in the user's language and
 * send it. Quota was already consumed at extraction time, so this is free.
 */
async function runAwarenessAndReply(
  chatId: number,
  extraction: VisionExtraction,
  purpose: string | null,
  lang: LangCode
): Promise<void> {
  await sendTypingAction(chatId);
  const log = withReqId(genReqId(), { chatId });

  const analysis = await generateAwarenessForExtraction({
    extraction,
    purpose,
    lang,
    reqLogger: log,
  });

  if (!analysis) {
    await sendMarkdownMessage(chatId, t(lang).somethingWrong);
    return;
  }

  await sendMarkdownMessage(chatId, formatAnalysisForTelegram(analysis, lang));
}
