import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../utils/errors';
import { hasMinRole, type Role } from '@js/shared';

/**
 * RBAC middleware factory.
 * Resolves `:orgSlug` (or `orgId`) from the route params, loads the caller's
 * membership and enforces a minimum role. VIEWER < MEMBER < ADMIN < OWNER.
 *
 * Usage:
 *   router.delete('/:orgSlug', requireRole('OWNER'), handler)
 *   router.post('/:orgSlug/members', requireRole('ADMIN'), handler)
 */
export function requireRole(minimum: Role) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const slugOrId = req.params.orgSlug ?? req.params.orgId;
      if (!slugOrId) {
        // No org context on this route — nothing to check here.
        return next();
      }

      const org = await prisma.organization.findFirst({
        where: { OR: [{ slug: slugOrId }, { id: slugOrId }] },
        select: { id: true },
      });
      if (!org) throw new NotFoundError('Organization');

      const membership = await prisma.orgMember.findUnique({
        where: { userId_orgId: { userId: req.user.sub, orgId: org.id } },
        select: { role: true },
      });
      if (!membership || !hasMinRole(membership.role as string, minimum)) {
        throw new ForbiddenError(`Requires ${minimum} role`);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
