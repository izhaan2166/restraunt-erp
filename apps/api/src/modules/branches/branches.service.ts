import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateBranchDto, UpdateBranchDto, UpdateBranchSettingsDto } from './dto/branch.dto';

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
      // Each branch numbers its invoices with its own prefix (invoice numbers are unique per organization).
      await tx.branchSettings.create({ data: { branchId: branch.id, organizationId: actor.organizationId, invoicePrefix: await freePrefix(tx, actor.organizationId, branch.code) } });
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

  async settings(actor: AuthPrincipal, branchId: string) {
    const branch = await this.get(actor, branchId);
    return (
      branch.settings ??
      this.prisma.branchSettings.create({ data: { branchId, organizationId: actor.organizationId, invoicePrefix: await freePrefix(this.prisma, actor.organizationId, branch.code) } })
    );
  }

  async updateSettings(actor: AuthPrincipal, branchId: string, dto: UpdateBranchSettingsDto, meta: RequestMeta) {
    const before = await this.settings(actor, branchId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.invoicePrefix && dto.invoicePrefix !== before.invoicePrefix) {
        const clash = await tx.branchSettings.findFirst({ where: { organizationId: actor.organizationId, invoicePrefix: dto.invoicePrefix } });
        if (clash) throw Errors.conflict('DUPLICATE_PREFIX', `Another branch already numbers its documents with ${dto.invoicePrefix}`);
      }
      const after = await tx.branchSettings.update({
        where: { branchId },
        data: {
          taxPricingMode: dto.taxPricingMode,
          roundingMode: dto.roundingMode,
          invoicePrefix: dto.invoicePrefix,
          stockDeductionPolicy: dto.stockDeductionPolicy,
          allowNegativeStock: dto.allowNegativeStock,
          cashRequiresShift: dto.cashRequiresShift,
          serviceChargePercent: dto.serviceChargePercent === undefined ? undefined : new Prisma.Decimal(dto.serviceChargePercent),
          maxCashierDiscountPct: dto.maxCashierDiscountPct === undefined ? undefined : new Prisma.Decimal(dto.maxCashierDiscountPct),
        },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action: 'branch.settings_updated', entityType: 'branch_settings', entityId: branchId, before, after, meta },
        tx,
      );
      return after;
    });
  }
}

/**
 * The document prefix a new branch starts with: its code without the characters a prefix may not have
 * (a code such as BLR-HSR becomes BLRHSR), made unique in the organization with a number if needed.
 */
export async function freePrefix(db: Pick<Prisma.TransactionClient, 'branchSettings'>, organizationId: string, code: string) {
  const base = (code.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BR').padEnd(2, '0').slice(0, 10);
  const taken = new Set(
    (await db.branchSettings.findMany({ where: { organizationId, invoicePrefix: { startsWith: base.slice(0, 6) } }, select: { invoicePrefix: true } })).map((s) => s.invoicePrefix),
  );
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : String(n);
    const candidate = base.slice(0, 10 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  throw Errors.conflict('DUPLICATE_PREFIX', 'Could not find a free document prefix for this branch; set one in its settings');
}
