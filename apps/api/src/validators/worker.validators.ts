import { z } from 'zod';

export const registerWorkerSchema = z.object({
  queueId: z.string().uuid().nullable().optional(),
  hostname: z.string().min(1).max(255),
  pid: z.number().int(),
  version: z.string().optional(),
  concurrency: z.number().int().min(1).max(1000).default(5),
  shardKey: z.string().max(100).nullable().optional(),
  metadata: z.unknown().nullable().optional(),
});

export const heartbeatSchema = z.object({
  status: z.enum(['ACTIVE', 'IDLE', 'DEAD', 'DRAINING']).default('ACTIVE'),
  jobsRunning: z.number().int().min(0).default(0),
  jobsDone: z.number().int().min(0).default(0),
  memoryMb: z.number().nullable().optional(),
  cpuPercent: z.number().nullable().optional(),
});
