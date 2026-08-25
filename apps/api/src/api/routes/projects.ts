import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import {
  createProjectSchema,
  updateProjectSchema,
} from '../../validators/org.validators';
import { slugifyName } from '../../services/job.service';

export const projectsRouter = Router({ mergeParams: true });
projectsRouter.use(verifyAuth);

async function loadOrg(req: Request) {
  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug: req.params.orgSlug }, { id: req.params.orgSlug }] },
  });
  if (!org) throw new NotFoundError('Organization');
  return org;
}

projectsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createProjectSchema }),
  async (req: Request, res: Response) => {
    const org = await loadOrg(req);
    const { name, description } = req.body as { name: string; description?: string };
    const base = slugifyName(name);
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const clash = await prisma.project.findUnique({
        where: { orgId_slug: { orgId: org.id, slug } },
      });
      if (!clash) break;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const project = await prisma.project.create({ data: { orgId: org.id, name, slug, description } });
    res.status(201).json({ success: true, data: project });
  },
);

projectsRouter.get('/', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const org = await loadOrg(req);
  const projects = await prisma.project.findMany({
    where: { orgId: org.id },
    include: { _count: { select: { queues: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: projects });
});

async function loadProject(orgId: string, slugOrId: string) {
  const project = await prisma.project.findFirst({
    where: { orgId, OR: [{ slug: slugOrId }, { id: slugOrId }] },
  });
  if (!project) throw new NotFoundError('Project');
  return project;
}

projectsRouter.get('/:projectSlug', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const org = await loadOrg(req);
  const project = await loadProject(org.id, req.params.projectSlug);
  res.json({ success: true, data: project });
});

projectsRouter.patch(
  '/:projectSlug',
  requireRole('ADMIN'),
  validate({ body: updateProjectSchema }),
  async (req: Request, res: Response) => {
    const org = await loadOrg(req);
    const project = await loadProject(org.id, req.params.projectSlug);
    const updated = await prisma.project.update({ where: { id: project.id }, data: req.body });
    res.json({ success: true, data: updated });
  },
);

projectsRouter.delete('/:projectSlug', requireRole('OWNER'), async (req: Request, res: Response) => {
  const org = await loadOrg(req);
  const project = await loadProject(org.id, req.params.projectSlug);
  await prisma.project.delete({ where: { id: project.id } });
  res.json({ success: true, data: { deleted: true } });
});
