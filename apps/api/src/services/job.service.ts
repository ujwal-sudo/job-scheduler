import { Prisma, JobStatus } from '@prisma/client';
import { prisma } from '../db/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { emitJobUpdate } from '../websocket/emitter';
import { logger } from '../utils/logger';

export interface CreateJobInput {
  type: string;
  payload: unknown;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  timeoutMs?: number;
  tags?: string[];
  metadata?: unknown;
  idempotencyKey?: string;
  dependsOn?: string[];
}

export interface CreateJobResult {
  job: { id: string; status: JobStatus; idempotencyKey?: string | null };
  batch?: { id: string; name: string; totalJobs: number };
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Create one or more jobs.
 *
 * Handles every job shape from the PRD:
 * - immediate        → PENDING, runAt null
 * - delayed          → SCHEDULED with future runAt (promoter flips to PENDING)
 * - batch            → BatchJob row + N Job rows in ONE transaction
 * - idempotencyKey   → duplicate submissions return the original job (409-free)
 * - dependsOn        → JobDependency rows; eligibility enforced atomically in claim SQL
 */
export async function createJobs(queueId: string, input: CreateJobInput & { batch?: { name: string; jobs: Array<Partial<CreateJobInput>> } }): Promise<CreateJobResult> {
  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) throw new NotFoundError('Queue');

  const resolveMaxAttempts = async (explicit?: number): Promise<number> => {
    if (explicit) return explicit;
    if (queue.retryPolicyId) {
      const policy = await prisma.retryPolicy.findUnique({ where: { id: queue.retryPolicyId } });
      if (policy) return policy.maxAttempts;
    }
    return 3;
  };

  // ── Idempotency: same key returns the existing job instead of duplicating ──
  if (input.idempotencyKey) {
    const existing = await prisma.job.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true, idempotencyKey: true },
    });
    if (existing) return { job: existing };
  }

  // Validate dependency targets exist before creating anything
  let dependencyIds: string[] = [];
  if (input.dependsOn?.length) {
    const deps = await prisma.job.findMany({
      where: { id: { in: input.dependsOn } },
      select: { id: true },
    });
    if (deps.length !== input.dependsOn.length) throw new BadRequestError('One or more dependsOn job ids do not exist');
    dependencyIds = deps.map((d) => d.id);
  }

  // ── Batch path ────────────────────────────────────────────────────────────
  if (input.batch) {
    const { name, jobs: subJobs } = input.batch;
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.batchJob.create({
        data: {
          queueId,
          name,
          totalJobs: subJobs.length,
          status: 'RUNNING',
        },
      });

      const baseMax = await resolveMaxAttempts(input.maxAttempts);

      // Idempotent batches: prefix each member key so re-submission is safe
      for (const [i, sj] of subJobs.entries()) {
        const status: JobStatus = sj.runAt && sj.runAt > new Date() ? 'SCHEDULED' : 'PENDING';
        await tx.job.create({
          data: {
            queueId,
            type: input.type,
            payload: (sj.payload ?? {}) as Prisma.InputJsonValue,
            status,
            priority: sj.priority ?? input.priority ?? 5,
            runAt: sj.runAt ?? null,
            attemptCount: 0,
            maxAttempts: sj.maxAttempts ?? baseMax,
            timeoutMs: sj.timeoutMs ?? input.timeoutMs ?? null,
            tags: sj.tags ?? input.tags ?? [],
            metadata: (sj.metadata ?? input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            parentBatchId: batch.id,
            idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}#${i}` : undefined,
          },
        });
      }

      return batch;
    });

    const created = await prisma.job.findMany({
      where: { parentBatchId: result.id },
      select: { id: true, status: true },
    });
    for (const j of created) emitJobUpdate(queueId, j.id, j.status);
    return {
      job: created[0] ?? { id: '', status: 'PENDING' as JobStatus },
      batch: { id: result.id, name: result.name, totalJobs: result.totalJobs },
    };
  }

  // ── Single job path ───────────────────────────────────────────────────────
  const now = new Date();
  const delayed = Boolean(input.runAt && input.runAt > now);
  const status: JobStatus = delayed ? 'SCHEDULED' : 'PENDING';
  const maxAttempts = await resolveMaxAttempts(input.maxAttempts);

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        queueId,
        type: input.type,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        status,
        priority: input.priority ?? 5,
        runAt: input.runAt ?? null,
        attemptCount: 0,
        maxAttempts,
        timeoutMs: input.timeoutMs ?? null,
        tags: input.tags ?? [],
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true, status: true, idempotencyKey: true },
    });

    if (dependencyIds.length) {
      await tx.jobDependency.createMany({
        data: dependencyIds.map((dependencyJobId) => ({
          dependentJobId: created.id,
          dependencyJobId,
        })),
      });
    }

    return created;
  });

  emitJobUpdate(queueId, job.id, job.status);
  logger.debug('Job created', { jobId: job.id, type: input.type, status });
  return { job };
}

/** Re-queue a FAILED/RETRYING/DEAD/CANCELLED job for another run. */
export async function retryJob(jobId: string): Promise<{ id: string; status: JobStatus }> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { dlqEntry: true } });
  if (!job) throw new NotFoundError('Job');
  const activeStatuses: string[] = [JobStatus.PENDING, JobStatus.SCHEDULED, JobStatus.CLAIMED, JobStatus.RUNNING];
  if (activeStatuses.includes(job.status)) {
    throw new BadRequestError(`Job is ${job.status} — only FAILED/DEAD/CANCELLED/RETRYING jobs can be retried`);
  }

  const updated = prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.PENDING,
      attemptCount: 0,
      runAt: null,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      workerId: null,
    },
    select: { id: true, status: true },
  });

  // Remove DLQ entry when retrying a dead letter
  if (job.dlqEntry) {
    await prisma.deadLetterQueue.delete({ where: { jobId } }).catch(() => undefined);
  }

  const result = await updated;
  emitJobUpdate(job.queueId, jobId, result.status);
  return result;
}

export function parsePagination(query: { page?: number | string; limit?: number | string }) {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function slugifyName(name: string): string {
  return slugify(name) || `n-${Date.now()}`;
}
