import TelegramBot from 'node-telegram-bot-api';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '@/config/constants';
import { retry } from '@/utils/async';

/**
 * Single shared Telegram bot client. Uses long-polling, which means:
 *  - No public URL needed (good for Docker/local)
 *  - No webhook setup, no ngrok
 *  - Bot pulls updates from Telegram every few seconds
 *
 * For production with high traffic, switch to webhooks (set webHook: { url: ... }).
 */
export const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: false,
    params: {
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    },
  },
  request: {
    family: 4,
  } as TelegramBot.ConstructorOptions['request'],
})

bot.on('polling_error', (err) => {
  logger.error({ err: err.message }, 'Telegram polling error');
});

/**
 * Start the bot's long-poll loop. Call after all handlers are registered.
 */
export async function startBot(): Promise<void> {
  await bot.startPolling();
  const me = await bot.getMe();
  logger.info(
    { username: me.username, botId: me.id },
    'Telegram bot started (polling mode)'
  );
}

/**
 * Stop the bot gracefully.
 */
export async function stopBot(): Promise<void> {
  await bot.stopPolling();
  logger.info('Telegram bot stopped');
}

/**
 * Download a photo or document file by file_id. Returns the file as a Buffer.
 * Throws if file exceeds maxBytes.
 */
export async function downloadFile(
  fileId: string,
  maxBytes: number
): Promise<Buffer> {
  // Telegram file downloads can intermittently fail with "fetch failed" due to
  // transient network issues reaching api.telegram.org. Retry with backoff so a
  // single blip doesn't reject the user's photo.
  return retry(
    async () => {
      const fileLink = await bot.getFileLink(fileId);
      const res = await fetch(fileLink);
      if (!res.ok) {
        throw new Error(`Failed to download Telegram file: HTTP ${res.status}`);
      }

      // Check content-length before reading body
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxBytes) {
        throw new Error(`File too large: ${contentLength} bytes (max ${maxBytes})`);
      }

      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength > maxBytes) {
        throw new Error(
          `File too large: ${arrayBuffer.byteLength} bytes (max ${maxBytes})`
        );
      }

      return Buffer.from(arrayBuffer);
    },
    {
      maxAttempts: 3,
      initialDelayMs: 800,
      onAttemptFail: (attempt, err) =>
        logger.warn(
          { attempt, err: (err as Error).message },
          'Telegram file download failed, retrying'
        ),
      // Don't retry "file too large" — that won't change on retry.
      shouldRetry: (err) =>
        !(err instanceof Error && err.message.startsWith('File too large')),
    }
  );
}

/**
 * Send a message with retry. Telegram sends intermittently fail with
 * "EFATAL: AggregateError" / ETIMEDOUT due to flaky connectivity to
 * api.telegram.org. Retrying with backoff prevents these blips from crashing
 * the message flow. Accepts full SendMessageOptions (parse_mode, reply_markup).
 */
export async function sendMessageWithRetry(
  chatId: number,
  text: string,
  options: TelegramBot.SendMessageOptions = {}
): Promise<void> {
  await retry(() => bot.sendMessage(chatId, text, options), {
    maxAttempts: 3,
    initialDelayMs: 700,
    onAttemptFail: (attempt, err) =>
      logger.warn(
        { attempt, err: (err as Error).message, chatId },
        'Telegram sendMessage failed, retrying'
      ),
  });
}

/**
 * Send a Markdown-formatted message, chunking if it exceeds Telegram's length limit.
 */
export async function sendMarkdownMessage(
  chatId: number,
  text: string
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    await sendMessageWithRetry(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    return;
  }

  // Chunk on newline boundaries
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await sendMessageWithRetry(chatId, chunk, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }
}

/**
 * Send a typing indicator. Use during long operations so the user sees activity.
 */
export async function sendTypingAction(chatId: number): Promise<void> {
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'sendChatAction failed');
  }
}
