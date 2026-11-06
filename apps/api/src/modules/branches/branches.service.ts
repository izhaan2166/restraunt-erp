import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Branches the caller can access: all for organization-wide roles, otherwise assigned ones. */
  list(actor: AuthPrincipal) {
    const ids = actor.permissions.accessibleBranches();
    return this.prisma.branch.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null, ...(ids === 'ALL' ? {} : { id: { in: ids } }) },
      orderBy: { name: 'asc' },
    });
  }

  async get(actor: AuthPrincipal, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId: actor.organizationId, deletedAt: null },
      include: { settings: true },
    });
    if (!branch) throw Errors.notFound('Branch');
    return branch;
  }

  async create(actor: AuthPrincipal, dto: CreateBranchDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.create({ data: { ...dto, organizationId: actor.organizationId } });
      await tx.branchSettings.create({ data: { branchId: branch.id, organizationId: actor.organizationId } });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId: branch.id,
          actorUserId: actor.userId,
          action: 'branch.created',
          entityType: 'branch',
          entityId: branch.id,
          after: branch,
          meta,
        },
        tx,
      );
      return branch;
    });
  }

  async update(actor: AuthPrincipal, branchId: string, dto: UpdateBranchDto, meta: RequestMeta) {
    const before = await this.get(actor, branchId);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.branch.update({ where: { id: branchId }, data: dto });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          branchId,
          actorUserId: actor.userId,
          action: 'branch.updated',
          entityType: 'branch',
          entityId: branchId,
          before: { ...before, settings: undefined },
          after,
          meta,
        },
        tx,
      );
      return after;
    });
  }
}
