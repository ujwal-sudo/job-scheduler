import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/jobscheduler'),
  redisUrl: required('REDIS_URL', 'redis://127.0.0.1:6379'),
  apiBaseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:4000/api/v1',
  workerInternalToken: process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token',
  heartbeatIntervalMs: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? '10000', 10),
  defaultTimeoutMs: parseInt(process.env.WORKER_DEFAULT_TIMEOUT_MS ?? '30000', 10),
};
