import { LogLevel } from '@prisma/client';
import { prisma } from './db';
import { logger } from './logger';

export interface JobLogger {
  debug(message: string, metadata?: unknown): Promise<void>;
  info(message: string, metadata?: unknown): Promise<void>;
  warn(message: string, metadata?: unknown): Promise<void>;
  error(message: string, metadata?: unknown): Promise<void>;
}

/**
 * Structured job logger — writes JobLog rows tied to the current execution.
 * Failures to persist a log line are swallowed (logged to stdout) so a DB
 * hiccup can't crash job execution.
 */
export function createJobLogger(executionId: string): JobLogger {
  const write = async (level: LogLevel, message: string, metadata?: unknown): Promise<void> => {
    logger.log(level.toLowerCase() as 'info', message, { executionId });
    try {
      await prisma.jobLog.create({
        data: {
          executionId,
          level,
          message: message.slice(0, 4000),
          metadata: (metadata ?? undefined) as never,
        },
      });
    } catch (err) {
      logger.warn('Failed to persist job log', { message: (err as Error).message });
    }
  };

  return {
    debug: (m, md) => write('DEBUG', m, md),
    info: (m, md) => write('INFO', m, md),
    warn: (m, md) => write('WARN', m, md),
    error: (m, md) => write('ERROR', m, md),
  };
}
