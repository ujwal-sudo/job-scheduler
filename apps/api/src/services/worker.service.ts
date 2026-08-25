import { prisma } from '../db/client';
import { WorkerStatus } from '@prisma/client';
import { emitWorkerPulse } from '../websocket/emitter';
import { NotFoundError } from '../utils/errors';

const DEAD_THRESHOLD_MS = parseInt(process.env.DEAD_WORKER_THRESHOLD_MS ?? '60000', 10);

export async function registerWorker(input: {
  queueId?: string | null;
  hostname: string;
  pid: number;
  version?: string;
  concurrency: number;
  shardKey?: string | null;
  metadata?: unknown;
}) {
  const worker = await prisma.worker.create({
    data: {
      queueId: input.queueId ?? null,
      hostname: input.hostname,
      pid: input.pid,
      version: input.version,
      concurrency: input.concurrency,
      shardKey: input.shardKey ?? null,
      status: 'IDLE',
      metadata: (input.metadata ?? undefined) as never,
    },
  });
  emitWorkerPulse(worker);
  return worker;
}

/**
 * Resolve which queues a worker may claim from, honoring sharding rules:
 * - explicit queueId  → exactly that queue
 * - shardKey set      → queues with the same shard key + unsharded queues
 * - no shardKey       → unsharded queues only (shard queues are exclusive)
 */
export async function resolveEligibleQueueIds(workerId: string): Promise<string[]> {
  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker) throw new NotFoundError('Worker');

  if (worker.queueId) return [worker.queueId];

  const queues = await prisma.queue.findMany({
    where: worker.shardKey ? { OR: [{ shardKey: worker.shardKey }, { shardKey: null }] } : { shardKey: null },
    select: { id: true },
  });
  return queues.map((q) => q.id);
}

export async function heartbeat(
  workerId: string,
  data: {
    status?: WorkerStatus;
    jobsRunning: number;
    jobsDone: number;
    memoryMb?: number | null;
    cpuPercent?: number | null;
  },
) {
  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker || worker.status === 'DEAD') throw new NotFoundError('Active worker');

  const [updated] = await Promise.all([
    prisma.worker.update({
      where: { id: workerId },
      data: {
        lastHeartbeat: new Date(),
        status: data.status === 'ACTIVE' ? 'ACTIVE' : data.status ?? worker.status,
      },
    }),
    prisma.workerHeartbeat.create({
      data: {
        workerId,
        status: data.status ?? 'ACTIVE',
        jobsRunning: data.jobsRunning,
        jobsDone: data.jobsDone,
        memoryMb: data.memoryMb ?? undefined,
        cpuPercent: data.cpuPercent ?? undefined,
      },
    }),
  ]);

  emitWorkerPulse({
    id: updated.id,
    queueId: updated.queueId,
    status: updated.status,
    jobsRunning: data.jobsRunning,
    memoryMb: data.memoryMb,
  });
  return updated;
}

/** Workers whose last heartbeat is older than the threshold are presumed dead. */
export async function findStaleWorkers(): Promise<string[]> {
  const cutoff = new Date(Date.now() - DEAD_THRESHOLD_MS);
  const stale = await prisma.worker.findMany({
    where: { status: { in: ['ACTIVE', 'IDLE'] }, lastHeartbeat: { lt: cutoff } },
    select: { id: true },
  });
  return stale.map((w) => w.id);
}
