import { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../db/client';

export interface MetricsPoint {
  bucket: string;
  completed: number;
  failed: number;
}

/**
 * Project metrics computed from real job/worker data.
 * Granularity buckets executions by hour or day over the requested window.
 */
export async function getProjectMetrics(
  projectId: string,
  opts: { from?: Date; to?: Date; granularity?: 'hour' | 'day' },
) {
  const to = opts.to ?? new Date();
  const from = opts.from ?? new Date(to.getTime() - (opts.granularity === 'day' ? 7 : 1) * 86_400_000);
  const bucket = opts.granularity === 'day' ? 'day' : 'hour';

  const queues = await prisma.queue.findMany({ where: { projectId }, select: { id: true } });
  const queueIds = queues.map((q) => q.id);

  if (queueIds.length === 0) {
    return { from, to, granularity: bucket, timeline: [], totals: emptyTotals(), queueDepths: [], workerHealth: [] };
  }

  // Time-bucketed completion/failure counts via raw SQL date_trunc
  const timeline = await prisma.$queryRaw<{ bucket: string; completed: bigint; failed: bigint }[]>`
    SELECT date_trunc(${bucket}, j.completed_at)::text AS bucket,
           COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::bigint AS completed,
           COUNT(*) FILTER (WHERE j.status IN ('FAILED','DEAD'))::bigint   AS failed
    FROM jobs j
    WHERE j.queue_id IN (${Prisma.join(queueIds)})
      AND COALESCE(j.completed_at, j.failed_at) BETWEEN ${from} AND ${to}
    GROUP BY 1 ORDER BY 1 ASC
  `;

  const statusCounts = await prisma.job.groupBy({
    by: ['status'],
    where: { queueId: { in: queueIds } },
    _count: { _all: true },
  });

  const durationAgg = await prisma.jobExecution.aggregate({
    where: { job: { queueId: { in: queueIds } }, status: 'COMPLETED', durationMs: { not: null } },
    _avg: { durationMs: true },
  });

  const counts: Record<string, number> = {};
  for (const s of statusCounts) counts[s.status] = s._count._all;

  const totalFinished =
    (counts[JobStatus.COMPLETED] ?? 0) + (counts[JobStatus.FAILED] ?? 0) + (counts[JobStatus.DEAD] ?? 0);

  const queueDepths = await prisma.queue.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      isPaused: true,
      _count: {
        select: {
          jobs: { where: { status: { in: [JobStatus.PENDING, JobStatus.SCHEDULED, JobStatus.RETRYING] } } },
        },
      },
    },
  });

  const workerHealth = await prisma.worker.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  return {
    from,
    to,
    granularity: bucket,
    timeline: timeline.map((t) => ({
      bucket: t.bucket,
      completed: Number(t.completed),
      failed: Number(t.failed),
    })),
    totals: {
      pending: counts[JobStatus.PENDING] ?? 0,
      scheduled: counts[JobStatus.SCHEDULED] ?? 0,
      running: counts[JobStatus.RUNNING] ?? 0,
      completed: counts[JobStatus.COMPLETED] ?? 0,
      failed: counts[JobStatus.FAILED] ?? 0,
      dead: counts[JobStatus.DEAD] ?? 0,
      cancelled: counts[JobStatus.CANCELLED] ?? 0,
      failureRate: totalFinished > 0 ? ((counts[JobStatus.FAILED] ?? 0) + (counts[JobStatus.DEAD] ?? 0)) / totalFinished : 0,
      avgDurationMs:
        durationAgg._avg.durationMs != null ? Math.round(durationAgg._avg.durationMs) : null,
    },
    queueDepths: queueDepths.map((q) => ({ id: q.id, name: q.name, isPaused: q.isPaused, depth: q._count.jobs })),
    workerHealth: workerHealth.map((w) => ({ status: w.status, count: w._count._all })),
  };
}

function emptyTotals() {
  return {
    pending: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    cancelled: 0,
    failureRate: 0,
    avgDurationMs: null,
  };
}
