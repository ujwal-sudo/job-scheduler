import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { withLock } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * Compute the next fire time for a cron expression in a given timezone.
 */
export function getNextCronDate(expression: string, timezone = 'UTC'): Date | null {
  if (!cron.validate(expression)) return null;
  const task = cron.schedule(expression, () => undefined, { scheduled: false, timezone });
  // node-cron 3.x exposes getNextRun() at runtime; its types lag behind.
  const next = (task as unknown as { getNextRun?: () => Date | null }).getNextRun?.() ?? null;
  task.stop();
  return next ?? null;
}

/**
 * Cron Runner — fires ScheduledJob rows whose nextRunAt is due.
 *
 * Idempotent across multiple API instances via a Redis Redlock per schedule:
 * only the lock holder creates the job and advances nextRunAt. A competing
 * instance skips to the next due schedule.
 */
export async function runCronSweep(): Promise<number> {
  const now = new Date();
  let fired = 0;

  // Re-check inside loop; fetch a small window of due schedules
  const due = await prisma.scheduledJob.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    take: 50,
    orderBy: { nextRunAt: 'asc' },
  });

  for (const schedule of due) {
    try {
      await withLock(`lock:cron:${schedule.id}`, 5000, async () => {
        // Double-check under lock — another instance may have just fired it
        const fresh = await prisma.scheduledJob.findUnique({ where: { id: schedule.id } });
        if (!fresh || !fresh.isActive || fresh.nextRunAt > new Date()) return;

        const job = await prisma.job.create({
          data: {
            queueId: fresh.queueId,
            type: fresh.jobType,
            payload: fresh.jobPayload as Prisma.InputJsonValue,
            priority: fresh.jobPriority,
            status: 'PENDING',
          },
        });

        const next = getNextCronDate(fresh.cronExpression, fresh.timezone) ??
          new Date(Date.now() + 60_000);

        await prisma.scheduledJob.update({
          where: { id: fresh.id },
          data: { lastRunAt: new Date(), lastJobId: job.id, nextRunAt: next },
        });
        fired += 1;
        logger.info('Cron fired', { scheduleId: fresh.id, jobId: job.id, nextRunAt: next });
      });
    } catch (err) {
      // Lock contention between API instances is normal — log at debug level
      logger.debug('Cron schedule skipped/failed', {
        scheduleId: schedule.id,
        message: (err as Error).message,
      });
    }
  }

  return fired;
}
