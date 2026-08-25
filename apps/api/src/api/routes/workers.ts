import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../../utils/errors';
import { config } from '../../config';
import {
  registerWorkerSchema,
  heartbeatSchema,
} from '../../validators/worker.validators';
import { registerWorker as registerWorkerSvc, heartbeat as heartbeatSvc } from '../../services/worker.service';

export const workersRouter = Router();

/** Worker-internal endpoints authenticate with a shared secret token. */
function requireWorkerToken(req: Request, _res: Response, next: (err?: unknown) => void): void {
  const header = req.headers['x-worker-token'];
  if (header !== config.workerInternalToken) return next(new UnauthorizedError('Invalid worker token'));
  next();
}

// POST /workers/register — worker self-registers on boot
workersRouter.post(
  '/register',
  requireWorkerToken,
  validate({ body: registerWorkerSchema }),
  async (req: Request, res: Response) => {
    const worker = await registerWorkerSvc(req.body);
    res.status(201).json({ success: true, data: { id: worker.id, registeredAt: worker.registeredAt } });
  },
);

// POST /workers/:workerId/heartbeat
workersRouter.post(
  '/:workerId/heartbeat',
  requireWorkerToken,
  validate({ body: heartbeatSchema }),
  async (req: Request, res: Response) => {
    const updated = await heartbeatSvc(req.params.workerId, req.body);
    res.json({ success: true, data: { id: updated.id, status: updated.status, lastHeartbeat: updated.lastHeartbeat } });
  },
);

// Everything below is for the dashboard — JWT + roles.
const dashboardRouter = Router();
dashboardRouter.use(verifyAuth);

dashboardRouter.get('/', async (_req: Request, res: Response) => {
  const workers = await prisma.worker.findMany({
    include: {
      queue: { select: { id: true, name: true } },
      jobs: { where: { status: { in: ['CLAIMED', 'RUNNING'] } }, select: { id: true } },
    },
    orderBy: { registeredAt: 'desc' },
    take: 200,
  });
  const cutoff = new Date(Date.now() - parseInt(process.env.DEAD_WORKER_THRESHOLD_MS ?? '60000', 10));
  res.json({
    success: true,
    data: workers.map((w) => ({
      id: w.id,
      hostname: w.hostname,
      pid: w.pid,
      version: w.version,
      status: w.lastHeartbeat < cutoff && w.status !== 'DEAD' ? 'DEAD' : w.status,
      concurrency: w.concurrency,
      shardKey: w.shardKey,
      queue: w.queue,
      jobsRunning: w.jobs.length,
      lastHeartbeat: w.lastHeartbeat,
      registeredAt: w.registeredAt,
    })),
  });
});

dashboardRouter.get('/:workerId', verifyAuth, async (req: Request, res: Response) => {
  const worker = await prisma.worker.findUnique({
    where: { id: req.params.workerId },
    include: {
      queue: { select: { id: true, name: true } },
      heartbeats: { orderBy: { timestamp: 'desc' }, take: 30 },
      jobs: {
        where: { workerId: req.params.workerId },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { id: true, type: true, status: true, priority: true, createdAt: true, completedAt: true },
      },
    },
  });
  if (!worker) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worker not found' } });
    return;
  }
  res.json({ success: true, data: worker });
});

// DRAINING = finish current jobs, accept no new ones
dashboardRouter.post('/:workerId/drain', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const worker = await prisma.worker.update({
    where: { id: req.params.workerId },
    data: { status: 'DRAINING' },
  }).catch(() => null);
  if (!worker) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worker not found' } });
    return;
  }
  res.json({ success: true, data: worker });
});

workersRouter.use('/', dashboardRouter);
