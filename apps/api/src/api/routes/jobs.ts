import { Router, Request, Response } from 'express';
import { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError, BadRequestError } from '../../utils/errors';
import { createJobSchema, listJobsQuery } from '../../validators/job.validators';
import { createJobs, retryJob, parsePagination } from '../../services/job.service';
import { checkRateLimit } from '../../utils/redis';

export const jobsRouter = Router({ mergeParams: true });
jobsRouter.use(verifyAuth);

async function loadQueue(queueId: string) {
  const queue = await prisma.queue.findUnique({ where: { id: queueId }, include: { project: true } });
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

async function loadJob(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { queue: { select: { id: true, projectId: true } } } });
  if (!job) throw new NotFoundError('Job');
  return job;
}

// ── Create job (immediate / delayed / batch / idempotent / dependencies) ────
jobsRouter.post(
  '/',
  requireRole('MEMBER'),
  validate({ body: createJobSchema }),
  async (req: Request, res: Response) => {
    const queue = await loadQueue(req.params.queueId);
    const result = await createJobs(queue.id, req.body);
    res.status(201).json({ success: true, data: result });
  },
);

// ── List jobs with filters + pagination + sort ──────────────────────────────
jobsRouter.get(
  '/',
  requireRole('VIEWER'),
  validate({ query: listJobsQuery }),
  async (req: Request, res: Response) => {
    const queue = await loadQueue(req.params.queueId);
    const { page, limit, skip, take } = parsePagination(req.query);
    const [sortFieldRaw, sortDirRaw] = String(req.query.sort ?? 'createdAt:desc').split(':');
    const sortField = sortFieldRaw as 'createdAt' | 'priority' | 'runAt';
    const sortDir: Prisma.SortOrder = sortDirRaw === 'asc' ? 'asc' : 'desc';

    const statuses = req.query.status
      ? String(req.query.status)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s): s is JobStatus => s in JobStatus)
      : undefined;

    const tags = req.query.tags ? String(req.query.tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined;

    const where: Prisma.JobWhereInput = {
      queueId: queue.id,
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(req.query.type ? { type: String(req.query.type) } : {}),
      ...(tags?.length ? { tags: { hasSome: tags } } : {}),
      ...((req.query.from || req.query.to) && {
        createdAt: {
          ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
          ...(req.query.to ? { lte: new Date(String(req.query.to)) } : {}),
        },
      }),
    };

    const [total, jobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where,
        orderBy: [{ [sortField]: sortDir }],
        skip,
        take,
        select: {
          id: true, type: true, status: true, priority: true, runAt: true,
          startedAt: true, completedAt: true, failedAt: true, attemptCount: true,
          maxAttempts: true, tags: true, workerId: true, parentBatchId: true,
          createdAt: true, updatedAt: true,
        },
      }),
    ]);

    res.json({
      success: true,
      data: jobs,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  },
);

jobsRouter.get('/:jobId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const job = await loadJob(req.params.jobId);
  const detail = await prisma.job.findUnique({
    where: { id: job.id },
    include: {
      executions: {
        orderBy: { attemptNumber: 'desc' },
        include: { worker: { select: { id: true, hostname: true, pid: true } } },
      },
      dependsOn: { include: { dependencyJob: { select: { id: true, type: true, status: true } } } },
      dependedBy: { include: { dependentJob: { select: { id: true, type: true, status: true } } } },
      batch: { select: { id: true, name: true, status: true } },
      dlqEntry: { select: { id: true, reason: true, aiSummary: true, failedAt: true } },
      retryPolicy: true,
      worker: { select: { id: true, hostname: true } },
    },
  });
  res.json({ success: true, data: detail });
});

// Cancel — only before a job has been claimed
jobsRouter.delete('/:jobId', requireRole('MEMBER'), async (req: Request, res: Response) => {
  const job = await loadJob(req.params.jobId);
  const cancellable: string[] = [JobStatus.PENDING, JobStatus.SCHEDULED, JobStatus.RETRYING];
  if (!cancellable.includes(job.status)) {
    throw new BadRequestError(`Cannot cancel a ${job.status} job`);
  }
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: { status: JobStatus.CANCELLED },
  });
  res.json({ success: true, data: { id: updated.id, status: updated.status } });
});

// Manual retry of a finished/failed job
jobsRouter.post('/:jobId/retry', requireRole('MEMBER'), async (req: Request, res: Response) => {
  await loadJob(req.params.jobId); // existence + 404 semantics
  const result = await retryJob(req.params.jobId);
  res.json({ success: true, data: result });
});

jobsRouter.get('/:jobId/executions', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const job = await loadJob(req.params.jobId);
  const executions = await prisma.jobExecution.findMany({
    where: { jobId: job.id },
    orderBy: { attemptNumber: 'desc' },
  });
  res.json({ success: true, data: executions });
});

jobsRouter.get(
  '/:jobId/executions/:execId/logs',
  requireRole('VIEWER'),
  async (req: Request, res: Response) => {
    const job = await loadJob(req.params.jobId);
    const exec = await prisma.jobExecution.findFirst({
      where: { id: req.params.execId, jobId: job.id },
    });
    if (!exec) throw new NotFoundError('Execution');
    const logs = await prisma.jobLog.findMany({
      where: { executionId: exec.id },
      orderBy: { timestamp: 'asc' },
      take: 500,
    });
    res.json({ success: true, data: logs });
  },
);
