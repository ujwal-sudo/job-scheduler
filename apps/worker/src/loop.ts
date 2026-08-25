import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { config } from './config';
import { logger } from './logger';
import { createJobLogger, type JobLogger } from './jobLogger';
import { getHandler, listHandlers } from './handlers';
import type { HandlerContext } from './handlers';
import { completeJobAndBatch, handleFailure } from './executor';

interface WorkerOptions {
  queueId: string | null;
  shardKey: string | null;
  concurrency: number;
  pollIntervalMs: number;
  hostname: string;
  pid: number;
  version: string;
}

interface ActiveJob {
  promise: Promise<void>;
  abort: AbortController;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_REGISTER_ATTEMPTS = 10;
const REGISTER_BASE_DELAY_MS = 1000;

/**
 * JobWorker — the standalone execution process.
 *
 * Lifecycle: REGISTER → HEARTBEAT → POLL → CLAIM → EXECUTE → COMPLETE/FAIL.
 *
 * - Bounded concurrency: at most `concurrency` jobs in flight; never unbounded
 *   promises. When idle it backs off (pollIntervalMs) to avoid hammering the DB.
 * - Claiming uses the atomic FOR UPDATE SKIP LOCKED query — safe with any
 *   number of concurrent workers.
 * - Timeouts enforced per-job via AbortController + Promise.race.
 * - Graceful shutdown: SIGTERM → status DRAINING (no new claims) → finish
 *   in-flight jobs → deregister. SIGINT twice forces immediate exit.
 */
export class JobWorker {
  private opts: WorkerOptions;
  private workerId: string | null = null;
  private running = false;
  private draining = false;
  private activeJobs = new Map<string, ActiveJob>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobsDoneTotal = 0;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
  }

  // ── Registration ──────────────────────────────────────────────────────────
  async register(): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${config.apiBaseUrl}/workers/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-worker-token': config.workerInternalToken,
          },
          body: JSON.stringify({
            queueId: this.opts.queueId ?? null,
            hostname: this.opts.hostname,
            pid: this.opts.pid,
            version: this.opts.version,
            concurrency: this.opts.concurrency,
            shardKey: this.opts.shardKey ?? null,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`Worker registration failed: ${res.status} ${text}`);
          // Distinguish connection/auth errors from validation errors
          if (res.status === 0) {
            // Connection failure — retry with backoff
            lastError = err;
            const delay = REGISTER_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            logger.warn(`Worker registration attempt ${attempt}/${MAX_REGISTER_ATTEMPTS} failed (connection), retrying in ${delay}ms`, {
              apiUrl: config.apiBaseUrl,
              attempt,
              delay,
            });
            await sleep(delay);
            continue;
          }
          // HTTP error (4xx/5xx) — do not retry validation/auth errors
          throw err;
        }
        const body = (await res.json()) as { data: { id: string } };
        this.workerId = body.data.id;
        logger.info('Worker registered', { workerId: this.workerId });
        return;
      } catch (err) {
        const error = err as Error;
        // Connection failure (fetch network error)
        if (attempt < MAX_REGISTER_ATTEMPTS) {
          lastError = error;
          const delay = REGISTER_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(`Worker registration attempt ${attempt}/${MAX_REGISTER_ATTEMPTS} exception, retrying in ${delay}ms`, {
            apiUrl: config.apiBaseUrl,
            attempt,
            delay,
            error: error.message,
          });
          await sleep(delay);
          continue;
        }
        // Last attempt failed — rethrow
        throw error;
      }
    }
    throw lastError!;
  }

  async deregister(): Promise<void> {
    if (!this.workerId) return;
    try {
      await fetch(`${config.apiBaseUrl}/workers/${this.workerId}/drain`, {
        method: 'POST',
        headers: { 'x-worker-token': config.workerInternalToken },
      }).catch(() => undefined);
      // Mark DEAD via a final "heartbeat" is wrong; simply stop heartbeating —
      // the reaper marks us DEAD and recovers nothing since we finished our jobs.
      await prisma.worker.update({ where: { id: this.workerId }, data: { status: 'DRAINING' } }).catch(() => undefined);
    } finally {
      logger.info('Worker deregistered', { workerId: this.workerId });
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  startHeartbeat(): void {
    const beat = async () => {
      if (!this.workerId || !this.running) return;
      try {
        const res = await fetch(`${config.apiBaseUrl}/workers/${this.workerId}/heartbeat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-worker-token': config.workerInternalToken,
          },
          body: JSON.stringify({
            status: this.draining ? 'DRAINING' : 'ACTIVE',
            jobsRunning: this.activeJobs.size,
            jobsDone: this.jobsDoneTotal,
            memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            cpuPercent: null,
          }),
        });
        if (!res.ok) logger.warn('Heartbeat rejected', { status: res.status });
      } catch (err) {
        logger.warn('Heartbeat failed', { message: (err as Error).message });
      }
    };
    void beat();
    this.heartbeatTimer = setInterval(() => void beat(), config.heartbeatIntervalMs);
  }

  /**
   * Queues this worker may claim from, honoring shard rules:
   * explicit queueId wins; otherwise shardKey selects matching + unsharded
   * queues; plain workers take only unsharded queues.
   */
  async resolveEligibleQueueIds(): Promise<string[]> {
    if (this.opts.queueId) return [this.opts.queueId];
    const queues = await prisma.queue.findMany({
      where: this.opts.shardKey
        ? { OR: [{ shardKey: this.opts.shardKey }, { shardKey: null }] }
        : { shardKey: null },
      select: { id: true },
    });
    return queues.map((q) => q.id);
  }

  /** Atomic claim via the API's raw SQL path — executed directly against DB here. */
  async claimJobs(queueIds: string[], limit: number): Promise<ClaimedJob[]> {
    if (queueIds.length === 0) return [];
    const rows = await prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<ClaimedJob[]>`
        WITH eligible AS (
          SELECT j.id
          FROM jobs j
          JOIN queues q ON q.id = j.queue_id
          WHERE j.queue_id IN (${Prisma.join(queueIds)})
            AND j.status = 'PENDING'
            AND (j.run_at IS NULL OR j.run_at <= (NOW() AT TIME ZONE 'UTC'))
            AND NOT EXISTS (
              SELECT 1
              FROM job_dependencies jd
              JOIN jobs dep ON dep.id = jd.dependency_job_id
              WHERE jd.dependent_job_id = j.id
                AND dep.status != 'COMPLETED'
            )
            AND q.is_paused = false
          ORDER BY j.priority DESC, j.created_at ASC
          LIMIT ${limit}
          FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE jobs
        SET status = 'CLAIMED', claimed_at = NOW(), worker_id = ${this.workerId}, updated_at = NOW()
        WHERE id IN (SELECT id FROM eligible)
        RETURNING id, queue_id AS "queueId", type, payload, attempt_count AS "attemptCount",
                  max_attempts AS "maxAttempts", timeout_ms AS "timeoutMs",
                  retry_policy_id AS "retryPolicyId", parent_batch_id AS "parentBatchId", priority
      `;
      return result;
    }, { timeout: 10_000 });
    return rows;
  }

  async executeJob(job: ClaimedJob): Promise<void> {
    const workerId = this.workerId!;
    const handler = getHandler(job.type);

    let executionId: string | null = null;
    let jobLogger: JobLogger | null = null;

    try {
      // Open execution row + flip CLAIMED → RUNNING
      const attemptNumber = job.attemptCount + 1;
      const execution = await prisma.jobExecution.create({
        data: { jobId: job.id, workerId, attemptNumber, status: 'RUNNING' },
        select: { id: true },
      });
      executionId = execution.id;
      jobLogger = createJobLogger(executionId);

      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'RUNNING', startedAt: new Date(), workerId },
      });

      if (!handler) {
        throw new Error(`No handler registered for job type: ${job.type}`);
      }

      await jobLogger.info(`Execution started (attempt ${attemptNumber})`);

      // Timeout enforcement
      const timeoutMs = job.timeoutMs ?? config.defaultTimeoutMs;
      const abort = new AbortController();
      const ctx: HandlerContext = {
        jobId: job.id,
        executionId,
        attempt: attemptNumber,
        logger: jobLogger,
        signal: abort.signal,
      };

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs);

      try {
        await Promise.race([handler(job.payload, ctx), sleep(timeoutMs + 500)]);
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) throw new Error(`Job timed out after ${timeoutMs}ms`);

      // Success path
      const startedAt = await prisma.jobExecution.findUnique({ where: { id: executionId }, select: { startedAt: true } });
      const durationMs = startedAt ? Date.now() - startedAt.startedAt.getTime() : null;
      await prisma.jobExecution.update({
        where: { id: executionId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          ...(durationMs !== null ? { durationMs } : {}),
          memoryUsedMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      });
      await completeJobAndBatch(prisma, job.id);
      await jobLogger?.info('Execution completed');
      this.jobsDoneTotal += 1;
    } catch (err) {
      const error = err as Error;
      const wasTimeout = error.message?.includes('timed out');
      try {
        await handleFailure(job, error, executionId, jobLogger, wasTimeout);
      } catch (failErr) {
        logger.error('Failure handling itself errored', { jobId: job.id, message: (failErr as Error).message });
      }
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    await this.register();
    this.running = true;
    this.startHeartbeat();
    logger.info('Polling started', {
      queueId: this.opts.queueId ?? '(all eligible)',
      shardKey: this.opts.shardKey ?? '(none)',
      concurrency: this.opts.concurrency,
      handlers: listHandlers(),
    });

    while (this.running) {
      try {
        const available = this.opts.concurrency - this.activeJobs.size;
        if (available > 0 && !this.draining && this.workerId) {
          const queueIds = await this.resolveEligibleQueueIds();
          const claimed = await this.claimJobs(queueIds, available);

          for (const job of claimed) {
            const abort = new AbortController();
            const promise = this.executeJob(job).finally(() => this.activeJobs.delete(job.id));
            this.activeJobs.set(job.id, { promise, abort });
          }
        }

        if (this.activeJobs.size === 0) {
          await sleep(this.draining ? 200 : this.opts.pollIntervalMs);
          if (this.draining && !this.running) break;
        } else {
          await Promise.race([sleep(100), ...[...this.activeJobs.values()].map((a) => a.promise)]);
        }
      } catch (err) {
        logger.error('Poll loop error', { message: (err as Error).message });
        await sleep(1000);
      }
    }

    // Graceful drain: wait for all in-flight work
    logger.info('Draining… waiting for in-flight jobs', { count: this.activeJobs.size });
    while (this.activeJobs.size > 0) {
      await Promise.allSettled([...this.activeJobs.values()].map((a) => a.promise));
    }
    await this.deregister();
    await prisma.$disconnect();
    logger.info('Worker stopped cleanly');
  }

  requestShutdown(force = false): void {
    this.draining = true;
    if (force || this.activeJobs.size === 0) this.running = false;
    else logger.info('SIGTERM — finishing current jobs before exit (send again to force)');
  }

  get stats() {
    return { workerId: this.workerId, active: this.activeJobs.size, done: this.jobsDoneTotal };
  }
}

export interface ClaimedJob {
  id: string;
  queueId: string;
  type: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  timeoutMs: number | null;
  retryPolicyId: string | null;
  parentBatchId: string | null;
  priority: number;
}
