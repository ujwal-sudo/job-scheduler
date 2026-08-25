import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError, BadRequestError } from '../../utils/errors';
import { createScheduleSchema, updateScheduleSchema } from '../../validators/job.validators';
import { getNextCronDate } from '../../scheduler/cronRunner';

export const schedulesRouter = Router({ mergeParams: true });
schedulesRouter.use(verifyAuth);

async function loadQueue(queueId: string) {
  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) throw new NotFoundError('Queue');
  return queue;
}

async function loadSchedule(scheduleId: string) {
  const schedule = await prisma.scheduledJob.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new NotFoundError('Schedule');
  return schedule;
}

function withComputedNext<T extends { cronExpression: string; timezone: string; nextRunAt: Date; isActive: boolean }>(s: T) {
  return {
    ...s,
    nextRunAt: s.isActive ? (getNextCronDate(s.cronExpression, s.timezone) ?? s.nextRunAt) : null,
  };
}

schedulesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createScheduleSchema }),
  async (req: Request, res: Response) => {
    const queue = await loadQueue(req.params.queueId);
    const body = req.body as {
      name: string; cronExpression: string; jobType: string;
      jobPayload: unknown; jobPriority?: number; timezone?: string;
    };

    if (!require('node-cron').validate(body.cronExpression)) {
      throw new BadRequestError(`Invalid cron expression: ${body.cronExpression}`);
    }
    const next = getNextCronDate(body.cronExpression, body.timezone ?? 'UTC');
    if (!next) throw new BadRequestError(`Invalid cron expression or timezone`);

    const schedule = await prisma.scheduledJob.create({
      data: {
        queueId: queue.id,
        name: body.name,
        cronExpression: body.cronExpression,
        jobType: body.jobType,
        jobPayload: body.jobPayload as Prisma.InputJsonValue,
        jobPriority: body.jobPriority ?? 5,
        timezone: body.timezone ?? 'UTC',
        nextRunAt: next,
      },
    });
    res.status(201).json({ success: true, data: schedule });
  },
);

schedulesRouter.get('/', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const queue = await loadQueue(req.params.queueId);
  const schedules = await prisma.scheduledJob.findMany({
    where: { queueId: queue.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: schedules.map(withComputedNext) });
});

schedulesRouter.get('/:scheduleId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  await loadQueue(req.params.queueId);
  const schedule = await loadSchedule(req.params.scheduleId);
  res.json({ success: true, data: withComputedNext(schedule) });
});

schedulesRouter.patch(
  '/:scheduleId',
  requireRole('ADMIN'),
  validate({ body: updateScheduleSchema }),
  async (req: Request, res: Response) => {
    await loadQueue(req.params.queueId);
    const existing = await loadSchedule(req.params.scheduleId);
    const body = req.body as { cronExpression?: string; isActive?: boolean; jobPayload?: unknown; name?: string };

    let nextRunAt = existing.nextRunAt;
    if (body.cronExpression && require('node-cron').validate(body.cronExpression)) {
      nextRunAt =
        getNextCronDate(body.cronExpression, existing.timezone) ??
        new Date(Date.now() + 60_000);
    }

    const updated = await prisma.scheduledJob.update({
      where: { id: existing.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.cronExpression ? { cronExpression: body.cronExpression, nextRunAt } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.jobPayload !== undefined
          ? { jobPayload: (body.jobPayload ?? Prisma.JsonNull) as Prisma.InputJsonValue }
          : {}),
      },
    });
    res.json({ success: true, data: updated });
  },
);

schedulesRouter.delete('/:scheduleId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  await loadQueue(req.params.queueId);
  const schedule = await loadSchedule(req.params.scheduleId);
  await prisma.scheduledJob.delete({ where: { id: schedule.id } });
  res.json({ success: true, data: { deleted: true } });
});

// Manual trigger — creates a job immediately
schedulesRouter.post('/:scheduleId/trigger', requireRole('MEMBER'), async (req: Request, res: Response) => {
  await loadQueue(req.params.queueId);
  const schedule = await loadSchedule(req.params.scheduleId);

  const job = await prisma.job.create({
    data: {
      queueId: schedule.queueId,
      type: schedule.jobType,
      payload: schedule.jobPayload as Prisma.InputJsonValue,
      priority: schedule.jobPriority,
      status: 'PENDING',
      metadata: { triggeredBy: 'manual', scheduleId: schedule.id },
    },
  });

  await prisma.scheduledJob.update({
    where: { id: schedule.id },
    data: { lastRunAt: new Date(), lastJobId: job.id },
  });

  res.status(201).json({ success: true, data: job });
});
