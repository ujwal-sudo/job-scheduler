import { z } from 'zod';

const jsonValue: z.ZodType<unknown> = z.unknown();

export const batchJobSchema = z.object({
  name: z.string().min(1).max(100),
  jobs: z
    .array(
      z.object({
        payload: jsonValue,
        priority: z.number().int().min(1).max(10).optional(),
        runAt: z.coerce.date().optional(),
        tags: z.array(z.string()).optional(),
        metadata: jsonValue.optional(),
        maxAttempts: z.number().int().min(1).max(100).optional(),
        timeoutMs: z.number().int().min(1000).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export const createJobSchema = z.object({
  type: z.string().min(1).max(100),
  payload: jsonValue,
  priority: z.number().int().min(1).max(10).default(5),
  runAt: z.coerce.date().optional(),
  batch: batchJobSchema.optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  dependsOn: z.array(z.string().min(1)).max(50).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  metadata: jsonValue.optional(),
  status: z.enum(['PENDING', 'SCHEDULED']).optional(),
});

export const listJobsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(), // CSV of statuses, e.g. "FAILED,DEAD"
  type: z.string().optional(),
  tags: z.string().optional(), // CSV of tags
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z
    .string()
    .regex(/^(createdAt|priority|runAt):(asc|desc)$/)
    .default('createdAt:desc'),
});

export const createScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  cronExpression: z.string().min(9).max(100),
  jobType: z.string().min(1).max(100),
  jobPayload: jsonValue,
  jobPriority: z.number().int().min(1).max(10).default(5),
  timezone: z.string().default('UTC'),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  cronExpression: z.string().min(9).max(100).optional(),
  isActive: z.boolean().optional(),
  jobPayload: jsonValue.optional(),
});
