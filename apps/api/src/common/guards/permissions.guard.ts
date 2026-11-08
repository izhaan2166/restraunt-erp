import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { Errors } from '../errors/app-error';
import {
  AUTHENTICATED_ONLY,
  IS_PUBLIC,
  PermissionRequirement,
  REQUIRED_PERMISSIONS,
} from '../decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthedRequest } from '../../modules/auth/principal';

/**
 * Global, deny-by-default authorization guard. Every non-public route must declare either
 * @RequirePermissions(...) or @AuthenticatedOnly(); anything else is rejected, so a new
 * endpoint can never be accidentally left open.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    if (!user) throw Errors.unauthenticated();

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(REQUIRED_PERMISSIONS, targets);
    const branchId = await this.resolveBranch(req, user.organizationId, requirement?.scope ?? 'auto');
    req.branchId = branchId;

    if (!requirement) {
      if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets)) return true;
      throw Errors.forbidden('ROUTE_NOT_AUTHORIZED', 'This route has no authorization policy');
    }

    if (requirement.scope === 'any') {
      const missingAnywhere = requirement.permissions.filter((p) => {
        const where = user.permissions.branchesWith(p);
        return where !== 'ALL' && where.length === 0;
      });
      if (missingAnywhere.length === 0) return true;
      throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to perform this action', {
        missing: missingAnywhere,
      });
    }

    const missing = user.permissions.missingForGrant(requirement.permissions, branchId);
    if (missing.length > 0) {
      throw Errors.forbidden('MISSING_PERMISSION', 'You do not have permission to perform this action', {
        missing,
        branchId,
      });
    }
    return true;
  }

  private async resolveBranch(
    req: AuthedRequest,
    organizationId: string,
    scope: PermissionRequirement['scope'],
  ): Promise<string | null> {
    if (scope === 'org' || scope === 'any') return null;
    const raw = pickBranchId(req);
    if (raw === undefined) {
      if (scope === 'branch') throw Errors.badRequest('BRANCH_REQUIRED', 'This operation requires a branch');
      return null;
    }
    if (!isUUID(raw)) throw Errors.badRequest('INVALID_BRANCH_ID', 'branchId must be a UUID');
    const branch = await this.prisma.branch.findFirst({
      where: { id: raw, organizationId, deletedAt: null },
      select: { id: true },
    });
    // Same 404 whether the branch does not exist or belongs to another organization.
    if (!branch) throw Errors.notFound('Branch');
    return branch.id;
  }
}

function pickBranchId(req: AuthedRequest): string | undefined {
  const fromParam = req.params?.branchId;
  if (typeof fromParam === 'string') return fromParam;
  const fromQuery = req.query?.branchId;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.branchId === 'string' && body.branchId) return body.branchId;
  const header = req.headers['x-branch-id'];
  if (typeof header === 'string' && header) return header;
  return undefined;
}
