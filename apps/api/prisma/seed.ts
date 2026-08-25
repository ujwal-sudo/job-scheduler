/**
 * Seed data — makes the dashboard immediately demonstrable.
 *
 * Creates: demo user (owner), org, project, retry policies, queues
 * (incl. sharded + rate-limited), example jobs in various states,
 * a cron schedule, an event trigger, and a DLQ sample job.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding…');

  const passwordHash = await bcrypt.hash('demo1234', 10);
  const user = await prisma.user.upsert({
    where: { email: 'demo@jobscheduler.dev' },
    update: {},
    create: { email: 'demo@jobscheduler.dev', name: 'Demo User', passwordHash },
  });

  const org = await prisma.organization.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { name: 'Acme Corp', slug: 'acme', description: 'Demo organization' },
  });

  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    update: { role: 'OWNER' },
    create: { userId: user.id, orgId: org.id, role: 'OWNER' },
  });

  // Second member for RBAC demos
  const viewer = await prisma.user.upsert({
    where: { email: 'viewer@jobscheduler.dev' },
    update: {},
    create: {
      email: 'viewer@jobscheduler.dev',
      name: 'View Only',
      passwordHash: await bcrypt.hash('demo1234', 10),
    },
  });
  await prisma.orgMember.upsert({
    where: { userId_orgId: { userId: viewer.id, orgId: org.id } },
    update: { role: 'VIEWER' },
    create: { userId: viewer.id, orgId: org.id, role: 'VIEWER' },
  });

  const project = await prisma.project.upsert({
    where: { orgId_slug: { orgId: org.id, slug: 'platform' } },
    update: {},
    create: { orgId: org.id, name: 'Platform Jobs', slug: 'platform', description: 'Core platform background jobs' },
  });

  const aggressivePolicy = await prisma.retryPolicy.upsert({
    where: { id: 'seed-policy-aggressive' },
    update: {},
    create: {
      id: 'seed-policy-aggressive',
      projectId: project.id,
      name: 'Aggressive Retry',
      strategy: 'EXPONENTIAL',
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      multiplier: 2,
    },
  }).catch(async () => {
    const existing = await prisma.retryPolicy.findFirstOrThrow({ where: { projectId: project.id, name: 'Aggressive Retry' } });
    return existing;
  });

  const fixedPolicy = await prisma.retryPolicy.create({
    data: {
      projectId: project.id,
      name: 'Fixed 3x',
      strategy: 'FIXED',
      maxAttempts: 3,
      initialDelayMs: 5000,
      maxDelayMs: 5000,
      multiplier: 1,
    },
  });

  const defaultQueue = await prisma.queue.upsert({
    where: { projectId_slug: { projectId: project.id, slug: 'default' } },
    update: {},
    create: {
      projectId: project.id,
      name: 'Default',
      slug: 'default',
      description: 'General purpose queue',
      priority: 5,
      concurrencyLimit: 10,
      retryPolicyId: aggressivePolicy.id,
    },
  });

  const emailsQueue = await prisma.queue.upsert({
    where: { projectId_slug: { projectId: project.id, slug: 'emails' } },
    update: {},
    create: {
      projectId: project.id,
      name: 'Emails',
      slug: 'emails',
      description: 'Outbound email delivery',
      priority: 8,
      concurrencyLimit: 20,
      rateLimitPerMin: 60,
      retryPolicyId: fixedPolicy.id,
    },
  });

  const usEastQueue = await prisma.queue.upsert({
    where: { projectId_slug: { projectId: project.id, slug: 'us-east-analytics' } },
    update: {},
    create: {
      projectId: project.id,
      name: 'US-East Analytics',
      slug: 'us-east-analytics',
      description: 'Sharded to US-East workers',
      priority: 6,
      concurrencyLimit: 10,
      shardKey: 'us-east',
    },
  });

  // ── Example jobs ────────────────────────────────────────────────────────────
  const existingJobs = await prisma.job.count({ where: { queueId: defaultQueue.id } });
  if (existingJobs === 0) {
    await prisma.job.createMany({
      data: [
        {
          queueId: defaultQueue.id,
          type: 'report',
          payload: { name: 'nightly-usage', rows: 4200 },
          status: 'COMPLETED',
          priority: 7,
          completedAt: new Date(),
          startedAt: new Date(Date.now() - 4000),
        },
        {
          queueId: defaultQueue.id,
          type: 'email',
          payload: { to: 'team@example.com', subject: 'Weekly digest' },
          status: 'PENDING',
          priority: 6,
        },
        {
          queueId: defaultQueue.id,
          type: 'webhook',
          payload: { url: 'https://hooks.example.com/sync' },
          status: 'SCHEDULED',
          runAt: new Date(Date.now() + 60_000),
        },
        {
          queueId: emailsQueue.id,
          type: 'email',
          payload: { to: 'user@example.com', subject: 'Welcome!', forceFail: true },
          status: 'DEAD',
          attemptCount: 3,
          maxAttempts: 3,
          failedAt: new Date(),
        },
      ],
    });

    const deadJob = await prisma.job.findFirstOrThrow({
      where: { queueId: emailsQueue.id, status: 'DEAD' },
    });
    await prisma.jobExecution.createMany({
      data: [1, 2, 3].map((attempt) => ({
        jobId: deadJob.id,
        attemptNumber: attempt,
        status: 'FAILED' as const,
        completedAt: new Date(),
        durationMs: 350,
        error: 'Simulated email delivery failure',
      })),
    });
    await prisma.deadLetterQueue.create({
      data: {
        jobId: deadJob.id,
        queueId: emailsQueue.id,
        reason: 'Max attempts exhausted',
        payload: deadJob.payload as object,
        attempts: 3,
        lastError: 'Simulated email delivery failure',
      },
    });

    // Batch
    const batch = await prisma.batchJob.create({
      data: { queueId: defaultQueue.id, name: 'seed-batch-demo', totalJobs: 3, status: 'RUNNING' },
    });
    await prisma.job.createMany({
      data: [1, 2, 3].map((i) => ({
        queueId: defaultQueue.id,
        type: 'report',
        payload: { name: `batch-report-${i}` },
        parentBatchId: batch.id,
        status: i === 1 ? 'COMPLETED' : 'PENDING',
        ...(i === 1 ? { completedAt: new Date(), startedAt: new Date(Date.now() - 2000) } : {}),
      })),
    });
  }

  // ── Cron schedule ───────────────────────────────────────────────────────────
  const schedules = await prisma.scheduledJob.count({ where: { queueId: defaultQueue.id } });
  if (schedules === 0) {
    const { getNextCronDate } = await import('../src/scheduler/cronRunner');
    const next = getNextCronDate('* * * * *') ?? new Date(Date.now() + 60_000);
    await prisma.scheduledJob.create({
      data: {
        queueId: defaultQueue.id,
        name: 'Every minute heartbeat',
        cronExpression: '* * * * *',
        jobType: 'report',
        jobPayload: { name: 'heartbeat' },
        nextRunAt: next,
      },
    });
  }

  // ── Event trigger ───────────────────────────────────────────────────────────
  await prisma.eventTrigger.upsert({
    where: { id: 'seed-trigger-user-signed-up' },
    update: {},
    create: {
      id: 'seed-trigger-user-signed-up',
      queueId: emailsQueue.id,
      eventName: 'user.signed_up',
      jobType: 'email',
      jobPayloadTmpl: {
        to: '{{event.email}}',
        subject: 'Welcome to Acme, {{event.name}}!',
      },
    },
  }).catch(async () => {
    const t = await prisma.eventTrigger.findFirst({ where: { eventName: 'user.signed_up' } });
    return t;
  });

  console.log('Seed complete.');
  console.log('  Login: demo@jobscheduler.dev / demo1234  (OWNER)');
  console.log('  Login: viewer@jobscheduler.dev / demo1234  (VIEWER)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
