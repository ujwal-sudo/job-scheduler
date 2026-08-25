import { prisma } from '../db/client';
import { emitJobUpdate } from '../websocket/emitter';
import { logger } from '../utils/logger';

const DEAD_THRESHOLD_MS = parseInt(process.env.DEAD_WORKER_THRESHOLD_MS ?? '60000', 10);

/**
 * Dead Worker Reaper.
 *
 * Workers silent beyond the threshold are marked DEAD and their in-flight
 * jobs (CLAIMED/RUNNING) are re-queued as PENDING so no work is lost when a
 * worker process dies mid-job. The job keeps its attemptCount — an attempt
 * that vanished counts toward maxAttempts to avoid poison-pill loops.
 */
export async function reapDeadWorkers(): Promise<{ deadWorkers: number; recoveredJobs: number }> {
  const cutoff = new Date(Date.now() - DEAD_THRESHOLD_MS);

  const stale = await prisma.worker.findMany({
    where: { status: { in: ['ACTIVE', 'IDLE', 'DRAINING'] }, lastHeartbeat: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return { deadWorkers: 0, recoveredJobs: 0 };

  const now = new Date();
  let recoveredJobs = 0;

  for (const worker of stale) {
    const orphaned = await prisma.job.findMany({
      where: {
        workerId: worker.id,
        status: { in: ['CLAIMED', 'RUNNING'] },
      },
      select: { id: true, queueId: true },
    });

    await prisma.$transaction([
      prisma.worker.update({ where: { id: worker.id }, data: { status: 'DEAD' } }),
      ...(orphaned.length
        ? [
            prisma.job.updateMany({
              where: { id: { in: orphaned.map((j) => j.id) } },
              data: { status: 'PENDING', workerId: null, claimedAt: null },
            }),
          ]
        : []),
    ]);

    // Mark their RUNNING executions abandoned
    if (orphaned.length) {
      await prisma.jobExecution.updateMany({
        where: { workerId: worker.id, status: 'RUNNING' },
        data: { status: 'CANCELLED', completedAt: now, error: 'Worker died — execution abandoned' },
      });
      for (const j of orphaned) emitJobUpdate(j.queueId, j.id, 'PENDING');
      recoveredJobs += orphaned.length;
      logger.warn('Recovered jobs from dead worker', { workerId: worker.id, jobs: orphaned.length });
    }
  }

  return { deadWorkers: stale.length, recoveredJobs };
}
