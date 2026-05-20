import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from '@/config/logger';
import { healthRouter } from '@/routes/health.routes';

/**
 * Build and return the Express application.
 */
export function buildApp(): Express {
  const app = express();

  // We don't need body parsing for health checks. If you add webhook later,
  // mount express.json() only on those routes.
  app.disable('x-powered-by');

  // Lightweight request log
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'HTTP request');
    next();
  });

  // Routes
  app.use(healthRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error handler (must have 4 params for Express to recognize it)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled Express error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
