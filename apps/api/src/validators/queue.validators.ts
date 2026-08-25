import { z } from 'zod';

export const createQueueSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  priority: z.number().int().min(1).max(10).default(5),
  concurrencyLimit: z.number().int().min(1).max(1000).default(10),
  rateLimitPerMin: z.number().int().min(1).max(1_000_000).nullable().optional(),
  retryPolicyId: z.string().uuid().nullable().optional(),
  shardKey: z.string().max(100).nullable().optional(),
});

export const updateQueueSchema = createQueueSchema.partial();

export const queueStatsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const listQueuesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  isPaused: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
