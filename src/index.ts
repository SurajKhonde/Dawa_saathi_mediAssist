import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { buildApp } from '@/app';
import { pingDb, closeDb } from '@/db/client';
import { migrate } from '@/db/migrate';
import { pingRedis, closeRedis } from '@/redis/client';
import { startBot, stopBot } from '@/services/telegram.service';
import { registerHandlers } from '@/handlers/telegram.handler';

/**
 * Application bootstrap. Order matters:
 *   1. Connect to Postgres, run migrations
 *   2. Connect to Redis
 *   3. Start Express server (health checks become live)
 *   4. Register Telegram handlers and start bot
 *   5. Install signal handlers for graceful shutdown
 */
async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV, model: env.CLAUDE_MODEL }, 'Starting up');

  // 1. Postgres
  await pingDb();
  await migrate();

  // 2. Redis
  await pingRedis();


  // 4. Express HTTP server
  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP server listening');
  });

  // 5. Telegram
  registerHandlers();
  await startBot();

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new work
    await stopBot().catch((err) =>
      logger.error({ err: err.message }, 'stopBot failed')
    );

    server.close((err) => {
      if (err) logger.error({ err: err.message }, 'HTTP server close error');
    });

    // Release resources in reverse order of acquisition
    await closeRedis().catch((err) =>
      logger.error({ err: err.message }, 'closeRedis failed')
    );
    await closeDb().catch((err) =>
      logger.error({ err: err.message }, 'closeDb failed')
    );

    logger.info('Shutdown complete');
    process.exit(0);
  };

  // Catch SIGINT (Ctrl+C) and SIGTERM (docker stop)
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Last-resort safety net for unhandled errors
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    // Exit so process manager can restart us
    process.exit(1);
  });

  logger.info('🚀 Medicine Awareness Bot is live');
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'Bootstrap failed'
  );
  process.exit(1);
});
