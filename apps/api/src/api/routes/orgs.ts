import { Router, Request, Response } from 'express';
import { prisma } from '../../db/client';
import { verifyAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../utils/errors';
import {
  createOrgSchema,
  updateOrgSchema,
  inviteMemberSchema,
  updateMemberSchema,
} from '../../validators/org.validators';
import { slugifyName } from '../../services/job.service';

export const orgsRouter = Router();
orgsRouter.use(verifyAuth);

function orgSelect() {
  return {
    id: true,
    name: true,
    slug: true,
    description: true,
    createdAt: true,
    members: { select: { role: true, joinedAt: true, user: { select: { id: true, name: true, email: true } } } },
    _count: { select: { projects: true } },
  } as const;
}

// Create org — creator automatically becomes OWNER (transactional)
orgsRouter.post('/', async (req: Request, res: Response) => {
  const { name, description } = createOrgSchema.parse(req.body);
  const base = slugifyName(name);

  const org = await prisma.$transaction(async (tx) => {
    let slug = base;
    for (let i = 0; i < 5; i++) {
      const clash = await tx.organization.findUnique({ where: { slug } });
      if (!clash) break;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const created = await tx.organization.create({ data: { name, slug, description } });
    await tx.orgMember.create({
      data: { userId: req.user!.sub, orgId: created.id, role: 'OWNER' },
    });
    return created;
  });

  res.status(201).json({ success: true, data: org });
});

// List my orgs
orgsRouter.get('/', async (req: Request, res: Response) => {
  const memberships = await prisma.orgMember.findMany({
    where: { userId: req.user!.sub },
    include: { org: { include: { _count: { select: { projects: true, members: true } } } } },
    orderBy: { joinedAt: 'asc' },
  });
  res.json({
    success: true,
    data: memberships.map((m) => ({ ...m.org, myRole: m.role })),
  });
});

async function loadOrgWithRole(req: Request, minRoles?: string[]) {
  const slug = req.params.orgSlug;
  const org = await prisma.organization.findFirst({
    where: { OR: [{ slug }, { id: slug }] },
    include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
  });
  if (!org) throw new NotFoundError('Organization');
  return org;
}

orgsRouter.get('/:orgSlug', requireRole('VIEWER'), async (req: Request, res: Response) => {
  const org = await loadOrgWithRole(req);
  res.json({ success: true, data: org });
});

orgsRouter.patch('/:orgSlug', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { name, description } = updateOrgSchema.parse(req.body);
  const existing = await loadOrgWithRole(req);
  const updated = await prisma.organization.update({
    where: { id: existing.id },
    data: { ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}) },
  });
  res.json({ success: true, data: updated });
});

// Delete org — OWNER only
orgsRouter.delete('/:orgSlug', requireRole('OWNER'), async (req: Request, res: Response) => {
  const existing = await loadOrgWithRole(req);
  await prisma.organization.delete({ where: { id: existing.id } });
  res.json({ success: true, data: { deleted: true } });
});

// Invite member by email — ADMIN+
orgsRouter.post('/:orgSlug/members', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { email, role } = inviteMemberSchema.parse(req.body);
  const org = await loadOrgWithRole(req);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new NotFoundError('User with that email');

  const existing = await prisma.orgMember.findUnique({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
  });
  if (existing) throw new BadRequestError('User is already a member of this organization');

  const membership = await prisma.orgMember.create({
    data: { userId: user.id, orgId: org.id, role },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  res.status(201).json({ success: true, data: membership });
});

// Change member role
orgsRouter.patch('/:orgSlug/members/:userId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { role } = updateMemberSchema.parse(req.body);
  const org = await loadOrgWithRole(req);

  // Only owners may grant/modify the OWNER role
  if (role === 'OWNER') {
    const me = await prisma.orgMember.findUnique({
      where: { userId_orgId: { userId: req.user!.sub, orgId: org.id } },
    });
    if (me?.role !== 'OWNER') throw new ForbiddenError('Only an OWNER can assign the OWNER role');
  }

  const membership = await prisma.orgMember.update({
    where: { userId_orgId: { userId: req.params.userId, orgId: org.id } },
    data: { role },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  res.json({ success: true, data: membership });
});

orgsRouter.delete('/:orgSlug/members/:userId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const org = await loadOrgWithRole(req);
  const target = await prisma.orgMember.findUnique({
    where: { userId_orgId: { userId: req.params.userId, orgId: org.id } },
  });
  if (!target) throw new NotFoundError('Membership');
  if (target.role === 'OWNER') throw new ForbiddenError('The organization owner cannot be removed');
  await prisma.orgMember.delete({ where: { id: target.id } });
  res.json({ success: true, data: { removed: true } });
});
