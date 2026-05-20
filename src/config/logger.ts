import pino from 'pino';
import { env } from './env';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'medicine-awareness-bot',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.apiKey',
      'TELEGRAM_BOT_TOKEN',
      'ANTHROPIC_API_KEY',
    ],
    censor: '[REDACTED]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,service,env',
        },
      }
    : undefined,
});
export function withReqId(reqId: string, extra: Record<string, unknown> = {}) {
  return logger.child({ req_id: reqId, ...extra });
}

export type Logger = typeof logger;
