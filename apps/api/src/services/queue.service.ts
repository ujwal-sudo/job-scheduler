import { JobStatus } from '@prisma/client';
import { prisma } from '../db/client';

export interface QueueStats {
  pending: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  dead: number;
  depth: number; // pending + scheduled + retrying — work not yet done
  throughputPerMin: number;
  failureRate: number;
  avgDurationMs: number | null;
}

/** Live queue statistics computed from real job rows (no caching/mocks). */
export async function getQueueStats(queueId: string): Promise<QueueStats> {
  const grouped = await prisma.job.groupBy({
    by: ['status'],
    where: { queueId },
    _count: { _all: true },
  });

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;

  const since = new Date(Date.now() - 60_000);
  const [recentCompleted, recentFailed, durationAgg] = await Promise.all([
    prisma.job.count({ where: { queueId, status: JobStatus.COMPLETED, completedAt: { gte: since } } }),
    prisma.job.count({ where: { queueId, status: { in: [JobStatus.FAILED, JobStatus.DEAD] }, failedAt: { gte: since } } }),
    prisma.jobExecution.aggregate({
      where: { job: { queueId }, status: 'COMPLETED', durationMs: { not: null } },
      _avg: { durationMs: true },
    }),
  ]);

  const totalFinished = (counts[JobStatus.COMPLETED] ?? 0) + (counts[JobStatus.FAILED] ?? 0) + (counts[JobStatus.DEAD] ?? 0);

  return {
    pending: counts[JobStatus.PENDING] ?? 0,
    scheduled: counts[JobStatus.SCHEDULED] ?? 0,
    running: counts[JobStatus.RUNNING] ?? 0,
    completed: counts[JobStatus.COMPLETED] ?? 0,
    failed: counts[JobStatus.FAILED] ?? 0,
    dead: counts[JobStatus.DEAD] ?? 0,
    depth:
      (counts[JobStatus.PENDING] ?? 0) +
      (counts[JobStatus.SCHEDULED] ?? 0) +
      (counts[JobStatus.RETRYING] ?? 0),
    throughputPerMin: recentCompleted,
    failureRate: totalFinished > 0 ? ((counts[JobStatus.FAILED] ?? 0) + (counts[JobStatus.DEAD] ?? 0)) / totalFinished : 0,
    avgDurationMs: durationAgg._avg.durationMs != null ? Math.round(durationAgg._avg.durationMs) : null,
  };
}
