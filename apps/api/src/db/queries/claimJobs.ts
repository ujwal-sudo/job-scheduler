/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ATOMIC JOB CLAIMING — the most reliability-critical code path in the system.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE PROBLEM
 * -----------
 * N worker processes poll the same queue at the same time. If claiming were
 * done as "SELECT a candidate job" followed by "UPDATE its status", two
 * workers could both SELECT the same PENDING row in the microseconds before
 * either UPDATE lands — both would believe they own it and the job would run
 * twice. That is the classic time-of-check-time-of-use (TOCTOU) race.
 *
 * THE SOLUTION — FOR UPDATE SKIP LOCKED
 * -------------------------------------
 * This module performs selection + ownership flip as ONE statement:
 *
 *   1. The `eligible` CTE walks candidate rows ordered by priority/age.
 *   2. `FOR UPDATE OF j` takes a row-level lock on each candidate it visits.
 *   3. `SKIP LOCKED` means: if another concurrent transaction already holds
 *      the lock on that row (i.e., another worker is claiming it right now),
 *      DON'T WAIT for it — silently skip to the next row instead.
 *
 * Consequences:
 *   • Worker A locks job #1 and claims it. Worker B arrives, tries job #1,
 *     sees the lock, skips it instantly, and claims job #2. Zero waiting,
 *     zero deadlocks, zero duplicate execution — guaranteed by PostgreSQL's
 *     MVCC row locking, not by application-level coordination.
 *   • Because SELECT and UPDATE happen in one statement inside one
 *     transaction (ReadCommitted), no other transaction can observe or
 *     interleave with the intermediate state. A job is either claimed by
 *     exactly one worker or still PENDING.
 *   • `SKIP LOCKED` (rather than plain blocking `FOR UPDATE`) keeps workers
 *     independent: under heavy contention they never queue up behind each
 *     other; they simply diverge onto different jobs.
 *
 * WHY THE DEPENDENCY CHECK LIVES INSIDE THIS QUERY
 * ------------------------------------------------
 * Job dependencies ("don't run me until my parents are COMPLETED") are
 * enforced by the NOT EXISTS subquery against job_dependencies. It MUST be
 * evaluated here rather than as an application-side pre-check because any
 * pre-check races with reality: between "check deps look complete" and
 * "claim", a dependency could be re-queued/fail, letting an invalid job slip
 * through — or vice versa, blocking valid work on stale state. Evaluating
 * the predicate while holding the row lock makes eligibility and claim
 * atomic: whatever passes this filter was true AT THE MOMENT of claiming.
 * (A separate dependency-checker loop exists purely to push WebSocket
 * notifications when blocked jobs become eligible — never for enforcement.)
 *
 * WHY THE UTC CAST IS NECESSARY
 * -----------------------------
 * Prisma maps DateTime columns to PostgreSQL `TIMESTAMP(3)` WITHOUT time
 * zone and always writes JS Dates as UTC wall-clock strings. Comparing such
 * naive values against bare NOW() renders NOW() in the database session's
 * timezone (e.g., Asia/Kolkata = UTC+5:30). On such a host every future-
 * dated job becomes claimable up to 5½ hours early. Casting explicitly —
 * `(NOW() AT TIME ZONE 'UTC')` — compares UTC wall-clock against UTC
 * wall-clock regardless of server/session timezone configuration.
 * (The delayed/retry promoter uses Prisma-side comparisons, which serialize
 * parameters as UTC consistently with storage, so the two paths agree.)
 *
 * SHARDING
 * --------
 * The caller passes only the queue ids this worker may touch (resolved from
 * the worker's shardKey: matching shard queues + unsharded queues; plain
 * workers get unsharded queues only), so sharding needs no extra SQL here —
 * see services/worker.service.ts#resolveEligibleQueueIds.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../client';

export interface ClaimParams {
  queueIds: string[]; // queue(s) this worker may pull from (shard-resolved upstream)
  workerId: string;
  limit: number;
}

/** Raw claim result — snake_case columns straight from RETURNING *. */
export interface RawJobRow {
  id: string;
  queue_id: string;
  type: string;
  payload: unknown;
  status: string;
  priority: number;
  run_at: Date | null;
  claimed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  worker_id: string | null;
  attempt_count: number;
  max_attempts: number;
  retry_policy_id: string | null;
  parent_batch_id: string | null;
  idempotency_key: string | null;
  timeout_ms: number | null;
  metadata: unknown;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Claim up to `limit` jobs for `workerId` from the given queues.
 * Safe under unlimited concurrency — see the block comment above.
 */
export async function claimJobsBatch(
  queueIds: string[],
  workerId: string,
  limit: number,
): Promise<RawJobRow[]> {
  if (queueIds.length === 0) return [];

  // $transaction wraps the statement so FOR UPDATE locks are held until commit.
  // ReadCommitted is sufficient: correctness comes from the row locks, not
  // from a stricter isolation level (which would just add retry pressure).
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<RawJobRow[]>`
        WITH eligible AS (
          SELECT j.id
          FROM jobs j
          JOIN queues q ON q.id = j.queue_id
          WHERE j.queue_id IN (${Prisma.join(queueIds)})
            AND j.status = 'PENDING'
            -- Timezone safety: run_at is stored as naive-UTC TIMESTAMP(3);
            -- compare against UTC wall-clock, not session-local NOW().
            AND (j.run_at IS NULL OR j.run_at <= (NOW() AT TIME ZONE 'UTC'))
            -- Dependency gate, evaluated atomically at claim time (see above):
            -- exclude any job that has even one non-COMPLETED dependency.
            AND NOT EXISTS (
              SELECT 1
              FROM job_dependencies jd
              JOIN jobs dep ON dep.id = jd.dependency_job_id
              WHERE jd.dependent_job_id = j.id
                AND dep.status != 'COMPLETED'
            )
            -- Queue-level kill switch: paused queues hand out nothing.
            AND q.is_paused = false
          ORDER BY j.priority DESC, j.created_at ASC
          LIMIT ${limit}
          -- The heart of atomicity: lock candidates we can take, skip those
          -- another worker is currently claiming. No waits → no deadlocks →
          -- no double execution.
          FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE jobs
        SET
          status     = 'CLAIMED',
          claimed_at = NOW(),
          worker_id  = ${workerId},
          updated_at = NOW()
        WHERE id IN (SELECT id FROM eligible)
        RETURNING *
      `;
      return rows;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
  );
}
