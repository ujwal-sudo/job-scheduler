import { config } from '../config';
import { logger } from '../utils/logger';
import { runCronSweep } from './cronRunner';
import { promoteDelayedJobs } from './delayedPromoter';
import { reapDeadWorkers } from './deadReaper';
import { checkDependencies } from './dependencyChecker';

interface TimerHandle {
  stop: () => void;
}

function every(ms: number, fn: () => Promise<unknown>, name: string): TimerHandle {
  let running = false;
  const id = setInterval(async () => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`Scheduler sweep failed: ${name}`, { message: (err as Error).message });
    } finally {
      running = false;
    }
  }, ms);
  return { stop: () => clearInterval(id) };
}

/** Start all background schedulers. Returns a handle to stop them cleanly. */
export function startSchedulers(): TimerHandle[] {
  const handles = [
    every(config.cronRunnerIntervalMs, runCronSweep, 'cronRunner'),
    every(config.delayedPromoterIntervalMs, promoteDelayedJobs, 'delayedPromoter'),
    every(config.deadReaperIntervalMs, reapDeadWorkers, 'deadReaper'),
    every(config.dependencyCheckerIntervalMs, checkDependencies, 'dependencyChecker'),
  ];
  logger.info('Schedulers started', {
    cronRunner: `${config.cronRunnerIntervalMs}ms`,
    delayedPromoter: `${config.delayedPromoterIntervalMs}ms`,
    deadReaper: `${config.deadReaperIntervalMs}ms`,
    dependencyChecker: `${config.dependencyCheckerIntervalMs}ms`,
  });
  return handles;
}
