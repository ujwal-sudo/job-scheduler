import { prisma } from './db';
import { logger } from './logger';
import type { JobLogger } from './jobLogger';
import type { ClaimedJob } from './loop';
import { calculateRetryDelay } from './retryDelay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Success completion: job → COMPLETED, batch counters rolled up in one
 * transaction so progress never drifts.
 */
export async function completeJobAndBatch(
  db: typeof prisma,
  jobId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const updated = await tx.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (updated.parentBatchId) {
      const [completedCount, failedCount, batch] = await Promise.all([
        tx.job.count({ where: { parentBatchId: updated.parentBatchId, status: 'COMPLETED' } }),
        tx.job.count({ where: { parentBatchId: updated.parentBatchId, status: 'DEAD' } }),
        tx.batchJob.findUnique({ where: { id: updated.parentBatchId }, select: { totalJobs: true } }),
      ]);
      const allDone = batch ? completedCount + failedCount >= batch.totalJobs : false;
      await tx.batchJob.update({
        where: { id: updated.parentBatchId },
        data: {
          completedJobs: completedCount,
          failedJobs: failedCount,
          ...(allDone
            ? { status: failedCount > 0 ? 'PARTIAL_FAILURE' : 'COMPLETED', completedAt: new Date() }
            : {}),
        },
      });
    }
  });
}

/**
 * Failure handling — retry vs DLQ decision (mirrors the API's lifecycle
 * service; the worker runs it directly against the DB).
 *
 * - attempts remain → RETRYING with runAt = now + policy delay
 * - exhausted → DEAD + DLQ row transactionally
 */
export async function handleFailure(
  job: ClaimedJob,
  error: Error,
  executionId: string | null,
  jobLogger: JobLogger | null,
  isTimeout: boolean,
): Promise<'RETRYING' | 'DEAD'> {
  const nextAttempt = job.attemptCount + 1;
  const startedAt = executionId
    ? await prisma.jobExecution.findUnique({ where: { id: executionId }, select: { startedAt: true } })
    : null;
  const durationMs = startedAt ? Date.now() - startedAt.startedAt.getTime() : null;

  if (executionId) {
    await prisma.jobExecution
      .update({
        where: { id: executionId },
        data: {
          status: isTimeout ? 'TIMEOUT' : 'FAILED',
          completedAt: new Date(),
          error: error.message.slice(0, 2000),
          errorStack: error.stack?.slice(0, 4000),
          ...(durationMs !== null ? { durationMs } : {}),
          memoryUsedMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      })
      .catch(() => undefined);
  }

  await jobLogger?.error(`Execution failed: ${error.message}`);

  if (nextAttempt < job.maxAttempts) {
    let delayMs = 1000 * Math.pow(2, Math.max(0, nextAttempt - 1));
    if (job.retryPolicyId) {
      const policy = await prisma.retryPolicy.findUnique({ where: { id: job.retryPolicyId } });
      if (policy) delayMs = calculateRetryDelay(policy, nextAttempt);
    }
    const runAt = new Date(Date.now() + delayMs);

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'RETRYING',
        attemptCount: nextAttempt,
        runAt,
        failedAt: new Date(),
        workerId: null,
      },
    });
    logger.warn('Job scheduled for retry', {
      jobId: job.id,
      attempt: nextAttempt,
      maxAttempts: job.maxAttempts,
      delayMs,
      error: error.message,
    });
    return 'RETRYING';
  }

  // ── Exhausted → DEAD + DLQ entry atomically ────────────────────────────────
  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: 'DEAD',
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
        payload: (job.payload ?? {}) as object,
        attempts: nextAttempt,
        lastError: error.message.slice(0, 2000),
        lastErrorStack: error.stack?.slice(0, 4000),
      },
      update: {
        attempts: nextAttempt,
        lastError: error.message.slice(0, 2000),
        lastErrorStack: error.stack?.slice(0, 4000),
        isResolved: false,
      },
    });
  });

  if (job.parentBatchId) {
    const failedCount = await prisma.job.count({
      where: { parentBatchId: job.parentBatchId, status: 'DEAD' },
    });
    await prisma.batchJob.update({ where: { id: job.parentBatchId }, data: { failedJobs: failedCount } }).catch(() => undefined);
  }

  logger.error('Job moved to DLQ', { jobId: job.id, error: error.message });
  return 'DEAD';
}
