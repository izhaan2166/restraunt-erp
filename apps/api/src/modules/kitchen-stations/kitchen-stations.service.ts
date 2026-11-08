import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { CreateStationDto, UpdateStationDto } from './dto/station.dto';

@Injectable()
export class KitchenStationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthPrincipal, branchId: string) {
    return this.prisma.kitchenStation.findMany({
      where: { organizationId: actor.organizationId, branchId },
      orderBy: { name: 'asc' },
    });
  }

  async create(actor: AuthPrincipal, branchId: string, dto: CreateStationDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.kitchenStation.create({ data: { ...dto, organizationId: actor.organizationId, branchId } });
      await this.audit.record(
        { organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action: 'kitchen_station.created', entityType: 'kitchen_station', entityId: row.id, after: row, meta },
        tx,
      );
      return row;
    });
  }

  async update(actor: AuthPrincipal, branchId: string, id: string, dto: UpdateStationDto, meta: RequestMeta) {
    const before = await this.prisma.kitchenStation.findFirst({ where: { id, branchId, organizationId: actor.organizationId } });
    if (!before) throw Errors.notFound('Kitchen station');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.kitchenStation.update({ where: { id }, data: dto });
      await this.audit.record(
        { organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action: 'kitchen_station.updated', entityType: 'kitchen_station', entityId: id, before, after, meta },
        tx,
      );
      return after;
    });
  }
}
