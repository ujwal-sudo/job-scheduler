import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../../utils/redis';
import { config } from '../../config';
import { TooManyRequestsError } from '../../utils/errors';

/**
 * Per-identity API rate limiter backed by Redis (works across instances).
 * Identity = user id when authenticated, else client IP.
 */
export function apiRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  const identity = req.user?.sub ?? req.ip ?? 'anonymous';
  checkRateLimit(`ratelimit:api:${identity}`, config.apiRateLimitPerMin)
    .then((allowed) => {
      if (!allowed) return next(new TooManyRequestsError('API rate limit exceeded (100 req/min)'));
      next();
    })
    .catch(() => next()); // fail-open: never take the API down because Redis hiccups
}
