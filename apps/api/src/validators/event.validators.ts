import { z } from 'zod';

export const createEventSchema = z.object({
  name: z.string().min(1).max(200),
  payload: z.unknown(),
  source: z.string().max(200).optional(),
});

export const listEventsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  name: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const createTriggerSchema = z.object({
  queueId: z.string().uuid(),
  eventName: z.string().min(1).max(200),
  jobType: z.string().min(1).max(100),
  jobPayloadTmpl: z.unknown(),
  jobPriority: z.number().int().min(1).max(10).default(5),
});

export const updateTriggerSchema = z.object({
  isActive: z.boolean(),
});
