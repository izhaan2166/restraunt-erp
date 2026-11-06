import { Injectable } from '@nestjs/common';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { UpdateOrganizationDto } from './dto/organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get(actor: AuthPrincipal) {
    return this.prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
  }

  async update(actor: AuthPrincipal, dto: UpdateOrganizationDto, meta: RequestMeta) {
    const before = await this.get(actor);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.organization.update({ where: { id: actor.organizationId }, data: dto });
      await this.audit.record(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: 'organization.updated',
          entityType: 'organization',
          entityId: actor.organizationId,
          before,
          after,
          meta,
        },
        tx,
      );
      return after;
    });
  }
}
