import { calculateRetryDelay } from '../src/utils/retryDelay';

describe('Retry delay calculation', () => {
  const base = { initialDelayMs: 1000, maxDelayMs: 3_600_000, multiplier: 2 };

  it('FIXED returns the constant delay regardless of attempt', () => {
    expect(calculateRetryDelay({ ...base, strategy: 'FIXED' }, 1)).toBe(1000);
    expect(calculateRetryDelay({ ...base, strategy: 'FIXED' }, 5)).toBe(1000);
  });

  it('LINEAR grows linearly with attempt number', () => {
    expect(calculateRetryDelay({ ...base, strategy: 'LINEAR' }, 1)).toBe(1000);
    expect(calculateRetryDelay({ ...base, strategy: 'LINEAR' }, 2)).toBe(2000);
    expect(calculateRetryDelay({ ...base, strategy: 'LINEAR' }, 4)).toBe(4000);
  });

  it('EXPONENTIAL grows geometrically (within jitter bounds)', () => {
    for (let i = 0; i < 20; i++) {
      const d1 = calculateRetryDelay({ ...base, strategy: 'EXPONENTIAL' }, 1);
      // attempt 1 → 1000ms ±10% jitter
      expect(d1).toBeGreaterThanOrEqual(900);
      expect(d1).toBeLessThanOrEqual(1100);

      const d3 = calculateRetryDelay({ ...base, strategy: 'EXPONENTIAL' }, 3);
      // attempt 3 → 4000ms ±10% jitter
      expect(d3).toBeGreaterThanOrEqual(3600);
      expect(d3).toBeLessThanOrEqual(4400);
    }
  });

  it('caps at maxDelayMs', () => {
    const tiny = { strategy: 'EXPONENTIAL', initialDelayMs: 1000, maxDelayMs: 1500, multiplier: 5 };
    for (let a = 1; a <= 10; a++) {
      expect(calculateRetryDelay(tiny, a)).toBeLessThanOrEqual(1500);
    }
  });

  it('never returns negative delays', () => {
    const weird = { strategy: 'EXPONENTIAL', initialDelayMs: 0, maxDelayMs: 100, multiplier: 2 };
    expect(calculateRetryDelay(weird, 3)).toBeGreaterThanOrEqual(0);
  });
});
