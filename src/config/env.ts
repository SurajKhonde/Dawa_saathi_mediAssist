import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  // Model used for the safety-critical IMAGE READING step. Defaults to Sonnet
  // for accuracy. You can set this to Haiku to save cost if accuracy is enough.
  EXTRACTION_MODEL: z.string().default('claude-sonnet-4-6'),
  // Model used for generating the awareness text (cheaper is fine here).
  CLAUDE_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // PostgreSQL
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().default('medbot'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().default('medbot'),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Rate limiting
  FREE_DAILY_SCAN_LIMIT: z.coerce.number().int().positive().default(3),

  // Caching
  MEDICINE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),

  // Image processing
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  // Safety: minimum confidence (0-1) in reading the medicine name/ingredients
  // before we proceed. Below this, we ask the user for a clearer photo and do
  // NOT consume their scan quota. Higher = safer but more retries. Medical apps
  // should keep this strict.
  EXTRACTION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

  // Verify + enrich active ingredients against the openFDA database.
  ENABLE_FDA_LOOKUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
