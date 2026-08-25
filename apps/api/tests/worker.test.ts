import request from 'supertest';
import { prisma, getApp, registerAndLogin, setupFixture } from './helpers';

describe('Workers & heartbeats', () => {
  let token: string;
  let queueId: string;

  beforeAll(async () => {
    token = (await registerAndLogin()).token;
    ({ queueId } = await setupFixture(token));
  });

  it('registers via internal token and rejects bad tokens', async () => {
    const app = getApp();
    const bad = await request(app)
      .post('/api/v1/workers/register')
      .set('x-worker-token', 'wrong-token')
      .send({ hostname: 'h', pid: 1 });
    expect(bad.status).toBe(401);

    const res = await request(app)
      .post('/api/v1/workers/register')
      .set('x-worker-token', process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token')
      .send({ hostname: 'test-host', pid: process.pid, concurrency: 3 });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
  });

  it('accepts heartbeats and persists them', async () => {
    const app = getApp();
    const reg = await request(app)
      .post('/api/v1/workers/register')
      .set('x-worker-token', process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token')
      .send({ hostname: 'hb-host', pid: 4242 });
    const workerId = reg.body.data.id;

    const res = await request(app)
      .post(`/api/v1/workers/${workerId}/heartbeat`)
      .set('x-worker-token', process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token')
      .send({ status: 'ACTIVE', jobsRunning: 2, jobsDone: 10, memoryMb: 120.5 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');

    const beats = await prisma.workerHeartbeat.findMany({ where: { workerId } });
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0].jobsDone).toBe(10);
  });

  it('lists workers on the dashboard endpoint (JWT)', async () => {
    const res = await request(getApp())
      .get('/api/v1/workers')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('dead reaper marks stale workers DEAD and recovers their jobs', async () => {
    // Register a worker then backdate its heartbeat beyond the threshold
    const reg = await request(getApp())
      .post('/api/v1/workers/register')
      .set('x-worker-token', process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token')
      .send({ hostname: 'doomed-host', pid: 999 });
    const workerId = reg.body.data.id;

    const job = await prisma.job.create({
      data: { queueId, type: 'report', payload: {}, status: 'RUNNING', workerId },
    });

    await prisma.worker.update({
      where: { id: workerId },
      data: { lastHeartbeat: new Date(Date.now() - 120_000) }, // silent for 2 min
    });

    const { reapDeadWorkers } = await import('../src/scheduler/deadReaper');
    const result = await reapDeadWorkers();

    expect(result.deadWorkers).toBeGreaterThanOrEqual(1);

    const deadWorker = await prisma.worker.findUniqueOrThrow({ where: { id: workerId } });
    expect(deadWorker.status).toBe('DEAD');

    const recovered = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(recovered.status).toBe('PENDING'); // requeued — no work lost
    expect(recovered.workerId).toBeNull();
  });

  it('drain puts the worker into DRAINING mode', async () => {
    const reg = await request(getApp())
      .post('/api/v1/workers/register')
      .set('x-worker-token', process.env.WORKER_INTERNAL_TOKEN ?? 'dev-worker-token')
      .send({ hostname: 'drain-host', pid: 555 });
    const workerId = reg.body.data.id;

    const res = await request(getApp())
      .post(`/api/v1/workers/${workerId}/drain`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DRAINING');
  });

  it('sharding: resolveEligibleQueueIds honors shard keys', async () => {
    const project = await prisma.queue.findUniqueOrThrow({ where: { id: queueId } }).then((q) =>
      prisma.project.findUniqueOrThrow({ where: { id: q.projectId } }),
    );

    const usQueue = await prisma.queue.create({
      data: { projectId: project.id, name: `us-${Date.now()}`, slug: `us-${Date.now()}`, shardKey: 'us-east' },
    });
    const euQueue = await prisma.queue.create({
      data: { projectId: project.id, name: `eu-${Date.now()}`, slug: `eu-${Date.now()}`, shardKey: 'eu-west' },
    });
    const plainQueue = await prisma.queue.create({
      data: { projectId: project.id, name: `plain-${Date.now()}`, slug: `plain-${Date.now()}` },
    });

    const { resolveEligibleQueueIds } = await import('../src/services/worker.service');

    // Worker dedicated to us-east shard
    const usWorker = await prisma.worker.create({
      data: { hostname: 'us', pid: 1, shardKey: 'us-east' },
    });
    const usEligible = await resolveEligibleQueueIds(usWorker.id);
    expect(usEligible).toContain(usQueue.id);       // matching shard
    expect(usEligible).toContain(plainQueue.id);    // unsharded queues are shared
    expect(usEligible).not.toContain(euQueue.id);   // foreign shard excluded

    // Plain worker only gets unsharded queues
    const plainWorker = await prisma.worker.create({ data: { hostname: 'p', pid: 2 } });
    const plainEligible = await resolveEligibleQueueIds(plainWorker.id);
    expect(plainEligible).toContain(plainQueue.id);
    expect(plainEligible).not.toContain(usQueue.id);
    expect(plainEligible).not.toContain(euQueue.id);
  });
});
