import { prisma } from '../db/client';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { emitJobUpdate } from '../websocket/emitter';

export async function retryDlqEntry(entryId: string, resolvedBy?: string) {
  const entry = await prisma.deadLetterQueue.findUnique({ where: { id: entryId }, include: { job: true } });
  if (!entry) throw new NotFoundError('DLQ entry');

  // Reset the job fully and requeue; DLQ row removed so it can re-enter cleanly.
  const [job] = await prisma.$transaction([
    prisma.job.update({
      where: { id: entry.jobId },
      data: {
        status: 'PENDING',
        attemptCount: 0,
        runAt: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        workerId: null,
      },
    }),
    prisma.deadLetterQueue.delete({ where: { id: entryId } }),
  ]);

  emitJobUpdate(job.queueId, job.id, 'PENDING');
  return { id: job.id, status: job.status };
}

export async function resolveDlqEntry(entryId: string, resolvedBy?: string) {
  const entry = await prisma.deadLetterQueue.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('DLQ entry');

  const updated = await prisma.deadLetterQueue.update({
    where: { id: entryId },
    data: { isResolved: true, resolvedAt: new Date(), resolvedBy },
  });
  return updated;
}
