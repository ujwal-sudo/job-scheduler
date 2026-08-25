import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import {
  createEventSchema,
  listEventsQuery,
  createTriggerSchema,
  updateTriggerSchema,
} from '../../validators/event.validators';
import { processEvent } from '../../services/event.service';
import { parsePagination } from '../../services/job.service';

export const eventsRouter = Router();
eventsRouter.use(verifyAuth);

// Fire an event → matching active triggers → jobs created
eventsRouter.post(
  '/',
  requireRole('MEMBER'),
  validate({ body: createEventSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as { name: string; payload: unknown; source?: string };
    const result = await processEvent(body.name, body.payload, body.source);
    res.status(201).json({
      success: true,
      data: {
        event: result.event,
        triggeredJobIds: result.triggeredJobIds,
        triggeredCount: result.triggeredJobIds.length,
      },
    });
  },
);

eventsRouter.get(
  '/',
  requireRole('VIEWER'),
  validate({ query: listEventsQuery }),
  async (req: Request, res: Response) => {
    const { page, limit, skip, take } = parsePagination(req.query);
    const where = {
      ...(req.query.name ? { name: String(req.query.name) } : {}),
      ...((req.query.from || req.query.to) && {
        createdAt: {
          ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
          ...(req.query.to ? { lte: new Date(String(req.query.to)) } : {}),
        },
      }),
    };
    const [total, events] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    ]);
    res.json({
      success: true,
      data: events,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  },
);

async function loadEvent(eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new NotFoundError('Event');
  return event;
}

// Event detail with the jobs it triggered
eventsRouter.get('/:eventId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const event = await loadEvent(req.params.eventId);
  const jobs = event.triggeredJobIds.length
    ? await prisma.job.findMany({
        where: { id: { in: event.triggeredJobIds } },
        select: { id: true, type: true, status: true, priority: true, queueId: true, createdAt: true },
      })
    : [];
  res.json({ success: true, data: { ...event, jobs } });
});

// ── Event triggers CRUD ──────────────────────────────────────────────────────
const triggersRouter = Router();
triggersRouter.use(verifyAuth);

triggersRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createTriggerSchema }),
  async (req: Request, res: Response) => {
    const trigger = await prisma.eventTrigger.create({
      data: {
        queueId: req.body.queueId,
        eventName: req.body.eventName,
        jobType: req.body.jobType,
        jobPayloadTmpl: req.body.jobPayloadTmpl,
        jobPriority: req.body.jobPriority ?? 5,
      },
    });
    res.status(201).json({ success: true, data: trigger });
  },
);

triggersRouter.get('/', requireRole('VIEWER'), async (_req: Request, res: Response) => {
  const triggers = await prisma.eventTrigger.findMany({
    include: { queue: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ success: true, data: triggers });
});

triggersRouter.patch(
  '/:id',
  requireRole('ADMIN'),
  validate({ body: updateTriggerSchema }),
  async (req: Request, res: Response) => {
    const updated = await prisma.eventTrigger.update({
      where: { id: req.params.id },
      data: { isActive: req.body.isActive },
    });
    res.json({ success: true, data: updated });
  },
);

triggersRouter.delete('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  await prisma.eventTrigger.delete({ where: { id: req.params.id } });
  res.json({ success: true, data: { deleted: true } });
});

eventsRouter.use('/triggers', triggersRouter);
