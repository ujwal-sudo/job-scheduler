import { prisma } from '../db/client';
import { emitJobUpdate } from '../websocket/emitter';

/**
 * Dependency Checker.
 *
 * Eligibility is enforced atomically inside the claim SQL (NOT EXISTS on
 * incomplete deps), so this loop is purely observational: it emits WS
 * updates when blocked jobs become eligible, keeping the dashboard live.
 */
export async function checkDependencies(): Promise<number> {
  const unblocked = await prisma.job.findMany({
    where: {
      status: 'PENDING',
      dependsOn: { some: {} },
    },
    select: {
      id: true,
      queueId: true,
      dependsOn: { select: { dependencyJob: { select: { status: true } } } },
    },
    take: 200,
  });

  let ready = 0;
  for (const job of unblocked) {
    const allComplete = job.dependsOn.every((d) => d.dependencyJob.status === 'COMPLETED');
    if (allComplete) {
      emitJobUpdate(job.queueId, job.id, 'PENDING');
      ready += 1;
    }
  }
  return ready;
}
