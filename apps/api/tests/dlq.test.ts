import request from 'supertest';
import { prisma, getApp, registerAndLogin, setupFixture } from './helpers';
import { failJob } from '../src/services/jobLifecycle.service';

describe('Dead Letter Queue', () => {
  let token: string;
  let queueId: string;

  beforeAll(async () => {
    token = (await registerAndLogin()).token;
    ({ queueId } = await setupFixture(token));
  });

  function makeLifecycleJob(overrides: Record<string, unknown> = {}) {
    return {
      id: '',
      queueId,
      type: 'email',
      payload: { to: 'x@example.com' },
      status: 'CLAIMED' as never,
      attemptCount: 0,
      maxAttempts: 2,
      retryPolicyId: null,
      parentBatchId: null,
      timeoutMs: null,
      ...overrides,
    };
  }

  it('moves a job to RETRYING with backoff when attempts remain', async () => {
    const job = await prisma.job.create({
      data: { queueId, type: 'email', payload: { forceFail: true }, maxAttempts: 3 },
    });
    const lifecycle = { ...(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })) };

    const outcome = await failJob(lifecycle as never, new Error('boom'));
    expect(outcome).toBe('RETRYING');

    const updated = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('RETRYING');
    expect(updated.attemptCount).toBe(1);
    expect(updated.runAt).toBeTruthy(); // future retry time set
  });

  it('moves an exhausted job to DEAD and creates the DLQ entry', async () => {
    const job = await prisma.job.create({
      data: { queueId, type: 'email', payload: { forceFail: true }, maxAttempts: 1 },
    });
    const lifecycle = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    const outcome = await failJob(lifecycle as never, new Error('fatal'));
    expect(outcome).toBe('DEAD');

    const updated = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.status).toBe('DEAD');

    const dlq = await prisma.deadLetterQueue.findUnique({ where: { jobId: job.id } });
    expect(dlq).not.toBeNull();
    expect(dlq!.attempts).toBe(1);
    expect(dlq!.lastError).toBe('fatal');
  });

  it('DLQ retry endpoint resets the job and removes the entry', async () => {
    const app = getApp();
    const job = await prisma.job.create({
      data: { queueId, type: 'webhook', payload: {}, maxAttempts: 1, status: 'DEAD', failedAt: new Date() },
    });
    const entry = await prisma.deadLetterQueue.create({
      data: {
        jobId: job.id,
        queueId,
        reason: 'Max attempts exhausted',
        payload: {},
        attempts: 1,
        lastError: 'err',
      },
    });

    const res = await request(app)
      .post(`/api/v1/queues/${queueId}/dlq/${entry.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING');

    const updated = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(updated.attemptCount).toBe(0);
    expect(await prisma.deadLetterQueue.findUnique({ where: { jobId: job.id } })).toBeNull();
  });

  it('resolve marks the entry resolved without requeueing', async () => {
    const app = getApp();
    const job = await prisma.job.create({
      data: { queueId, type: 'webhook', payload: {}, maxAttempts: 1, status: 'DEAD', failedAt: new Date() },
    });
    const entry = await prisma.deadLetterQueue.create({
      data: { jobId: job.id, queueId, reason: 'r', payload: {}, attempts: 1 },
    });

    const res = await request(app)
      .post(`/api/v1/queues/${queueId}/dlq/${entry.id}/resolve`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isResolved).toBe(true);

    // Job stays DEAD
    const stillDead = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stillDead.status).toBe('DEAD');
  });

  it('lists DLQ entries with pagination', async () => {
    const res = await request(getApp())
      .get(`/api/v1/queues/${queueId}/dlq?isResolved=false&page=1&limit=10`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(10);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
