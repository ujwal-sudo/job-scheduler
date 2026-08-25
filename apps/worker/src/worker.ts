import { JobWorker } from './loop';
import { registerHandlers } from './handlers';
import { logger } from './logger';
import { prisma, connectDb } from './db';
import os from 'os';

async function main(): Promise<void> {
  await connectDb();
  registerHandlers();

  const worker = new JobWorker({
    queueId: process.env.WORKER_QUEUE_ID || null,
    shardKey: process.env.WORKER_SHARD_KEY || null,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10),
    pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '2000', 10),
    hostname: os.hostname(),
    pid: process.pid,
    version: '1.0.0',
  });

  let force = false;
  const shutdown = (signal: string) => {
    if (force) {
      logger.warn(`${signal} again — forcing immediate exit`);
      process.exit(1);
    }
    force = true;
    logger.info(`${signal} received — graceful shutdown initiated`);
    worker.requestShutdown();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.start();
}

main().catch(async (err) => {
  logger.error('Worker fatal error', { message: (err as Error).message, stack: (err as Error).stack });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
