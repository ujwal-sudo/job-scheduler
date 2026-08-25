import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import { createQueueSchema, updateQueueSchema, listQueuesQuery, queueStatsQuery } from '../../validators/queue.validators';
import { slugifyName, parsePagination } from '../../services/job.service';
import { getQueueStats } from '../../services/queue.service';

export const queuesRouter = Router({ mergeParams: true });
queuesRouter.use(verifyAuth);

async function loadProject(req: Request) {
  const project = await prisma.project.findFirst({
    where: { OR: [{ id: req.params.projectId }, { slug: req.params.projectId }] },
  });
  if (!project) throw new NotFoundError('Project');
  return project;
}

async function loadQueue(queueId: string) {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    include: {
      project: { select: { id: true, name: true, slug: true, orgId: true } },
      retryPolicy: true,
    },
  });
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

queuesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createQueueSchema }),
  async (req: Request, res: Response) => {
    const project = await loadProject(req);
    const base = slugifyName(req.body.name);
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const clash = await prisma.queue.findUnique({ where: { projectId_slug: { projectId: project.id, slug } } });
      if (!clash) break;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    if (req.body.retryPolicyId) {
      const policy = await prisma.retryPolicy.findFirst({
        where: { id: req.body.retryPolicyId, projectId: project.id },
      });
      if (!policy) throw new NotFoundError('Retry policy');
    }
    const queue = await prisma.queue.create({
      data: { ...req.body, projectId: project.id, slug },
    });
    res.status(201).json({ success: true, data: queue });
  },
);

// List queues with live stats
queuesRouter.get(
  '/',
  requireRole('VIEWER'),
  validate({ query: listQueuesQuery }),
  async (req: Request, res: Response) => {
    const project = await loadProject(req);
    const { page, limit, skip, take } = parsePagination(req.query);
    const where = {
      projectId: project.id,
      ...(typeof req.query.isPaused === 'boolean' ? { isPaused: req.query.isPaused as boolean } : {}),
    };

    const [total, queues] = await Promise.all([
      prisma.queue.count({ where }),
      prisma.queue.findMany({ where, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], skip, take }),
    ]);

    const withStats = await Promise.all(
      queues.map(async (q) => ({ ...q, stats: await getQueueStats(q.id) })),
    );

    res.json({
      success: true,
      data: withStats,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  },
);

queuesRouter.get('/:queueId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.queueId);
  res.json({ success: true, data: { ...queue, stats: await getQueueStats(queue.id) } });
});

queuesRouter.patch(
  '/:queueId',
  requireRole('ADMIN'),
  validate({ body: updateQueueSchema }),
  async (req: Request, res: Response) => {
    const queue = await loadQueue(req.params.queueId);
    const updated = await prisma.queue.update({ where: { id: queue.id }, data: req.body });
    res.json({ success: true, data: updated });
  },
);

queuesRouter.delete('/:queueId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.queueId);
  await prisma.queue.delete({ where: { id: queue.id } });
  res.json({ success: true, data: { deleted: true } });
});

queuesRouter.post('/:queueId/pause', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.queueId);
  const updated = await prisma.queue.update({ where: { id: queue.id }, data: { isPaused: true } });
  res.json({ success: true, data: updated });
});

queuesRouter.post('/:queueId/resume', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.queueId);
  const updated = await prisma.queue.update({ where: { id: queue.id }, data: { isPaused: false } });
  res.json({ success: true, data: updated });
});

// Throughput/failure/duration over a time range — real aggregations
queuesRouter.get(
  '/:queueId/stats',
  requireRole('VIEWER'),
  validate({ query: queueStatsQuery }),
  async (req: Request, res: Response) => {
    const queue = await loadQueue(req.params.queueId);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 86_400_000);

    const timeline = await prisma.$queryRaw<{ bucket: string; completed: bigint; failed: bigint; avg_duration_ms: number | null }[]>`
      SELECT date_trunc('hour', COALESCE(j.completed_at, j.failed_at))::text AS bucket,
             COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::bigint AS completed,
             COUNT(*) FILTER (WHERE j.status IN ('FAILED','DEAD'))::bigint AS failed,
             AVG(EXTRACT(EPOCH FROM (j.completed_at - j.started_at)) * 1000)::float AS avg_duration_ms
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
          avgDurationMs: t.avg_duration_ms != null ? Math.round(t.avg_duration_ms) : null,
        })),
        from,
        to,
      },
    });
  },
);
