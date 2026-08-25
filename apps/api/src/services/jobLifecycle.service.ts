import { JobStatus, Prisma, ExecutionStatus } from '@prisma/client';
import { prisma } from '../db/client';
import { calculateRetryDelay } from '../utils/retryDelay';
import { emitJobUpdate, emitDlqAlert, emitBatchUpdate } from '../websocket/emitter';
import { logger } from '../utils/logger';
import { generateFailureSummary } from './ai.service';

export interface LifecycleJob {
  id: string;
  queueId: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  retryPolicyId: string | null;
  parentBatchId: string | null;
  timeoutMs: number | null;
}

/** Transition CLAIMED → RUNNING and open a JobExecution row for this attempt. */
export async function startExecution(
  job: LifecycleJob,
  workerId: string,
): Promise<{ executionId: string; attemptNumber: number }> {
  const attemptNumber = job.attemptCount + 1;

  const execution = await prisma.jobExecution.create({
    data: {
      jobId: job.id,
      workerId,
      attemptNumber,
      status: ExecutionStatus.RUNNING,
    },
    select: { id: true },
  });

  await prisma.job.update({
    where: { id: job.id },
    data: { status: JobStatus.RUNNING, startedAt: new Date(), workerId },
  });

  emitJobUpdate(job.queueId, job.id, JobStatus.RUNNING);
  return { executionId: execution.id, attemptNumber };
}

/** Mark an execution + its logs complete. */
export async function completeExecution(executionId: string, memoryUsedMb?: number): Promise<void> {
  const exec = await prisma.jobExecution.findUnique({ where: { id: executionId }, select: { startedAt: true } });
  const duration = exec ? Date.now() - exec.startedAt.getTime() : null;
  await prisma.jobExecution.update({
    where: { id: executionId },
    data: {
      status: ExecutionStatus.COMPLETED,
      completedAt: new Date(),
      durationMs: duration ?? undefined,
      memoryUsedMb: memoryUsedMb ?? undefined,
    },
  });
}

export async function failExecution(
  executionId: string,
  error: Error,
  isTimeout = false,
  memoryUsedMb?: number,
): Promise<void> {
  const exec = await prisma.jobExecution.findUnique({ where: { id: executionId }, select: { startedAt: true } });
  const duration = exec ? Date.now() - exec.startedAt.getTime() : null;
  await prisma.jobExecution.update({
    where: { id: executionId },
    data: {
      status: isTimeout ? ExecutionStatus.TIMEOUT : ExecutionStatus.FAILED,
      completedAt: new Date(),
      durationMs: duration ?? undefined,
      error: error.message,
      errorStack: error.stack?.slice(0, 4000),
      memoryUsedMb: memoryUsedMb ?? undefined,
    },
  });
}

/**
 * Successful completion: flip job to COMPLETED and roll up batch progress.
 * Batch counter update happens transactionally with the job write.
 */
export async function completeJob(jobId: string): Promise<void> {
  const job = await prisma.$transaction(async (tx) => {
    const updated = await tx.job.update({
      where: { id: jobId },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
    if (updated.parentBatchId) {
      const completedCount = await tx.job.count({
        where: { parentBatchId: updated.parentBatchId, status: JobStatus.COMPLETED },
      });
      const failedCount = await tx.job.count({
        where: { parentBatchId: updated.parentBatchId, status: JobStatus.DEAD },
      });
      const total = await tx.batchJob.findUnique({
        where: { id: updated.parentBatchId },
        select: { totalJobs: true },
      });
      const allDone = total ? completedCount + failedCount >= total.totalJobs : false;
      await tx.batchJob.update({
        where: { id: updated.parentBatchId },
        data: {
          completedJobs: completedCount,
          failedJobs: failedCount,
          ...(allDone
            ? {
                status: failedCount > 0 ? 'PARTIAL_FAILURE' : 'COMPLETED',
                completedAt: new Date(),
              }
            : {}),
        },
      });
    }
    return updated;
  });

  emitJobUpdate(job.queueId, job.id, JobStatus.COMPLETED);
  if (job.parentBatchId) emitBatchUpdate(job.queueId, job.parentBatchId);
  logger.info('Job completed', { jobId });
}

/**
 * Failure handling — the retry/DLQ decision point.
 *
 * - attempts remain → RETRYING with runAt = now + calculatedDelay
 * - attempts exhausted → DEAD + DeadLetterQueue row (transactional),
 *   AI summary generated async so it can never block DLQ creation.
 */
export async function failJob(job: LifecycleJob, err: Error, isTimeout = false): Promise<'RETRYING' | 'DEAD'> {
  const nextAttempt = job.attemptCount + 1;

  if (nextAttempt < job.maxAttempts) {
    let delayMs = 1000 * Math.pow(2, Math.max(0, nextAttempt - 1)); // default backoff
    if (job.retryPolicyId) {
      const policy = await prisma.retryPolicy.findUnique({ where: { id: job.retryPolicyId } });
      if (policy) delayMs = calculateRetryDelay(policy, nextAttempt);
    }
    const runAt = new Date(Date.now() + delayMs);

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.RETRYING,
        attemptCount: nextAttempt,
        runAt,
        failedAt: new Date(),
        workerId: null,
      },
    });

    emitJobUpdate(job.queueId, job.id, JobStatus.RETRYING);
    logger.warn('Job scheduled for retry', {
      jobId: job.id,
      attempt: nextAttempt,
      maxAttempts: job.maxAttempts,
      delayMs,
      error: err.message,
    });
    return 'RETRYING';
  }

  // ── Attempts exhausted → DEAD + DLQ entry in one transaction ──────────────
  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.DEAD,
        attemptCount: nextAttempt,
        failedAt: new Date(),
        workerId: null,
      },
    });
    await tx.deadLetterQueue.upsert({
      where: { jobId: job.id },
      create: {
        jobId: job.id,
        queueId: job.queueId,
        reason: isTimeout ? 'Job timed out after max attempts' : 'Max attempts exhausted',
        payload: (job.payload ?? {}) as Prisma.InputJsonValue,
        attempts: nextAttempt,
        lastError: err.message.slice(0, 2000),
        lastErrorStack: err.stack?.slice(0, 4000),
      },
      update: {
        attempts: nextAttempt,
        lastError: err.message.slice(0, 2000),
        lastErrorStack: err.stack?.slice(0, 4000),
        isResolved: false,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
    if (job.parentBatchId) {
      const failedCount = await tx.job.count({
        where: { parentBatchId: job.parentBatchId, status: JobStatus.DEAD },
      });
      await tx.batchJob.update({
        where: { id: job.parentBatchId },
        data: { failedJobs: failedCount },
      }).catch(() => undefined);
    }
  });

  emitJobUpdate(job.queueId, job.id, JobStatus.DEAD);
  emitDlqAlert(job.queueId, job.id);
  if (job.parentBatchId) emitBatchUpdate(job.queueId, job.parentBatchId);
  logger.error('Job moved to DLQ', { jobId: job.id, error: err.message });

  // Async, non-blocking AI summary — DLQ entry already exists regardless.
  setImmediate(() => {
    generateFailureSummary(job.id, err).catch((e) =>
      logger.debug('AI summary skipped/failed', { jobId: job.id, message: (e as Error).message }),
    );
  });

  return 'DEAD';
}
