import { Prisma } from '@prisma/client';
import { prisma, makeJob } from './helpers';

/**
 * THE critical reliability test.
 *
 * Replicates the exact FOR UPDATE SKIP LOCKED claim query used by workers
 * (src/db/queries/claimJobs.ts) and hammers it with concurrent "workers" to
 * prove no job is ever claimed twice and none are lost.
 */
async function claimOnce(queueId: string, workerId: string, limit: number) {
  return prisma.$transaction(async (tx) => {
    return tx.$queryRaw<unknown[]>`
      WITH eligible AS (
        SELECT j.id
        FROM jobs j
        JOIN queues q ON q.id = j.queue_id
        WHERE j.queue_id IN (${Prisma.join([queueId])})
          AND j.status = 'PENDING'
          AND (j.run_at IS NULL OR j.run_at <= (NOW() AT TIME ZONE 'UTC'))
          AND NOT EXISTS (
            SELECT 1 FROM job_dependencies jd
            JOIN jobs dep ON dep.id = jd.dependency_job_id
            WHERE jd.dependent_job_id = j.id AND dep.status != 'COMPLETED'
          )
          AND q.is_paused = false
        ORDER BY j.priority DESC, j.created_at ASC
        LIMIT ${limit}
        FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE jobs
      SET status = 'CLAIMED', claimed_at = NOW(), worker_id = ${workerId}, updated_at = NOW()
      WHERE id IN (SELECT id FROM eligible)
      RETURNING id
    `;
  }, { timeout: 10_000 });
}

describe('Atomic Job Claiming', () => {
  let queueId: string;

  /** Create a real Worker row (jobs.worker_id has an FK) and return its id. */
  async function makeWorker(name: string): Promise<string> {
    const w = await prisma.worker.create({ data: { hostname: name, pid: 1 } });
    return w.id;
  }

  beforeAll(async () => {
    // Dedicated queue via direct Prisma to avoid API overhead in this test
    const user = await prisma.user.create({
      data: {
        email: `claim-${Date.now()}@test.dev`,
        passwordHash: 'x',
        name: 'Claim',
        orgMembers: {
          create: { role: 'OWNER', org: { create: { name: 'claim-org', slug: `claim-${Date.now()}` } } },
        },
      },
      include: { orgMembers: true },
    });
    const project = await prisma.project.create({
      data: { orgId: user.orgMembers[0].orgId, name: 'p', slug: `p-${Date.now()}` },
    });
    const queue = await prisma.queue.create({
      data: { projectId: project.id, name: 'q', slug: 'q' },
    });
    queueId = queue.id;
  });

  it('never allows two workers to claim the same job (10 racing on 1)', async () => {
    const job = await makeJob(queueId);

    // Real worker rows — the claim UPDATE sets jobs.worker_id (FK to workers)
    const workerIds = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeWorker(`racer-${i}`)),
    );
    const results = await Promise.all(workerIds.map((id) => claimOnce(queueId, id, 1)));

    const totalClaimed = results.flat();
    expect(totalClaimed).toHaveLength(1); // exactly one winner

    // And it is always the same job
    expect(new Set(totalClaimed.map((r) => (r as { id: string }).id))).toEqual(new Set([job.id]));
  });

  it('distributes 20 jobs across 5 concurrent workers without overlap', async () => {
    await prisma.job.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        queueId,
        type: 'report',
        payload: { i },
      })),
    });

    const workerIds = await Promise.all(
      Array.from({ length: 5 }, (_, w) => makeWorker(`dist-${w}`)),
    );
    const results = await Promise.all(workerIds.map((id) => claimOnce(queueId, id, 10)));

    const allIds = results.flat().map((r) => (r as { id: string }).id);
    expect(allIds.length).toBe(20);
    expect(new Set(allIds).size).toBe(20); // zero duplicates across workers
  });

  it('does not claim jobs with incomplete dependencies', async () => {
    const dependency = await makeJob(queueId);
    const dependent = await makeJob(queueId);
    await prisma.jobDependency.create({
      data: { dependentJobId: dependent.id, dependencyJobId: dependency.id },
    });

    const claimed = await claimOnce(queueId, await makeWorker('dep-w1'), 50);
    const claimedIds = new Set(claimed.map((r) => (r as { id: string }).id));

    expect(claimedIds.has(dependent.id)).toBe(false);

    // Complete the dependency → now claimable
    await prisma.job.update({ where: { id: dependency.id }, data: { status: 'COMPLETED' } });
    const claimed2 = await claimOnce(queueId, await makeWorker('dep-w2'), 50);
    const ids2 = new Set(claimed2.map((r) => (r as { id: string }).id));
    expect(ids2.has(dependent.id)).toBe(true);
  });

  it('respects future runAt — delayed jobs stay unclaimed until due', async () => {
    const future = await makeJob(queueId, {
      runAt: new Date(Date.now() + 3_600_000),
    });

    const claimed = await claimOnce(queueId, await makeWorker('future-w'), 50);
    const ids = new Set(claimed.map((r) => (r as { id: string }).id));
    expect(ids.has(future.id)).toBe(false);
  });

  it('skips paused queues entirely', async () => {
    await prisma.queue.update({ where: { id: queueId }, data: { isPaused: true } });
    await makeJob(queueId);

    const claimed = await claimOnce(queueId, await makeWorker('paused-w'), 50);
    expect(claimed).toHaveLength(0);

    await prisma.queue.update({ where: { id: queueId }, data: { isPaused: false } });
  });
});
