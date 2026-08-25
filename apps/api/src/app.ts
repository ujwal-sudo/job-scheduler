import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { authRouter } from './api/routes/auth';
import { orgsRouter } from './api/routes/orgs';
import { projectsRouter } from './api/routes/projects';
import { retryPoliciesRouter } from './api/routes/retryPolicies';
import { queuesRouter } from './api/routes/queues';
import { queuesAliasRouter } from './api/routes/queuesAlias';
import { jobsRouter } from './api/routes/jobs';
import { jobsAliasRouter } from './api/routes/jobsAlias';
import { schedulesRouter } from './api/routes/schedules';
import { workersRouter } from './api/routes/workers';
import { dlqRouter } from './api/routes/dlq';
import { eventsRouter } from './api/routes/events';
import { metricsRouter } from './api/routes/metrics';
import { verifyAuth } from './api/middleware/auth';
import { apiRateLimiter } from './api/middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';

export function createApp(): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '2mb' }));
  if (config.nodeEnv !== 'test') {
    app.use(morgan('dev'));
  }

  // ── Health (no auth) ──────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  // ── API v1 ────────────────────────────────────────────────────────────────
  const v1 = express.Router();
  v1.use(authRateSafe);

  v1.use('/auth', authRouter);
  v1.use('/orgs', orgsRouter);
  v1.use('/orgs/:orgSlug/projects', projectsRouter);
  v1.use('/orgs/:orgSlug/projects/:projectId/retry-policies', retryPoliciesRouter);
  v1.use('/projects/:projectId/queues', queuesRouter);
  v1.use('/queues', queuesAliasRouter);
  v1.use('/queues/:queueId/jobs', jobsRouter);
  v1.use('/jobs', jobsAliasRouter);
  v1.use('/queues/:queueId/schedules', schedulesRouter);
  v1.use('/queues/:queueId/dlq', dlqRouter);
  v1.use('/workers', workersRouter);
  v1.use('/events', eventsRouter);
  v1.use('/projects/:projectId/metrics', metricsRouter);

  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Auth applies to everything except /auth/* and worker-internal endpoints
 *  (which authenticate with x-worker-token inside the workers router);
 *  rate limit runs after identity is known. */
function authRateSafe(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const path = req.path;
  const isPublic =
    path.startsWith('/auth') ||
    path.startsWith('/workers/register') ||
    /^\/workers\/[^/]+\/heartbeat$/.test(path);
  if (isPublic) return next();
  verifyAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    apiRateLimiter(req, res, next);
  });
}
