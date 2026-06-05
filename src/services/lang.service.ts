import { redis } from '@/redis/client';
import { logger } from '@/config/logger';
import { DEFAULT_LANG, isLangCode, type LangCode } from '@/config/languages';

/**
 * Per-user language preference, stored in Redis keyed by chatId.
 *
 * In Telegram private chats chatId === user id, so this is effectively a
 * per-user setting. We give it a long TTL so the choice "sticks" across
 * sessions but eventually self-cleans for users who never come back.
 */

const LANG_PREFIX = 'lang:v1:';
const LANG_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

/** Returns the user's chosen language, or DEFAULT_LANG if unset/unreadable. */
export async function getUserLang(chatId: number): Promise<LangCode> {
  try {
    const v = await redis.get(LANG_PREFIX + chatId);
    if (v && isLangCode(v)) return v;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'getUserLang failed; falling back to default'
    );
  }
  return DEFAULT_LANG;
}

/** Persist the user's chosen language (best-effort, refreshes the TTL). */
export async function setUserLang(chatId: number, lang: LangCode): Promise<void> {
  try {
    await redis.setex(LANG_PREFIX + chatId, LANG_TTL_SECONDS, lang);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'setUserLang failed');
  }
}
