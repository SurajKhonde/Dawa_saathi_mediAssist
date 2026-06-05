/**
 * Supported user-facing languages.
 *
 * To add a language later (e.g. Hindi, Marathi):
 *   1. Add its code to LangCode
 *   2. Add a LanguageMeta entry below
 *   3. Add its STRINGS block in src/config/i18n.ts
 * Everything else (picker, caching, generation) adapts automatically.
 */

export type LangCode = 'en' | 'kn';

export interface LanguageMeta {
  code: LangCode;
  /** Name in English, e.g. "Kannada". */
  englishName: string;
  /** Name in its own script, shown on the picker button, e.g. "ಕನ್ನಡ". */
  nativeName: string;
  /**
   * How Claude should refer to the OUTPUT language in the generation prompt.
   * Including the native script helps the model commit to the right language.
   */
  promptName: string;
}

export const LANGUAGES: Record<LangCode, LanguageMeta> = {
  en: {
    code: 'en',
    englishName: 'English',
    nativeName: 'English',
    promptName: 'English',
  },
  kn: {
    code: 'kn',
    englishName: 'Kannada',
    nativeName: 'ಕನ್ನಡ',
    promptName: 'Kannada (ಕನ್ನಡ)',
  },
};

export const DEFAULT_LANG: LangCode = 'en';

export const SUPPORTED_LANGS = Object.keys(LANGUAGES) as LangCode[];

export function isLangCode(value: string): value is LangCode {
  return value in LANGUAGES;
}
