import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { NotFoundError } from '../../utils/errors';
import { getProjectMetrics } from '../../services/metrics.service';

export const metricsRouter = Router({ mergeParams: true });
metricsRouter.use(verifyAuth);

async function loadProject(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { OR: [{ id: projectId }, { slug: projectId }] },
  });
  if (!project) throw new NotFoundError('Project');
  return project;
}

// GET /metrics?from&to&granularity=hour|day
metricsRouter.get('/', requireRole('VIEWER'), async (req: Request, res: Response) => {
    const project = await loadProject(req.params.projectId);
    const granularity = req.query.granularity === 'day' ? 'day' : 'hour';
    const metrics = await getProjectMetrics(project.id, {
      from: req.query.from ? new Date(String(req.query.from)) : undefined,
      to: req.query.to ? new Date(String(req.query.to)) : undefined,
      granularity,
    });
    res.json({ success: true, data: metrics });
});

// Worker fleet health — org-wide
metricsRouter.get('/workers', requireRole('VIEWER'), async (req: Request, res: Response) => {
  await loadProject(req.params.projectId);
  const cutoff = new Date(Date.now() - parseInt(process.env.DEAD_WORKER_THRESHOLD_MS ?? '60000', 10));
  const workers = await prisma.worker.findMany({
    orderBy: { lastHeartbeat: 'desc' },
    take: 100,
    select: {
      id: true, hostname: true, pid: true, status: true, concurrency: true,
      shardKey: true, queue: { select: { id: true, name: true } },
      lastHeartbeat: true,
      _count: { select: { jobs: { where: { status: { in: ['CLAIMED', 'RUNNING'] } } } } },
    },
  });
  res.json({
    success: true,
    data: workers.map((w) => ({
      ...w,
      effectiveStatus:
        w.status !== 'DEAD' && w.lastHeartbeat < cutoff ? 'DEAD' : w.status,
      jobsRunning: w._count.jobs,
    })),
  });
});
