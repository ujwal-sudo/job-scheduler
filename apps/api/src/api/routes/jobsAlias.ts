import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { NotFoundError } from '../../utils/errors';

/** GET /api/v1/jobs/:jobId — canonical job detail without knowing the queue id. */
export const jobsAliasRouter = Router();
jobsAliasRouter.use(verifyAuth);

jobsAliasRouter.get('/:jobId', async (req: Request, res: Response) => {
  const exists = await prisma.job.findUnique({ where: { id: req.params.jobId }, select: { id: true } });
  if (!exists) throw new NotFoundError('Job');

  const detail = await prisma.job.findUnique({
    where: { id: req.params.jobId },
    include: {
      executions: {
        orderBy: { attemptNumber: 'desc' },
        include: {
          worker: { select: { id: true, hostname: true, pid: true } },
          logs: { orderBy: { timestamp: 'asc' }, take: 200 },
        },
      },
      dependsOn: { include: { dependencyJob: { select: { id: true, type: true, status: true } } } },
      dependedBy: { include: { dependentJob: { select: { id: true, type: true, status: true } } } },
      batch: { select: { id: true, name: true, status: true } },
      dlqEntry: { select: { id: true, reason: true, aiSummary: true, failedAt: true, lastError: true } },
      retryPolicy: true,
      worker: { select: { id: true, hostname: true } },
    },
  });
  res.json({ success: true, data: detail });
});
