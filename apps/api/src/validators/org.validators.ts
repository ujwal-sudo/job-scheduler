import { z } from 'zod';

export const idParamSchema = z.object({ id: z.string().uuid().or(z.string().cuid()).or(z.string().min(10)) });
export const queueIdParamSchema = z.object({ queueId: z.string().min(1) });
export const jobIdParamSchema = z.object({ jobId: z.string().min(1) });

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

export const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

export const createRetryPolicySchema = z.object({
  name: z.string().min(1).max(100),
  strategy: z.enum(['FIXED', 'LINEAR', 'EXPONENTIAL']).default('EXPONENTIAL'),
  maxAttempts: z.number().int().min(1).max(100).default(3),
  initialDelayMs: z.number().int().min(0).max(86_400_000).default(1000),
  maxDelayMs: z.number().int().min(0).max(86_400_000).default(3_600_000),
  multiplier: z.number().min(1).max(100).default(2),
});

export const updateRetryPolicySchema = createRetryPolicySchema.partial();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
