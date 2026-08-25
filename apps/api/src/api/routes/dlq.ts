import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import { paginationQuery } from '../../validators/org.validators';
import { retryDlqEntry, resolveDlqEntry } from '../../services/dlq.service';

export const dlqRouter = Router({ mergeParams: true });
dlqRouter.use(verifyAuth);

async function loadQueue(queueId: string) {
  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

// GET /dlq?isResolved=false&page&limit
dlqRouter.get(
  '/',
  requireRole('VIEWER'),
  validate({ query: paginationQuery }),
  async (req: Request, res: Response) => {
    await loadQueue(req.params.queueId);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const isResolved =
      req.query.isResolved === undefined ? undefined : String(req.query.isResolved) === 'true';

    const where = {
      queueId: req.params.queueId,
      ...(isResolved !== undefined ? { isResolved } : {}),
    };

    const [total, entries] = await Promise.all([
      prisma.deadLetterQueue.count({ where }),
      prisma.deadLetterQueue.findMany({
        where,
        orderBy: { failedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          job: {
            select: {
              id: true, type: true, status: true, attemptCount: true, maxAttempts: true,
              tags: true, createdAt: true, timeoutMs: true,
            },
          },
        },
      }),
    ]);

    res.json({
      success: true,
      data: entries,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  },
);

async function loadEntry(entryId: string) {
  const entry = await prisma.deadLetterQueue.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('DLQ entry');
  return entry;
}

dlqRouter.get('/:entryId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const entry = await loadEntry(req.params.entryId);
  if (entry.queueId !== req.params.queueId) throw new NotFoundError('DLQ entry');

  const [job, executions] = await Promise.all([
    prisma.job.findUnique({
      where: { id: entry.jobId },
      include: { retryPolicy: true, batch: { select: { id: true, name: true } } },
    }),
    prisma.jobExecution.findMany({
      where: { jobId: entry.jobId },
      orderBy: { attemptNumber: 'asc' },
      select: {
        id: true, attemptNumber: true, startedAt: true, completedAt: true,
        durationMs: true, status: true, error: true,
      },
    }),
  ]);

  res.json({ success: true, data: { ...entry, job, executions } });
});

dlqRouter.post('/:entryId/retry', requireRole('MEMBER'), async (req: Request, res: Response) => {
  const entry = await loadEntry(req.params.entryId);
  if (entry.queueId !== req.params.queueId) throw new NotFoundError('DLQ entry');
  const result = await retryDlqEntry(entry.id, req.user?.sub);
  res.json({ success: true, data: result });
});

dlqRouter.post('/:entryId/resolve', requireRole('MEMBER'), async (req: Request, res: Response) => {
  const entry = await loadEntry(req.params.entryId);
  if (entry.queueId !== req.params.queueId) throw new NotFoundError('DLQ entry');
  const updated = await resolveDlqEntry(entry.id, req.user?.sub);
  res.json({ success: true, data: updated });
});

dlqRouter.delete('/:entryId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const entry = await loadEntry(req.params.entryId);
  if (entry.queueId !== req.params.queueId) throw new NotFoundError('DLQ entry');
  await prisma.deadLetterQueue.delete({ where: { id: entry.id } });
  res.json({ success: true, data: { deleted: true } });
});
