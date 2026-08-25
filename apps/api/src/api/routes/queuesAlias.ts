import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { NotFoundError } from '../../utils/errors';
import { getQueueStats } from '../../services/queue.service';

/**
 * Convenience aliases so the dashboard can address a queue directly:
 *   GET /api/v1/queues/:id
 *   GET /api/v1/queues/:id/stats
 */
export const queuesAliasRouter = Router();
queuesAliasRouter.use(verifyAuth);

async function loadQueue(id: string) {
  const queue = await prisma.queue.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, slug: true, orgId: true } },
      retryPolicy: true,
    },
  });
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

queuesAliasRouter.get('/:id', async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.id);
  res.json({ success: true, data: { ...queue, stats: await getQueueStats(queue.id) } });
});

queuesAliasRouter.get('/:id/stats', async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.id);
  const to = new Date();
  const from = new Date(to.getTime() - 86_400_000);

  const timeline = await prisma.$queryRaw<{ bucket: string; completed: bigint; failed: bigint }[]>`
    SELECT date_trunc('hour', COALESCE(j.completed_at, j.failed_at))::text AS bucket,
           COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::bigint AS completed,
           COUNT(*) FILTER (WHERE j.status IN ('FAILED','DEAD'))::bigint AS failed
    FROM jobs j
    WHERE j.queue_id = ${queue.id} AND COALESCE(j.completed_at, j.failed_at) BETWEEN ${from} AND ${to}
    GROUP BY 1 ORDER BY 1 ASC
  `;

  res.json({
    success: true,
    data: {
      live: await getQueueStats(queue.id),
      timeline: timeline.map((t) => ({
        bucket: t.bucket,
        completed: Number(t.completed),
        failed: Number(t.failed),
      })),
      from,
      to,
    },
  });
});
