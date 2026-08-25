/**
 * Test bootstrap — shared app + auth helpers.
 * Tests run against the real dev database (PostgreSQL + Redis must be up).
 */
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';
import type { Express } from 'express';

export { prisma };

let app: Express | null = null;

export function getApp(): Express {
  if (!app) app = createApp();
  return app;
}

export async function registerAndLogin(): Promise<{ token: string; userId: string }> {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
  const res = await request(getApp())
    .post('/api/v1/auth/register')
    .send({ email, password: 'testpass123', name: 'Test User' });
  return {
    token: res.body.data.accessToken,
    userId: res.body.data.user.id,
  };
}

/** Create org → project → queue, returning ids. Caller is org OWNER. */
export async function setupFixture(token: string): Promise<{
  orgSlug: string;
  projectId: string;
  queueId: string;
}> {
  const app = getApp();
  const org = await request(app)
    .post('/api/v1/orgs')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Test Org ${Date.now()}` });
  const orgSlug = org.body.data.slug;

  const project = await request(app)
    .post(`/api/v1/orgs/${orgSlug}/projects`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `proj-${Date.now()}` });

  const queue = await request(app)
    .post(`/api/v1/projects/${project.body.data.id}/queues`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'test-queue' });

  return {
    orgSlug,
    projectId: project.body.data.id,
    queueId: queue.body.data.id as string,
  };
}

/** Direct DB helpers for worker-level tests (claiming, retries). */
export async function makeJob(queueId: string, data: Record<string, unknown> = {}) {
  return prisma.job.create({
    data: {
      queueId,
      type: (data.type as string) ?? 'report',
      payload: (data.payload as object) ?? {},
      ...(data as object),
    },
  });
}
