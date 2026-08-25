import { prisma } from '../db/client';
import { emitJobUpdate } from '../websocket/emitter';
import { logger } from '../utils/logger';

/**
 * Delayed/Retry Promoter.
 *
 * Flips jobs that are past their run_at into PENDING so the claim query can
 * pick them up:
 * - SCHEDULED → PENDING  (delayed jobs whose time has come)
 * - RETRYING → PENDING   (failed jobs whose retry delay elapsed)
 *
 * Runs on a short interval; the claim query also re-checks run_at so a
 * slightly stale promotion can never cause premature execution.
 */
export async function promoteDelayedJobs(): Promise<number> {
  const now = new Date();

  const promoted = await prisma.job.updateMany({
    where: { status: 'SCHEDULED', runAt: { lte: now } },
    data: { status: 'PENDING' },
  });

  const retriable = await prisma.job.updateMany({
    where: { status: 'RETRYING', runAt: { lte: now } },
    data: { status: 'PENDING' },
  });

  const total = promoted.count + retriable.count;
  if (total > 0) {
    logger.info('Promoted delayed/retrying jobs', { scheduled: promoted.count, retrying: retriable.count });
    const ids = await prisma.job.findMany({
      where: { status: 'PENDING', runAt: { lte: now }, updatedAt: { gte: new Date(now.getTime() - 5000) } },
      select: { id: true, queueId: true },
      take: 100,
    });
    for (const j of ids) emitJobUpdate(j.queueId, j.id, 'PENDING');
  }
  return total;
}
