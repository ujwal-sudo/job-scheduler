import { RetryStrategy } from '@prisma/client';

export interface RetryPolicyParams {
  strategy: RetryStrategy | string;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/**
 * Compute the delay before the next retry attempt for a failed job.
 * (Worker-side twin of apps/api/src/utils/retryDelay.ts — the worker runs
 * failure handling directly against the DB, so it needs its own copy.)
 *
 * STRATEGIES
 * ----------
 * FIXED        constant initialDelayMs every attempt.
 * LINEAR       initialDelayMs × attempt → arithmetic ramp (1x, 2x, 3x…).
 * EXPONENTIAL  initialDelayMs × multiplier^(attempt−1) → geometric ramp
 *              (1s, 2s, 4s, 8s…), giving a failing dependency progressively
 *              longer recovery windows.
 *
 * JITTER (+/-10%, exponential only): concurrently failing jobs would all
 * retry at the same instant without it, re-creating the overload spike that
 * caused the failures ("thundering herd"). A random factor in [0.9, 1.1]
 * desynchronizes those retries at negligible per-job cost.
 *
 * The result is always clamped to [0, maxDelayMs] so backoff stays bounded.
 */
export function calculateRetryDelay(policy: RetryPolicyParams, attempt: number): number {
  let delay: number;

  switch (policy.strategy) {
    case 'FIXED':
      delay = policy.initialDelayMs;
      break;
    case 'LINEAR':
      delay = policy.initialDelayMs * attempt;
      break;
    case 'EXPONENTIAL':
    default:
      // attempt is 1-based; exponent (attempt-1) starts the ramp at x1.
      delay = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
      const jitter = delay * 0.1 * (Math.random() * 2 - 1);
      delay = delay + jitter;
      break;
  }

  return Math.max(0, Math.min(Math.floor(delay), policy.maxDelayMs));
}
