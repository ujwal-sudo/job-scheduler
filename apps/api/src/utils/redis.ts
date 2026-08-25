import Redis from 'ioredis';
import Redlock from 'redlock';
import { config } from '../config';
import { logger } from './logger';

declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

export const redis: Redis =
  global.__redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

if (process.env.NODE_ENV !== 'production') global.__redis = redis;

redis.on('error', (err) => logger.error('Redis error', { message: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
}

// ── Distributed locking (Redlock) ────────────────────────────────────────────
export const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 100,
});

redlock.on('error', (err) => {
  // Redlock emits errors when a lock fails to release etc. — log but don't crash.
  logger.warn('Redlock error', { message: err.message });
});

/** Run `fn` while holding an exclusive named lock. */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = await redlock.acquire([key], ttlMs);
  try {
    return await fn();
  } finally {
    try {
      await lock.release();
    } catch {
      // lock may have already expired — non-fatal
    }
  }
}

// ── Token bucket rate limiting (sliding window via sorted set) ───────────────
/**
 * Sliding-window rate limiter backed by Redis ZSET.
 * Works across multiple API instances (state lives in Redis, not memory).
 * Returns true when allowed, false when the caller exceeded `limit` in the window.
 */
export async function checkRateLimit(key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  const now = Date.now();
  const member = `${now}-${Math.random()}`;
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, '-inf', now - windowMs);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs);
  const results = await pipeline.exec();
  const count = Number(results?.[2]?.[1] ?? 0);
  return count <= limit;
}
