import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateTaxRateDto, UpdateTaxRateDto } from './dto/tax-rate.dto';

@Injectable()
export class TaxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthPrincipal, includeInactive = false) {
    return this.prisma.taxRate.findMany({
      where: { organizationId: actor.organizationId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ rate: 'asc' }, { name: 'asc' }],
    });
  }

  async get(actor: AuthPrincipal, id: string) {
    const rate = await this.prisma.taxRate.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!rate) throw Errors.notFound('Tax rate');
    return rate;
  }

  async create(actor: AuthPrincipal, dto: CreateTaxRateDto, meta: RequestMeta) {
    const rate = new Prisma.Decimal(dto.rate);
    const half = rate.div(2);
    if (half.decimalPlaces() > 3) throw Errors.badRequest('INVALID_TAX_RATE', 'Rate must split evenly into CGST and SGST');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.taxRate.create({
        data: {
          organizationId: actor.organizationId,
          name: dto.name,
          rate,
          cgstRate: half,
          sgstRate: half,
          igstRate: rate,
          cessRate: dto.cessRate ?? '0',
          ...(dto.effectiveFrom ? { effectiveFrom: new Date(dto.effectiveFrom) } : {}),
        },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'tax_rate.created', entityType: 'tax_rate', entityId: row.id, after: row, meta },
        tx,
      );
      return row;
    });
  }

  async update(actor: AuthPrincipal, id: string, dto: UpdateTaxRateDto, meta: RequestMeta) {
    const before = await this.get(actor, id);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.taxRate.update({
        where: { id },
        data: { name: dto.name, isActive: dto.isActive, ...(dto.effectiveTo ? { effectiveTo: new Date(dto.effectiveTo) } : {}) },
      });
      await this.audit.record(
        { organizationId: actor.organizationId, actorUserId: actor.userId, action: 'tax_rate.updated', entityType: 'tax_rate', entityId: id, before, after, meta },
        tx,
      );
      return after;
    });
  }
}
