import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });
dotenv.config({});

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.API_PORT ?? '4000', 10),
  databaseUrl: required('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/jobscheduler'),
  redisUrl: required('REDIS_URL', 'redis://127.0.0.1:6379'),
  jwtSecret: required('JWT_SECRET', 'dev-jwt-secret-change-me'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET', 'dev-jwt-refresh-secret-change-me'),
  accessTokenTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshTokenTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  workerInternalToken: process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token',
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  openrouterModel: process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  // Scheduler intervals (ms)
  cronRunnerIntervalMs: parseInt(process.env.CRON_RUNNER_INTERVAL_MS ?? '60000', 10),
  delayedPromoterIntervalMs: parseInt(process.env.DELAYED_PROMOTER_INTERVAL_MS ?? '15000', 10),
  deadReaperIntervalMs: parseInt(process.env.DEAD_REAPER_INTERVAL_MS ?? '30000', 10),
  dependencyCheckerIntervalMs: parseInt(process.env.DEPENDENCY_CHECKER_INTERVAL_MS ?? '10000', 10),
  deadWorkerThresholdMs: parseInt(process.env.DEAD_WORKER_THRESHOLD_MS ?? '60000', 10),
  // Rate limiting
  apiRateLimitPerMin: parseInt(process.env.API_RATE_LIMIT_PER_MIN ?? '100', 10),
};
