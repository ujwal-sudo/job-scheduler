import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import {
  createRetryPolicySchema,
  updateRetryPolicySchema,
} from '../../validators/org.validators';

export const retryPoliciesRouter = Router({ mergeParams: true });
retryPoliciesRouter.use(verifyAuth);

async function loadProject(req: Request) {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.params.orgId ?? undefined },
  });
  if (!project) throw new NotFoundError('Project');
  return project;
}

retryPoliciesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createRetryPolicySchema }),
  async (req: Request, res: Response) => {
    await loadProject(req);
    const policy = await prisma.retryPolicy.create({
      data: { ...req.body, projectId: req.params.projectId },
    });
    res.status(201).json({ success: true, data: policy });
  },
);

retryPoliciesRouter.get('/', requireRole('VIEWER'), async (req: Request, res: Response) => {
  await loadProject(req);
  const policies = await prisma.retryPolicy.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: policies });
});

async function loadPolicy(projectId: string, policyId: string) {
  const policy = await prisma.retryPolicy.findFirst({
    where: { id: policyId, projectId },
  });
  if (!policy) throw new NotFoundError('Retry policy');
  return policy;
}

retryPoliciesRouter.get('/:policyId', requireRole('VIEWER'), async (req: Request, res: Response) => {
  await loadProject(req);
  const policy = await loadPolicy(req.params.projectId, req.params.policyId);
  res.json({ success: true, data: policy });
});

retryPoliciesRouter.patch(
  '/:policyId',
  requireRole('ADMIN'),
  validate({ body: updateRetryPolicySchema }),
  async (req: Request, res: Response) => {
    await loadProject(req);
    await loadPolicy(req.params.projectId, req.params.policyId);
    const updated = await prisma.retryPolicy.update({ where: { id: req.params.policyId }, data: req.body });
    res.json({ success: true, data: updated });
  },
);

retryPoliciesRouter.delete('/:policyId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  await loadProject(req);
  await loadPolicy(req.params.projectId, req.params.policyId);
  await prisma.retryPolicy.delete({ where: { id: req.params.policyId } });
  res.json({ success: true, data: { deleted: true } });
});
