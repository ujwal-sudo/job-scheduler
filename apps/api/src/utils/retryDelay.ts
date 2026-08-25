import type { RetryStrategy } from '@js/shared';

export interface RetryPolicyParams {
  strategy: RetryStrategy | string;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/**
 * Compute the delay before the next retry attempt for a failed job.
 *
 * STRATEGIES
 * ----------
 * FIXED        delay = initialDelayMs (constant)
 *              Use when failures are likely transient and evenly spaced
 *              retries are fine — e.g. a flaky network hop. Predictable,
 *              simple, but can hammer a struggling dependency at a fixed
 *              rhythm.
 *
 * LINEAR       delay = initialDelayMs × attempt
 *              Grows one step per attempt (1s, 2s, 3s…). A middle ground:
 *              gentler than fixed on repeated failure without the aggressive
 *              ramp of exponential.
 *
 * EXPONENTIAL  delay = initialDelayMs × multiplier^(attempt−1)
 *              Classic backoff curve (1s, 2s, 4s, 8s…). Gives a failing
 *              downstream system increasingly long recovery windows, which
 *              is what you want for outages/overload.
 *
 * JITTER (+/-10%)
 * ---------------
 * Applied to the exponential strategy only. Without it, every job that
 * failed at roughly the same moment retries at exactly the same future
 * moment too — synchronized "thundering herd" waves that re-overload whatever
 * just recovered. Multiplying by a random factor in [0.9, 1.1] spreads the
 * retry timestamps apart while barely changing individual delays.
 *
 * CAP
 * ---
 * The result is always clamped to maxDelayMs so backoff cannot grow
 * unbounded (and never negative), regardless of strategy or attempt count.
 */
export function calculateRetryDelay(policy: RetryPolicyParams, attempt: number): number {
  let delay: number;

  switch (policy.strategy) {
    case 'FIXED':
      // Constant spacing — same wait after every failure.
      delay = policy.initialDelayMs;
      break;

    case 'LINEAR':
      // Arithmetic growth: initialDelay × attempt → 1x, 2x, 3x …
      delay = policy.initialDelayMs * attempt;
      break;

    case 'EXPONENTIAL':
    default:
      // Geometric growth: initialDelay × multiplier^(attempt-1) → x1, x2, x4 …
      // attempt is 1-based, so exponent (attempt-1) makes attempt #1 wait
      // exactly initialDelayMs before the ramp begins.
      delay = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
      // ±10% jitter breaks synchronization between concurrently failing jobs,
      // preventing thundering-herd retry waves against a recovering system.
      const jitter = delay * 0.1 * (Math.random() * 2 - 1);
      delay = delay + jitter;
      break;
  }

  // Clamp into [0, maxDelayMs]: never negative, never beyond the configured cap.
  return Math.max(0, Math.min(Math.floor(delay), policy.maxDelayMs));
}
