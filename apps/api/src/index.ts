import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { logger } from './utils/logger';
import { connectDb, disconnectDb, prisma } from './db/client';
import { connectRedis } from './utils/redis';
import { setupWebSocket } from './websocket';
import { startSchedulers } from './scheduler';

async function main(): Promise<void> {
  await connectDb();
  await prisma.$queryRaw`SELECT 1`; // fail fast if migrations missing
  await connectRedis();

  const app = createApp();
  const server = http.createServer(app);
  setupWebSocket(server);

  const schedulers = startSchedulers();

  server.listen(config.port, () => {
    logger.info(`API listening on :${config.port}`);
    logger.info(`AI summaries: ${config.openrouterApiKey ? `enabled (${config.openrouterModel})` : 'disabled (no OPENROUTER_API_KEY)'}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    schedulers.forEach((h) => h.stop());
    server.close(async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        /* db may already be gone */
      }
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
